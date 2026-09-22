import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ kind: "error"; error: Error } |
 *   { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } |
 *   { kind: "shutdown"; signal: NodeJS.Signals }} ProcessOutcome
 */
/** @typedef {{ command: string; pid: number; ppid: number; started: string }} ProcessEntry */

const E2E_ADMIN_PASSWORD = "rt22-e2e-only-password";
const SERVER_CONTROL_MESSAGE = "rt22-e2e-shutdown";
const SERVER_CLEANUP_MESSAGE = "rt22-e2e-cleanup-complete";
const E2E_PORT = "4173";
const TEMPORARY_DIRECTORY_PREFIX = "rt22-vouchers-e2e-";
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCED_SHUTDOWN_TIMEOUT_MS = 3_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtConfig = join(repositoryRoot, "dist", "qr_code_scanner", "wrangler.json");
const temporaryParent = resolve(process.env.RT22_E2E_TMP_PARENT ?? tmpdir());
const temporaryRoot = mkdtempSync(join(temporaryParent, TEMPORARY_DIRECTORY_PREFIX));
const persistenceDirectory = join(temporaryRoot, "wrangler-state");
const environmentFile = join(temporaryRoot, "e2e.env");
const e2eEnvironment = {
  ...process.env,
  ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  WRANGLER_WRITE_LOGS: "false",
};

/** @type {import("node:child_process").ChildProcess | null} */
let activeProcess = null;
/** @type {import("node:child_process").ChildProcess | null} */
let groupSentinel = null;
let allProcessTreesStopped = true;
let parentDisconnected = false;
let processTableUnavailable = false;
/** @type {NodeJS.Signals | null} */
let requestedSignal = null;
/** @type {number | null} */
let childFinishedAt = null;
/** @type {(signal: NodeJS.Signals) => void} */
let resolveShutdownRequest;
/** @type {Promise<NodeJS.Signals>} */
const shutdownRequest = new Promise((resolveRequest) => {
  resolveShutdownRequest = resolveRequest;
});

/** @type {Map<NodeJS.Signals, () => void>} */
const signalHandlers = new Map();
/** @type {NodeJS.Signals[]} */
const handledSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of handledSignals) {
  const handler = () => requestShutdown(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

/** @param {unknown} message */
const handleControlMessage = (message) => {
  if (message === SERVER_CONTROL_MESSAGE) {
    requestShutdown("SIGTERM");
  }
};
const handleControlDisconnect = () => {
  parentDisconnected = true;
  requestShutdown("SIGTERM");
};
if (process.channel !== undefined) {
  process.on("message", handleControlMessage);
  process.on("disconnect", handleControlDisconnect);
}

process.exitCode = await main();

async function main() {
  /** @type {number | undefined} */
  let exitCode;

  try {
    mkdirSync(persistenceDirectory, { recursive: true });
    writeFileSync(environmentFile, `ADMIN_PASSWORD=${E2E_ADMIN_PASSWORD}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    groupSentinel = startGroupSentinel();
    await waitForEarlyCrashGate();

    exitCode = await runLifecycle();
  } catch (error) {
    console.error(
      "The isolated E2E server failed:",
      error instanceof Error ? error.message : String(error),
    );
    exitCode = 1;
  } finally {
    if (activeProcess !== null) {
      allProcessTreesStopped = (await stopProcessTree(activeProcess)) && allProcessTreesStopped;
      activeProcess = null;
    }
    if (
      groupSentinel !== null &&
      (process.env.RT22_E2E_SERVER_GROUP_OWNER !== "runner" || parentDisconnected)
    ) {
      allProcessTreesStopped = (await stopProcessTree(groupSentinel)) && allProcessTreesStopped;
      groupSentinel = null;
    }

    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    if (allProcessTreesStopped) {
      removeOwnedTemporaryRoot();
      await acknowledgeCleanup();
    } else {
      console.error(
        `Refusing to remove E2E state while an owned process tree may still be running: ${temporaryRoot}`,
      );
      exitCode = 1;
    }

    process.removeListener("message", handleControlMessage);
    process.removeListener("disconnect", handleControlDisconnect);
    if (process.connected) {
      process.disconnect();
    }
  }

  return exitCode ?? 1;
}

async function waitForEarlyCrashGate() {
  const gateDirectory = process.env.RT22_E2E_EARLY_CRASH_GATE;
  if (gateDirectory === undefined) {
    return;
  }

  writeFileSync(join(gateDirectory, "server-ready"), "ready\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const releaseFile = join(gateDirectory, "release");
  while (!existsSync(releaseFile)) {
    await delay(20);
  }
}

function startGroupSentinel() {
  const token = process.env.RT22_E2E_SERVER_GROUP_TOKEN;
  if (token === undefined) {
    return null;
  }

  const sentinelScript = [
    "process.on('SIGHUP', () => {});",
    "setInterval(() => {}, 1000);",
  ].join(" ");

  const sentinel = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      sentinelScript,
      "--",
      `rt22-e2e-sentinel:${token}`,
    ],
    {
      cwd: repositoryRoot,
      env: e2eEnvironment,
      stdio: "ignore",
    },
  );
  if (process.env.RT22_E2E_SERVER_GROUP_OWNER === "runner") {
    sentinel.unref();
  }
  return sentinel;
}

/** @param {NodeJS.Signals} signal */
function requestShutdown(signal) {
  if (requestedSignal === null) {
    requestedSignal = signal;
    resolveShutdownRequest(signal);
  }
}

async function acknowledgeCleanup() {
  if (process.send === undefined || !process.connected) {
    return;
  }

  await new Promise((resolveAcknowledgement) => {
    try {
      process.send?.(SERVER_CLEANUP_MESSAGE, () => resolveAcknowledgement(undefined));
    } catch {
      resolveAcknowledgement(undefined);
    }
  });
}

async function runLifecycle() {
  const build = await runManagedProcess("npm", ["run", "build"], {
    ...e2eEnvironment,
    CI: "true",
  });
  if (build.kind === "shutdown") {
    return 0;
  }
  if (build.kind === "error") {
    console.error("Unable to build the isolated E2E application:", build.error.message);
    return 1;
  }
  if (build.code !== 0) {
    return build.code ?? 1;
  }

  const migration = await runManagedProcess(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      persistenceDirectory,
      "--config",
      builtConfig,
      "--env-file",
      environmentFile,
    ],
    { ...e2eEnvironment, CI: "true" },
  );
  if (migration.kind === "shutdown") {
    return 0;
  }
  if (migration.kind === "error") {
    console.error("Unable to migrate the isolated E2E database:", migration.error.message);
    return 1;
  }
  if (migration.code !== 0) {
    return migration.code ?? 1;
  }

  const worker = await runManagedProcess(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      E2E_PORT,
      "--persist-to",
      persistenceDirectory,
      "--config",
      builtConfig,
      "--env-file",
      environmentFile,
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    e2eEnvironment,
  );

  if (worker.kind === "shutdown") {
    return 0;
  }
  if (worker.kind === "error") {
    console.error("Unable to start the isolated E2E Worker:", worker.error.message);
    return 1;
  }
  if (worker.signal !== null) {
    console.error(`The isolated E2E Worker stopped unexpectedly (${worker.signal}).`);
  } else {
    console.error(`The isolated E2E Worker stopped unexpectedly (exit ${worker.code ?? 1}).`);
  }
  return 1;
}

/**
 * @param {string} command
 * @param {string[]} arguments_
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Promise<ProcessOutcome>}
 */
async function runManagedProcess(command, arguments_, environment) {
  if (requestedSignal !== null) {
    return { kind: "shutdown", signal: requestedSignal };
  }

  const child = spawn(executable(command), arguments_, {
    cwd: repositoryRoot,
    detached: false,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });
  activeProcess = child;
  const processTracker = startProcessTreeTracker(child);
  const runtimeMonitor =
    arguments_.includes("dev") && arguments_.includes("wrangler")
      ? startWorkerRuntimeMonitor(child)
      : null;
  const earlyCrashChildMarker = process.env.RT22_E2E_EARLY_CRASH_CHILD_MARKER;
  if (earlyCrashChildMarker !== undefined && child.pid !== undefined) {
    writeFileSync(earlyCrashChildMarker, `${child.pid}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /** @type {Promise<ProcessOutcome>} */
  const childOutcome = new Promise((resolveOutcome) => {
    child.once("error", (error) => {
      childFinishedAt = Date.now();
      resolveOutcome({ kind: "error", error });
    });
    child.once("exit", (code, signal) => {
      childFinishedAt = Date.now();
      resolveOutcome({ kind: "exit", code, signal });
    });
  });
  const shutdownOutcome = shutdownRequest.then(
    (signal) => /** @type {ProcessOutcome} */ ({ kind: "shutdown", signal }),
  );
  const outcome = await Promise.race([childOutcome, shutdownOutcome]);
  if (
    outcome.kind === "shutdown" &&
    process.env.RT22_E2E_ENABLE_CRASH_PROBE === "1" &&
    child.pid !== undefined
  ) {
    signalProcessTree(child.pid, "SIGKILL");
  }

  let processTreeTerminationRequested = false;
  /** @type {number | null} */
  let processTreeTerminationRequestedAt = null;
  let processTreeStopped;
  try {
    processTreeStopped = await stopProcessTree(
      child,
      () => {
        processTreeTerminationRequested = true;
        processTreeTerminationRequestedAt = Date.now();
      },
      processTracker.entries,
    );
  } finally {
    processTracker.stop();
    runtimeMonitor?.stop();
  }
  allProcessTreesStopped = processTreeStopped && allProcessTreesStopped;
  activeProcess = null;
  if (!processTreeStopped) {
    return {
      kind: "error",
      error: new Error(`The complete process tree for ${command} did not stop within the deadline.`),
    };
  }
  if (runtimeMonitor?.crashed) {
    return {
      kind: "error",
      error: new Error("The isolated E2E Worker runtime crashed before shutdown."),
    };
  }
  if (outcome.kind === "shutdown") {
    const finalChildOutcome = await childOutcome;
    if (
      !isExpectedShutdownOutcome(
        finalChildOutcome,
        processTreeTerminationRequested,
        childFinishedAt,
        processTreeTerminationRequestedAt,
      )
    ) {
      return finalChildOutcome;
    }
  }
  return outcome;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {{ crashed: boolean; stop: () => void }}
 */
function startWorkerRuntimeMonitor(child) {
  const monitor = { crashed: false, stop: () => {} };
  /** @type {ProcessEntry[]} */
  let observedRuntimes = [];
  let crashProbeTriggered = false;
  const interval = setInterval(() => {
    try {
      const currentRuntimes = processTreeEntries(child.pid ?? -1).filter(isWorkerRuntime);
      if (
        requestedSignal === null &&
        observedRuntimes.some(
          (recorded) => !currentRuntimes.some((current) => sameProcess(current, recorded)),
        )
      ) {
        monitor.crashed = true;
        writeRuntimeCrashMarker();
      }
      if (
        process.env.RT22_E2E_ENABLE_RUNTIME_CRASH_PROBE === "1" &&
        !crashProbeTriggered &&
        currentRuntimes.length > 0
      ) {
        crashProbeTriggered = true;
        signalRecordedProcess(currentRuntimes[0], "SIGKILL");
      }
      observedRuntimes = currentRuntimes;
    } catch {
      // The managed process outcome and cleanup checks remain authoritative.
    }
  }, 50);
  interval.unref();
  monitor.stop = () => clearInterval(interval);
  return monitor;
}

/**
 * Keep exact identities available if a managed root exits before cleanup
 * starts and reparents one of its descendants.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {{ entries: ProcessEntry[]; stop: () => void }}
 */
function startProcessTreeTracker(child) {
  /** @type {ProcessEntry[]} */
  const entries = [];
  const recordCurrentTree = () => {
    try {
      for (const entry of processTreeEntries(child.pid ?? -1)) {
        if (!entries.some((recorded) => sameProcess(recorded, entry))) {
          entries.push(entry);
        }
      }
    } catch {
      // Cleanup remains fail-closed if inspection is unavailable.
    }
  };
  recordCurrentTree();
  const interval = setInterval(recordCurrentTree, 50);
  interval.unref();
  return { entries, stop: () => clearInterval(interval) };
}

function writeRuntimeCrashMarker() {
  const markerPath = process.env.RT22_E2E_RUNTIME_CRASH_MARKER;
  if (markerPath === undefined) {
    return;
  }
  try {
    writeFileSync(markerPath, "observed\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // The probe assertion remains fail-closed if the marker cannot be written.
  }
}

/** @param {ProcessEntry} entry */
function isWorkerRuntime(entry) {
  return /(?:^|[\\/])workerd(?:\.exe)?(?:\s|$)/.test(entry.command);
}

/**
 * @param {ProcessOutcome} outcome
 * @param {boolean} processTreeTerminationRequested
 * @param {number | null} childFinishedAt
 * @param {number | null} processTreeTerminationRequestedAt
 */
function isExpectedShutdownOutcome(
  outcome,
  processTreeTerminationRequested,
  childFinishedAt,
  processTreeTerminationRequestedAt,
) {
  if (outcome.kind !== "exit") {
    return false;
  }
  if (outcome.signal === "SIGTERM" || outcome.code === 0 || outcome.code === 143) {
    return true;
  }
  return (
    process.platform === "win32" &&
    processTreeTerminationRequested &&
    childFinishedAt !== null &&
    processTreeTerminationRequestedAt !== null &&
    childFinishedAt >= processTreeTerminationRequestedAt
  );
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {() => void} [onTerminationRequested]
 * @param {ProcessEntry[]} [previouslyTrackedEntries]
 */
async function stopProcessTree(child, onTerminationRequested, previouslyTrackedEntries = []) {
  const processId = child.pid;
  if (processId === undefined) {
    return true;
  }

  const trackedEntries = mergeProcessEntries(
    processTreeEntries(processId),
    previouslyTrackedEntries,
  );
  if (process.platform === "win32" && processTableUnavailable) {
    return false;
  }
  if (!isProcessTreeRunning(processId) && trackedEntries.length === 0) {
    return true;
  }

  const gracefulSignalSent =
    signalProcessTree(processId, "SIGTERM") || signalRecordedProcesses(trackedEntries, "SIGTERM");
  if (gracefulSignalSent) {
    onTerminationRequested?.();
  }
  if (
    await waitForProcessTreeExit(
      processId,
      GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      trackedEntries,
    )
  ) {
    return true;
  }

  signalProcessTree(processId, "SIGKILL");
  signalRecordedProcesses(trackedEntries, "SIGKILL");
  return waitForProcessTreeExit(processId, FORCED_SHUTDOWN_TIMEOUT_MS, trackedEntries);
}

/*
 * The parent must be signalled before its runtime descendants. Otherwise
 * Wrangler can observe workerd's controlled termination as a crash and restart
 * it while the shutdown is already in progress.
 */
/**
 * @param {number} processId
 * @param {NodeJS.Signals} signal
 */
function signalProcessTree(processId, signal) {
  if (process.platform === "win32") {
    const arguments_ = ["/PID", String(processId), "/T"];
    if (signal === "SIGKILL") {
      arguments_.push("/F");
    }
    return spawnSync("taskkill", arguments_, { stdio: "ignore", windowsHide: true }).status === 0;
  }

  let signalSent = false;
  for (const entry of processTreeEntries(processId)) {
    const current = processIdentity(entry.pid);
    if (sameProcess(current, entry)) {
      signalSent = signalProcessId(entry.pid, signal) || signalSent;
    }
  }
  return signalSent;
}

/**
 * Signal the exact process identities captured before a parent can disappear
 * and reparent its descendants. This prevents cleanup from losing a runtime
 * merely because the original root PID is gone.
 *
 * @param {ProcessEntry[]} entries
 * @param {NodeJS.Signals} signal
 */
function signalRecordedProcesses(entries, signal) {
  let signalSent = false;
  for (const entry of entries) {
    const current = processIdentity(entry.pid);
    if (sameProcess(current, entry)) {
      signalSent = signalProcessId(entry.pid, signal) || signalSent;
    }
  }
  return signalSent;
}

/**
 * @param {ProcessEntry[]} currentEntries
 * @param {ProcessEntry[]} previouslyTrackedEntries
 * @returns {ProcessEntry[]}
 */
function mergeProcessEntries(currentEntries, previouslyTrackedEntries) {
  const mergedEntries = [...currentEntries];
  for (const entry of previouslyTrackedEntries) {
    if (!mergedEntries.some((recorded) => sameProcess(recorded, entry))) {
      mergedEntries.push(entry);
    }
  }
  return mergedEntries;
}

/**
 * @param {number} processId
 * @param {NodeJS.Signals} signal
 */
function signalProcessId(processId, signal) {
  try {
    process.kill(processId, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
    return false;
  }
}

/** @param {number} processId */
function isProcessTreeRunning(processId) {
  if (process.platform !== "win32") {
    return processTreeEntries(processId).length > 0;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    if (isPermissionError(error)) {
      return true;
    }
    throw error;
  }
}

/**
 * @param {number} processId
 * @param {number} timeoutMs
 * @param {ProcessEntry[]} [trackedEntries]
 */
async function waitForProcessTreeExit(processId, timeoutMs, trackedEntries = []) {
  const hasStopped = () => {
    const liveProcesses = liveRecordedProcesses(trackedEntries);
    return (
      !(process.platform === "win32" && processTableUnavailable) &&
      !isProcessTreeRunning(processId) &&
      liveProcesses.length === 0
    );
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasStopped()) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return hasStopped();
}

/**
 * @param {ProcessEntry[]} recordedEntries
 * @returns {ProcessEntry[]}
 */
function liveRecordedProcesses(recordedEntries) {
  if (recordedEntries.length === 0) {
    return [];
  }
  const currentEntries = readProcessTable();
  return recordedEntries.filter((recorded) =>
    sameProcess(currentEntries.find((entry) => entry.pid === recorded.pid) ?? null, recorded),
  );
}

/** @param {unknown} error */
function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

/** @param {unknown} error */
function isPermissionError(error) {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

/** @param {number} processId */
function processIdentity(processId) {
  return readProcessTable().find((entry) => entry.pid === processId) ?? null;
}

/**
 * @param {ProcessEntry} recorded
 * @param {NodeJS.Signals} signal
 */
function signalRecordedProcess(recorded, signal) {
  const current = processIdentity(recorded.pid);
  if (sameProcess(current, recorded)) {
    signalProcessId(recorded.pid, signal);
  }
}

/** @param {number} processId */
function processTreeEntries(processId) {
  const processTable = readProcessTable();
  const root = processTable.find((entry) => entry.pid === processId);
  if (root === undefined) {
    return [];
  }
  return [root, ...descendantsOf(processId, processTable)];
}

/** @returns {ProcessEntry[]} */
function readProcessTable() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    if (result.status !== 0) {
      processTableUnavailable = true;
      return [];
    }
    try {
      const processes = JSON.parse(result.stdout);
      const entries = (Array.isArray(processes) ? processes : [processes])
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({
          pid: Number(entry.ProcessId),
          ppid: Number(entry.ParentProcessId),
          started: String(entry.CreationDate ?? ""),
          command: String(entry.CommandLine ?? entry.Name ?? ""),
        }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
      processTableUnavailable = entries.length === 0;
      return entries;
    } catch {
      processTableUnavailable = true;
      return [];
    }
  }

  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect the E2E server process tree: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) =>
      line.match(
        /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
      ),
    )
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started: match[3],
      command: match[4],
    }));
}

/**
 * @param {number} rootPid
 * @param {ProcessEntry[]} processTable
 */
function descendantsOf(rootPid, processTable) {
  const descendantPids = new Set([rootPid]);
  const depthByPid = new Map([[rootPid, 0]]);
  let added = true;
  while (added) {
    added = false;
    for (const entry of processTable) {
      if (descendantPids.has(entry.ppid) && !descendantPids.has(entry.pid)) {
        descendantPids.add(entry.pid);
        depthByPid.set(entry.pid, (depthByPid.get(entry.ppid) ?? 0) + 1);
        added = true;
      }
    }
  }
  descendantPids.delete(rootPid);
  return processTable
    .filter((entry) => descendantPids.has(entry.pid))
    .sort((left, right) =>
      (depthByPid.get(left.pid) ?? Number.MAX_SAFE_INTEGER) -
      (depthByPid.get(right.pid) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * @param {ProcessEntry | null} left
 * @param {ProcessEntry} right
 */
function sameProcess(left, right) {
  return (
    left !== null &&
    left.pid === right.pid &&
    left.command === right.command &&
    left.started === right.started
  );
}

/** @param {string} command */
function executable(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function removeOwnedTemporaryRoot() {
  if (
    dirname(temporaryRoot) !== temporaryParent ||
    !basename(temporaryRoot).startsWith(TEMPORARY_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to remove an unexpected E2E directory: ${temporaryRoot}`);
  }

  rmSync(temporaryRoot, { force: true, recursive: true });
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
