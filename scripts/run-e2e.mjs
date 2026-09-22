import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ kind: "error"; error: Error } |
 *   { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }} ChildOutcome
 */
/**
 * @typedef {{ child: import("node:child_process").ChildProcess;
 *   cleanupAcknowledged: boolean; identity: ProcessEntry | null;
 *   groupSentinelToken: string | null;
 *   ownedProcessIdentities: ProcessEntry[]; ownershipProven: boolean;
 *   processGroupId: number | null;
 *   outcome: Promise<ChildOutcome>; trackedProcesses: ProcessEntry[];
 *   trackingInterval: NodeJS.Timeout | null; trackingReliable: boolean }} ExternalServer
 */
/** @typedef {{ command: string; pgid: number; pid: number; ppid: number;
 *   started: string }} ProcessEntry */

const RUN_DIRECTORY_PREFIX = "rt22-e2e-run-";
const SERVER_DIRECTORY_PREFIX = "rt22-vouchers-e2e-";
const SERVER_CONTROL_MESSAGE = "rt22-e2e-shutdown";
const SERVER_CLEANUP_MESSAGE = "rt22-e2e-cleanup-complete";
const E2E_HOST = "127.0.0.1";
const E2E_PORT = 4173;
const E2E_HEALTH_URL = `http://${E2E_HOST}:${E2E_PORT}/api/health`;
const EXTERNAL_SERVER_IPC_TIMEOUT_MS = 10_000;
const EXTERNAL_SERVER_TERM_TIMEOUT_MS = 3_000;
const EXTERNAL_SERVER_KILL_TIMEOUT_MS = 3_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outerTemporaryDirectory = resolve(tmpdir());
const runDirectory = mkdtempSync(join(outerTemporaryDirectory, RUN_DIRECTORY_PREFIX));
const runnerEnvironment = {
  ...process.env,
  RT22_E2E_SERVER_MANAGED: "false",
  RT22_E2E_SERVER_GROUP_TOKEN: randomUUID(),
  RT22_E2E_TMP_PARENT: runDirectory,
  TEMP: runDirectory,
  TMP: runDirectory,
  TMPDIR: runDirectory,
};
const listOnly = process.argv.slice(2).includes("--list");
const manageServerExternally = !listOnly;

/** @type {import("node:child_process").ChildProcess | null} */
let playwrightProcess = null;
/** @type {ExternalServer | null} */
let externalServer = null;
/** @type {NodeJS.Signals | null} */
let requestedSignal = null;

/** @type {Map<NodeJS.Signals, () => void>} */
const signalHandlers = new Map();
/** @type {NodeJS.Signals[]} */
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwardedSignals) {
  const handler = () => {
    requestedSignal ??= signal;
    if (playwrightProcess !== null) {
      signalPlaywrightTree(playwrightProcess, signal);
    }
    requestExternalServerShutdown();
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

let infrastructureSucceeded = true;
let externalServerTreeStopped = true;
/** @type {ChildOutcome} */
let playwrightOutcome = { kind: "exit", code: 1, signal: null };

if (manageServerExternally) {
  if (await isPortListening()) {
    console.error(`Cannot start the isolated E2E Worker: ${E2E_HOST}:${E2E_PORT} is in use.`);
    infrastructureSucceeded = false;
  } else if (requestedSignal === null) {
    externalServer = startExternalServer();
    if (!(await waitForExternalServerReady(externalServer))) {
      console.error("The externally managed E2E Worker did not become ready.");
      infrastructureSucceeded = false;
    }
  }
}

if (infrastructureSucceeded && requestedSignal === null) {
  playwrightOutcome = await runPlaywright();
} else if (requestedSignal !== null) {
  infrastructureSucceeded = false;
}

if (externalServer !== null) {
  const stopped = await stopExternalServer(externalServer);
  externalServerTreeStopped = stopped.treeStopped;
  infrastructureSucceeded = stopped.graceful && infrastructureSucceeded;
}

// Give a wrongly orphaned workerd enough time to flush state after its npx
// parent has exited. A correct server shutdown waits for the whole process tree,
// so this delay does not race legitimate cleanup.
await delay(500);

const leakedServerEntries = readdirSync(runDirectory, { withFileTypes: true })
  .filter((entry) => entry.name.startsWith(SERVER_DIRECTORY_PREFIX))
  .map((entry) => join(runDirectory, entry.name));

if (leakedServerEntries.length > 0) {
  console.error(
    "E2E cleanup regression: isolated server state remains after Playwright exited:\n" +
      leakedServerEntries.map((path) => `- ${path}`).join("\n"),
  );
  infrastructureSucceeded = false;
}

for (const [signal, handler] of signalHandlers) {
  process.removeListener(signal, handler);
}

if (
  (manageServerExternally && externalServerTreeStopped) ||
  (!manageServerExternally && leakedServerEntries.length === 0)
) {
  removeOwnedRunDirectory();
}

process.exitCode =
  infrastructureSucceeded && playwrightOutcome.kind === "exit" && playwrightOutcome.signal === null
    ? (playwrightOutcome.code ?? 1)
    : 1;

async function runPlaywright() {
  const child = spawn(executable("npx"), ["playwright", "test", ...process.argv.slice(2)], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: {
      ...runnerEnvironment,
      ...(manageServerExternally ? { RT22_E2E_SERVER_MANAGED: "true" } : {}),
    },
    stdio: "inherit",
  });
  playwrightProcess = child;
  const outcome = await childOutcome(child, "Unable to start Playwright");
  playwrightProcess = null;
  return outcome;
}

function startExternalServer() {
  const child = spawn(process.execPath, [join(repositoryRoot, "scripts", "e2e-server.mjs")], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: {
      ...runnerEnvironment,
      ...(process.platform !== "win32"
        ? { RT22_E2E_SERVER_GROUP_OWNER: "runner" }
        : {}),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  /** @type {ExternalServer} */
  const server = {
    child,
    cleanupAcknowledged: false,
    groupSentinelToken: runnerEnvironment.RT22_E2E_SERVER_GROUP_TOKEN ?? null,
    identity: process.platform === "win32" ? null : processIdentity(child.pid),
    ownedProcessIdentities: [],
    ownershipProven: false,
    processGroupId: process.platform === "win32" ? null : child.pid ?? null,
    outcome: childOutcome(child, "Unable to start the isolated E2E server"),
    trackedProcesses: [],
    trackingInterval: null,
    trackingReliable: true,
  };
  if (process.platform === "win32") {
    refreshExternalServerProcesses(server);
    server.trackingInterval = setInterval(
      () => refreshExternalServerProcesses(server),
      750,
    );
    server.trackingInterval.unref();
  }
  child.on("message", (message) => {
    if (message === SERVER_CLEANUP_MESSAGE) {
      server.cleanupAcknowledged = true;
    }
  });
  return server;
}

/** @param {ExternalServer} server */
async function waitForExternalServerReady(server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && requestedSignal === null) {
    if (process.platform === "win32") {
      refreshExternalServerProcesses(server);
    } else {
      refreshExternalServerIdentity(server);
    }
    const probe = await Promise.race([
      fetch(E2E_HEALTH_URL, { signal: AbortSignal.timeout(500) })
        .then((response) => (response.ok ? "ready" : "retry"))
        .catch(() => "retry"),
      server.outcome.then(() => "exited"),
    ]);
    if (probe === "ready") {
      return true;
    }
    if (probe === "exited") {
      return false;
    }
    await delay(100);
  }
  return false;
}

/** @param {ExternalServer} server */
async function stopExternalServer(server) {
  requestExternalServerShutdown();
  if (process.platform === "win32") {
    refreshExternalServerProcesses(server);
  } else {
    refreshExternalServerIdentity(server);
  }
  const gracefulOutcome =
    await outcomeWithin(server.outcome, EXTERNAL_SERVER_IPC_TIMEOUT_MS);
  if (gracefulOutcome !== null && server.cleanupAcknowledged) {
    const treeStopped =
      process.platform === "win32" ||
      (await waitForOwnedProcessGroupExit(
        server,
        EXTERNAL_SERVER_TERM_TIMEOUT_MS,
      ));
    if (treeStopped) {
      stopExternalServerTracking(server);
      disconnectExternalServer(server);
      return {
        graceful:
          gracefulOutcome.kind === "exit" &&
          gracefulOutcome.code === 0 &&
          gracefulOutcome.signal === null,
        treeStopped: true,
      };
    }
  }
  if (
    gracefulOutcome?.kind === "error" &&
    server.child.pid === undefined &&
    server.identity === null
  ) {
    stopExternalServerTracking(server);
    disconnectExternalServer(server);
    return { graceful: false, treeStopped: true };
  }

  disconnectExternalServer(server);
  let treeStopped = false;
  try {
    treeStopped =
      process.platform === "win32"
        ? await stopExternalServerWindows(server)
        : await stopExternalServerPosix(server);
  } catch (error) {
    console.error(
      "Unable to verify the isolated E2E server process-tree shutdown:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    stopExternalServerTracking(server);
  }
  if (!treeStopped) {
    // The exact tree could not be proven stopped. Its state is preserved below,
    // but neither the child handle nor IPC may keep this runner alive forever.
    server.child.unref();
  }
  const graceful =
    treeStopped &&
    server.cleanupAcknowledged &&
    gracefulOutcome?.kind === "exit" &&
    gracefulOutcome.code === 0 &&
    gracefulOutcome.signal === null;
  return { graceful, treeStopped };
}

/** @param {ExternalServer} server */
async function stopExternalServerWindows(server) {
  refreshExternalServerProcesses(server);
  if (server.identity === null) {
    return false;
  }

  signalWindowsOwnedProcessTree(server, false);
  if (
    (await waitForOwnedProcessTreeExit(
      server,
      EXTERNAL_SERVER_TERM_TIMEOUT_MS,
    )) &&
    server.trackingReliable &&
    (await outcomeWithin(server.outcome, EXTERNAL_SERVER_TERM_TIMEOUT_MS)) !== null
  ) {
    return true;
  }

  refreshExternalServerProcesses(server);
  signalWindowsOwnedProcessTree(server, true);
  return (
    (await waitForOwnedProcessTreeExit(
      server,
      EXTERNAL_SERVER_KILL_TIMEOUT_MS,
    )) &&
    server.trackingReliable &&
    (await outcomeWithin(server.outcome, EXTERNAL_SERVER_KILL_TIMEOUT_MS)) !== null
  );
}

/**
 * @param {ExternalServer} server
 * @param {boolean} force
 */
function signalWindowsOwnedProcessTree(server, force) {
  for (const entry of liveOwnedProcesses(server.trackedProcesses).reverse()) {
    const arguments_ = ["/PID", String(entry.pid), "/T"];
    if (force) {
      arguments_.push("/F");
    }
    spawnSync("taskkill", arguments_, {
      stdio: "ignore",
      timeout: force
        ? EXTERNAL_SERVER_KILL_TIMEOUT_MS
        : EXTERNAL_SERVER_TERM_TIMEOUT_MS,
      windowsHide: true,
    });
  }
}

/**
 * @param {ExternalServer} server
 */
async function stopExternalServerPosix(server) {
  const processGroupId = server.processGroupId;
  if (
    processGroupId === null ||
    processGroupId <= 1 ||
    processGroupId === currentProcessGroupId()
  ) {
    return false;
  }

  refreshExternalServerIdentity(server);
  signalOwnedProcessGroup(server, "SIGTERM");
  if (server.identity !== null) {
    signalExactProcess(server.identity, "SIGCONT");
  }
  if (
    (await waitForOwnedProcessGroupExit(
      server,
      EXTERNAL_SERVER_TERM_TIMEOUT_MS,
    )) &&
    (await outcomeWithin(server.outcome, EXTERNAL_SERVER_TERM_TIMEOUT_MS)) !== null
  ) {
    return true;
  }

  signalOwnedProcessGroup(server, "SIGKILL");
  return (
    (await waitForOwnedProcessGroupExit(
      server,
      EXTERNAL_SERVER_KILL_TIMEOUT_MS,
    )) &&
    (await outcomeWithin(server.outcome, EXTERNAL_SERVER_KILL_TIMEOUT_MS)) !== null
  );
}

/** @param {ExternalServer} server */
function stopExternalServerTracking(server) {
  if (server.trackingInterval !== null) {
    clearInterval(server.trackingInterval);
    server.trackingInterval = null;
  }
}

/** @param {ExternalServer} server */
function disconnectExternalServer(server) {
  if (!server.child.connected) {
    return;
  }
  try {
    server.child.disconnect();
  } catch {
    // Exact process-tree verification below remains authoritative.
  }
}

/**
 * @param {ExternalServer} server
 */
function refreshExternalServerProcesses(server) {
  /** @type {ProcessEntry[]} */
  let processTable;
  try {
    processTable = readProcessTable();
  } catch {
    server.trackingReliable = false;
    return;
  }
  server.identity ??=
    processTable.find((entry) => entry.pid === server.child.pid) ?? null;
  if (server.identity === null) {
    return;
  }

  addTrackedProcess(server.trackedProcesses, server.identity);
  let added = true;
  while (added) {
    const sizeBefore = server.trackedProcesses.length;
    const currentByPid = new Map(
      processTable.map((entry) => [entry.pid, entry]),
    );
    const provenOwnedGroups = new Set(
      server.trackedProcesses
        .filter((recorded) =>
          sameProcess(currentByPid.get(recorded.pid), recorded),
        )
        .map((recorded) => recorded.pgid)
        .filter((pgid) => pgid > 1),
    );
    for (const recorded of [...server.trackedProcesses]) {
      const current = currentByPid.get(recorded.pid);
      if (sameProcess(current, recorded)) {
        for (const descendant of descendantsOf(recorded.pid, processTable)) {
          addTrackedProcess(server.trackedProcesses, descendant);
        }
      }
      if (
        process.platform !== "win32" &&
        provenOwnedGroups.has(recorded.pgid)
      ) {
        for (const groupMember of processTable.filter(
          (entry) => entry.pgid === recorded.pgid,
        )) {
          addTrackedProcess(server.trackedProcesses, groupMember);
        }
      }
    }
    added = server.trackedProcesses.length > sizeBefore;
  }
}

/** @param {ExternalServer} server */
function refreshExternalServerIdentity(server) {
  if (server.identity !== null) {
    return;
  }
  server.identity = processIdentity(server.child.pid);
}

/** @returns {number | null} */
function currentProcessGroupId() {
  return processIdentity(process.pid)?.pgid ?? null;
}

/**
 * @param {ExternalServer} server
 * @param {NodeJS.Signals} signal
 */
function signalOwnedProcessGroup(server, signal) {
  const processGroupId = server.processGroupId;
  const currentGroupId = currentProcessGroupId();
  if (
    processGroupId === null ||
    processGroupId <= 1 ||
    processGroupId === currentGroupId
  ) {
    throw new Error(`Refusing to signal unsafe E2E process group ${processGroupId}.`);
  }
  const processTable = readProcessTable();
  const groupMembers = processTable.filter((entry) => entry.pgid === processGroupId);
  if (groupMembers.length === 0) {
    return;
  }
  assertOwnedProcessGroup(server, processTable, groupMembers);
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

/** @param {ExternalServer} server */
function isOwnedProcessGroupRunning(server) {
  const processGroupId = server.processGroupId;
  if (
    processGroupId === null ||
    processGroupId <= 1 ||
    processGroupId === currentProcessGroupId()
  ) {
    return true;
  }
  const processTable = readProcessTable();
  const groupMembers = processTable.filter((entry) => entry.pgid === processGroupId);
  if (groupMembers.length > 0) {
    assertOwnedProcessGroup(server, processTable, groupMembers);
    return true;
  }
  try {
    process.kill(-processGroupId, 0);
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
 * @param {ExternalServer} server
 * @param {ProcessEntry[]} processTable
 * @param {ProcessEntry[]} groupMembers
 */
function assertOwnedProcessGroup(server, processTable, groupMembers) {
  const processGroupId = server.processGroupId;
  if (server.ownershipProven) {
    if (
      !groupMembers.some((entry) =>
        server.ownedProcessIdentities.some((recorded) =>
          sameProcessInstance(entry, recorded),
        ),
      )
    ) {
      throw new Error(
        `Refusing to signal a reused E2E process group without a surviving run member: ${processGroupId}.`,
      );
    }
    return;
  }

  const currentLeader = processTable.find((entry) => entry.pid === server.child.pid);
  if (currentLeader !== undefined) {
    if (
      server.identity === null ||
      !sameProcess(currentLeader, server.identity) ||
      currentLeader.pgid !== processGroupId
    ) {
      throw new Error(
        `Refusing to signal an E2E process group whose wrapper identity changed: ${processGroupId}.`,
      );
    }
  } else {
    if (server.identity !== null && server.identity.pgid !== processGroupId) {
      throw new Error(
        `Refusing to signal an E2E process group without wrapper continuity: ${processGroupId}.`,
      );
    }

    const sentinelMarker =
      server.groupSentinelToken === null
        ? null
        : `rt22-e2e-sentinel:${server.groupSentinelToken}`;
    if (
      sentinelMarker !== null &&
      !groupMembers.some((entry) => entry.command.includes(sentinelMarker))
    ) {
      throw new Error(
        `Refusing to signal an E2E process group without its run sentinel: ${processGroupId}.`,
      );
    }
  }

  if (!groupMembers.some((entry) => entry.pgid === processGroupId)) {
    throw new Error(`Unable to prove ownership of E2E process group ${processGroupId}.`);
  }
  server.ownedProcessIdentities = [...groupMembers];
  server.ownershipProven = true;
}

/**
 * @param {ExternalServer} server
 * @param {number} timeoutMs
 */
async function waitForOwnedProcessGroupExit(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isOwnedProcessGroupRunning(server)) {
      return true;
    }
    await delay(50);
  }
  return !isOwnedProcessGroupRunning(server);
}

/**
 * @param {ProcessEntry[]} trackedProcesses
 * @param {ProcessEntry} candidate
 */
function addTrackedProcess(trackedProcesses, candidate) {
  if (!trackedProcesses.some((entry) => sameProcess(entry, candidate))) {
    trackedProcesses.push(candidate);
  }
}

/**
 * @param {ExternalServer} server
 * @param {number} timeoutMs
 */
async function waitForOwnedProcessTreeExit(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    refreshExternalServerProcesses(server);
    if (liveOwnedProcesses(server.trackedProcesses).length === 0) {
      return true;
    }
    await delay(50);
  }
  refreshExternalServerProcesses(server);
  return liveOwnedProcesses(server.trackedProcesses).length === 0;
}

/** @param {ProcessEntry[]} trackedProcesses */
function liveOwnedProcesses(trackedProcesses) {
  const currentByPid = new Map(readProcessTable().map((entry) => [entry.pid, entry]));
  return trackedProcesses.filter((recorded) =>
    sameProcess(currentByPid.get(recorded.pid), recorded),
  );
}

/**
 * @param {ProcessEntry} recorded
 * @param {NodeJS.Signals} signal
 */
function signalExactProcess(recorded, signal) {
  const current = processIdentity(recorded.pid);
  if (sameProcess(current ?? undefined, recorded)) {
    signalProcessId(recorded.pid, signal);
  }
}

/**
 * @param {number} processId
 * @param {NodeJS.Signals} signal
 */
function signalProcessId(processId, signal) {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

/** @param {number | undefined} processId */
function processIdentity(processId) {
  if (processId === undefined) {
    return null;
  }
  return readProcessTable().find((entry) => entry.pid === processId) ?? null;
}

/** @returns {ProcessEntry[]} */
function readProcessTable() {
  if (process.platform === "win32") {
    return readWindowsProcessTable();
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
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
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
      ),
    )
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[4],
      command: match[5],
    }));
}

/** @returns {ProcessEntry[]} */
function readWindowsProcessTable() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine, Name | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect the Windows E2E server process tree: ${result.stderr}`,
    );
  }

  /** @type {unknown} */
  const parsed = JSON.parse(result.stdout || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) => {
    if (
      typeof record !== "object" ||
      record === null ||
      !("ProcessId" in record) ||
      !("ParentProcessId" in record)
    ) {
      return [];
    }
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid < 1) {
      return [];
    }
    const commandLine =
      "CommandLine" in record && typeof record.CommandLine === "string"
        ? record.CommandLine
        : "Name" in record && typeof record.Name === "string"
          ? record.Name
          : "";
    const started =
      "CreationDate" in record && typeof record.CreationDate === "string"
        ? record.CreationDate
        : "";
    return [{ command: commandLine, pgid: 0, pid, ppid, started }];
  });
}

/**
 * @param {number} rootPid
 * @param {ProcessEntry[]} processTable
 */
function descendantsOf(rootPid, processTable) {
  const descendantPids = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const entry of processTable) {
      if (descendantPids.has(entry.ppid) && !descendantPids.has(entry.pid)) {
        descendantPids.add(entry.pid);
        added = true;
      }
    }
  }
  descendantPids.delete(rootPid);
  return processTable.filter((entry) => descendantPids.has(entry.pid));
}

/**
 * @param {ProcessEntry | undefined} left
 * @param {ProcessEntry} right
 */
function sameProcess(left, right) {
  return (
    left !== undefined &&
    left.pid === right.pid &&
    left.pgid === right.pgid &&
    left.command === right.command &&
    left.started === right.started
  );
}

/**
 * @param {ProcessEntry | undefined} left
 * @param {ProcessEntry} right
 */
function sameProcessInstance(left, right) {
  return (
    left !== undefined &&
    left.pid === right.pid &&
    left.pgid === right.pgid &&
    left.started === right.started
  );
}

function requestExternalServerShutdown() {
  const child = externalServer?.child;
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    !child.connected
  ) {
    return;
  }

  try {
    child.send(SERVER_CONTROL_MESSAGE, () => {});
  } catch {
    // The outcome/timeout path below owns escalation if IPC closed concurrently.
  }
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalPlaywrightTree(child, signal) {
  const processId = child.pid;
  if (
    processId === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(processId), "/T", "/F"], {
      stdio: "ignore",
      timeout: 3_000,
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

async function isPortListening() {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host: E2E_HOST, port: E2E_PORT });
    /** @param {boolean} listening */
    const finish = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} errorPrefix
 * @returns {Promise<ChildOutcome>}
 */
function childOutcome(child, errorPrefix) {
  return new Promise((resolveOutcome) => {
    child.once("error", (error) => {
      console.error(`${errorPrefix}:`, error.message);
      resolveOutcome({ kind: "error", error });
    });
    child.once("exit", (code, signal) => {
      resolveOutcome({ kind: "exit", code, signal });
    });
  });
}

/**
 * @param {Promise<ChildOutcome>} outcome
 * @param {number} timeoutMs
 */
async function outcomeWithin(outcome, timeoutMs) {
  return new Promise((resolveOutcome) => {
    const timeout = setTimeout(() => resolveOutcome(null), timeoutMs);
    outcome.then((result) => {
      clearTimeout(timeout);
      resolveOutcome(result);
    });
  });
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** @param {unknown} error */
function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

/** @param {unknown} error */
function isPermissionError(error) {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

/** @param {string} command */
function executable(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function removeOwnedRunDirectory() {
  if (
    dirname(runDirectory) !== outerTemporaryDirectory ||
    !basename(runDirectory).startsWith(RUN_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to remove an unexpected E2E directory: ${runDirectory}`);
  }

  rmSync(runDirectory, { force: true, recursive: true });
}
