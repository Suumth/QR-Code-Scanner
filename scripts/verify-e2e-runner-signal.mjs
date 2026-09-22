import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

/** @typedef {{ code: number | null; signal: NodeJS.Signals | null }} ExitOutcome */
/** @typedef {{ command: string; pgid: number; pid: number; ppid: number }} ProcessEntry */

const PROBE_DIRECTORY_PREFIX = "rt22-e2e-signal-probe-";
const OWNED_ENTRY_PREFIXES = ["rt22-e2e-run-", "rt22-vouchers-e2e-"];
const E2E_HOST = "127.0.0.1";
const E2E_PORT = 4173;
const E2E_HEALTH_URL = `http://${E2E_HOST}:${E2E_PORT}/api/health`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryParent = resolve(tmpdir());
let standardOutput = "";
let standardError = "";
const signalArgument = process.argv[2] ?? "SIGTERM";
const cleanupSelfTest = signalArgument === "--cleanup-self-test";
const earlyWrapperCrashSelfTest = signalArgument === "--early-wrapper-crash-self-test";
const normalShutdownSelfTest = signalArgument === "--normal-shutdown-self-test";
const disconnectedServerSelfTest = signalArgument === "--disconnected-server-self-test";
const crashedWorkerShutdownSelfTest = signalArgument === "--crashed-worker-shutdown-self-test";
const crashedRuntimeSelfTest = signalArgument === "--crashed-runtime-self-test";
const stoppedServerSelfTest = signalArgument === "--stopped-server-self-test";
const crashedServerSelfTest = signalArgument === "--crashed-server-self-test";
if (
  !cleanupSelfTest &&
  !earlyWrapperCrashSelfTest &&
  !normalShutdownSelfTest &&
  !disconnectedServerSelfTest &&
  !crashedWorkerShutdownSelfTest &&
  !crashedRuntimeSelfTest &&
  !stoppedServerSelfTest &&
  !crashedServerSelfTest &&
  signalArgument !== "SIGTERM" &&
  signalArgument !== "SIGINT"
) {
  throw new Error(
    `Expected SIGTERM, SIGINT, --cleanup-self-test, --early-wrapper-crash-self-test, --normal-shutdown-self-test, --disconnected-server-self-test, --crashed-worker-shutdown-self-test, --crashed-runtime-self-test, --stopped-server-self-test or --crashed-server-self-test, received ${signalArgument}.`,
  );
}
/** @type {NodeJS.Signals} */
const probeSignal = signalArgument === "SIGINT" ? "SIGINT" : "SIGTERM";

if (process.platform === "win32") {
  console.log("Runner signal regression is POSIX-only; Windows uses the IPC ownership path directly.");
  process.exit(0);
}

if (cleanupSelfTest) {
  await verifyHungRunnerCleanup();
  await verifyExitedRunnerCleanup();
  process.exit(0);
}

if (earlyWrapperCrashSelfTest) {
  await verifyEarlyWrapperCrashCleanup();
  process.exit(0);
}

if (normalShutdownSelfTest) {
  await verifyNormalE2ERunnerShutdown();
  process.exit(0);
}

if (disconnectedServerSelfTest) {
  await verifyDisconnectedServerCleanup();
  process.exit(0);
}

if (crashedWorkerShutdownSelfTest) {
  await verifyCrashedWorkerDuringShutdown();
  process.exit(0);
}

if (crashedRuntimeSelfTest) {
  await verifyCrashedRuntime();
  process.exit(0);
}

if (await isPortListening()) {
  throw new Error(`Refusing to run the signal probe while ${E2E_HOST}:${E2E_PORT} is in use.`);
}

const probeDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
/** @type {ProcessEntry[]} */
let ownedProcessSnapshot = [];
/** @type {import("node:child_process").ChildProcess | null} */
let runner = null;
/** @type {Promise<ExitOutcome> | null} */
let runnerOutcome = null;
/** @type {ProcessEntry | null} */
let runnerIdentity = null;
/** @type {ProcessEntry | null} */
let stoppedServerIdentity = null;

try {
  runner = spawn(process.execPath, [join(repositoryRoot, "scripts", "run-e2e.mjs")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TEMP: probeDirectory,
      TMP: probeDirectory,
      TMPDIR: probeDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout?.on("data", (chunk) => {
    standardOutput = appendBounded(standardOutput, chunk.toString());
  });
  runner.stderr?.on("data", (chunk) => {
    standardError = appendBounded(standardError, chunk.toString());
  });
  runnerOutcome = childOutcome(runner);
  runnerIdentity = await processIdentityWithin(runner, 2_000);
  if (runnerIdentity === null) {
    throw new Error("The E2E runner did not become observable.");
  }

  await waitForHealth(runnerOutcome);
  if (runner.pid === undefined) {
    throw new Error("The E2E runner has no process ID.");
  }
  ownedProcessSnapshot = descendantsOf(runner.pid, readProcessTable());
  stoppedServerIdentity =
    ownedProcessSnapshot.find((entry) =>
      entry.command.includes("scripts/e2e-server.mjs"),
    ) ?? null;
  if (stoppedServerIdentity === null) {
    throw new Error("The signal probe could not identify its E2E server descendant.");
  }

  if (stoppedServerSelfTest) {
    signalRecordedProcess(stoppedServerIdentity, "SIGSTOP");
  }
  if (crashedServerSelfTest) {
    signalRecordedProcess(stoppedServerIdentity, "SIGKILL");
  } else {
    runner.kill(probeSignal);
  }
  const outcome = await outcomeWithinTracking(
    runnerOutcome,
    runnerIdentity,
    ownedProcessSnapshot,
    20_000,
  );
  if (outcome === null) {
    throw new Error(
      stoppedServerSelfTest
        ? "The E2E runner did not exit within 20 seconds after its owned server was stopped."
        : crashedServerSelfTest
          ? "The E2E runner did not exit within 20 seconds after its owned server crashed."
          : `The E2E runner did not exit within 20 seconds after ${probeSignal}.`,
    );
  }

  await delay(750);
  const portStillListening = await isPortListening();
  const leakedEntries = findOwnedEntries(probeDirectory);
  const liveOwnedProcesses = liveSnapshotEntries(ownedProcessSnapshot);
  const observedFailure =
    outcome.code !== 1 ||
    outcome.signal !== null ||
    portStillListening ||
    leakedEntries.length > 0 ||
    liveOwnedProcesses.length > 0;

  if (observedFailure) {
    const probeLabel = stoppedServerSelfTest
      ? "stopped-server"
      : crashedServerSelfTest
        ? "crashed-server"
        : probeSignal;
    throw new Error(
      [
        `Runner ${probeLabel} regression: exit=${outcome.code}, signal=${outcome.signal ?? "none"}`,
        `port-listening=${portStillListening}`,
        `owned-temp-entries=${leakedEntries.length}`,
        `live-owned-processes=${liveOwnedProcesses.map((entry) => entry.pid).join(",") || "none"}`,
        standardOutput ? `stdout-tail:\n${standardOutput}` : "",
        standardError ? `stderr-tail:\n${standardError}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  console.log(
    stoppedServerSelfTest
      ? "Runner stopped-server cleanup passed: exit=1, port=free, owned temp=0, owned processes=0."
      : crashedServerSelfTest
        ? "Runner crashed-server cleanup passed: exit=1, port=free, owned temp=0, owned processes=0."
        : `Runner ${probeSignal} cleanup passed: exit=1, port=free, owned temp=0, owned processes=0.`,
  );
} finally {
  if (stoppedServerIdentity !== null) {
    signalRecordedProcess(stoppedServerIdentity, "SIGCONT");
  }
  await cleanupOwnedProbe(
    runner,
    runnerOutcome,
    runnerIdentity,
    ownedProcessSnapshot,
    probeDirectory,
  );
}

/**
 * @param {Promise<ExitOutcome>} runnerOutcome
 * @param {boolean} [allowEarlyExit]
 */
async function waitForHealth(runnerOutcome, allowEarlyExit = false) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(E2E_HEALTH_URL, { signal: AbortSignal.timeout(500) })
        .then((response) => (response.ok ? "ready" : "retry"))
        .catch(() => "retry"),
      runnerOutcome.then(() => "exited"),
    ]);
    if (result === "ready") {
      return;
    }
    if (result === "exited") {
      if (allowEarlyExit) {
        return;
      }
      throw new Error(`The E2E runner exited before health was ready.\n${standardError}`);
    }
    await delay(100);
  }
  throw new Error("The E2E server did not become healthy within 120 seconds.");
}

/**
 * @param {import("node:child_process").ChildProcess | null} runnerProcess
 * @param {Promise<ExitOutcome> | null} runnerOutcome
 * @param {ProcessEntry | null} runnerIdentity
 * @param {ProcessEntry[]} processSnapshot
 * @param {string} ownedDirectory
 * @param {number} [gracefulTimeoutMs]
 * @param {number} [forcedTimeoutMs]
 */
async function cleanupOwnedProbe(
  runnerProcess,
  runnerOutcome,
  runnerIdentity,
  processSnapshot,
  ownedDirectory,
  gracefulTimeoutMs = 10_000,
  forcedTimeoutMs = 2_000,
) {
  const trackedDescendants = [...processSnapshot];
  let exactRunner = runnerIdentity;
  if (exactRunner === null && runnerProcess !== null) {
    exactRunner = await processIdentityWithin(runnerProcess, 250);
  }

  const refreshDescendants = () => {
    if (runnerProcess?.pid === undefined || exactRunner === null) {
      return;
    }
    trackCurrentDescendants(exactRunner, trackedDescendants);
  };

  refreshDescendants();
  if (exactRunner !== null) {
    signalRecordedProcess(exactRunner, "SIGTERM");
  } else if (
    runnerProcess !== null &&
    runnerProcess.exitCode === null &&
    runnerProcess.signalCode === null
  ) {
    runnerProcess.kill("SIGTERM");
  }

  for (const entry of trackedDescendants.filter((candidate) =>
    candidate.command.includes("scripts/e2e-server.mjs"),
  )) {
    signalRecordedProcess(entry, "SIGTERM");
  }

  /** @param {number} timeoutMs */
  const waitForCompleteStop = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      refreshDescendants();
      const runnerAlive =
        exactRunner !== null && liveSnapshotEntries([exactRunner]).length > 0;
      if (
        !runnerAlive &&
        !(await isPortListening()) &&
        liveSnapshotEntries(trackedDescendants).length === 0
      ) {
        return true;
      }
      await delay(100);
    }
    return false;
  };

  let completeStop = await waitForCompleteStop(gracefulTimeoutMs);
  if (!completeStop) {
    refreshDescendants();
    for (const entry of liveSnapshotEntries(trackedDescendants).reverse()) {
      signalRecordedProcess(entry, "SIGKILL");
    }
    if (exactRunner !== null) {
      signalRecordedProcess(exactRunner, "SIGKILL");
    }
    completeStop = await waitForCompleteStop(forcedTimeoutMs);
  }

  const runnerOutcomeObserved =
    runnerProcess === null ||
    (runnerOutcome !== null &&
      (await outcomeWithin(runnerOutcome, forcedTimeoutMs)) !== null);
  if (!completeStop || !runnerOutcomeObserved) {
    console.error(`Owned signal-probe cleanup could not finish; preserving ${ownedDirectory}.`);
    return false;
  }

  removeOwnedProbeDirectory(ownedDirectory);
  return true;
}

async function verifyHungRunnerCleanup() {
  const ownedDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const syntheticSource = [
    'const { spawn } = require("node:child_process")',
    'process.on("SIGTERM", () => {})',
    'let childStarted = false',
    'process.on("message", (message) => { if (message === "begin" && !childStarted) { childStarted = true; setTimeout(() => { const child = spawn(process.execPath, ["--input-type=commonjs", "-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.send?.({ kind: "child", pid: child.pid }) }, 100) } })',
    'process.send?.("ready")',
    'setInterval(() => {}, 1000)',
  ].join(";");
  const syntheticRunner = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", syntheticSource],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const syntheticOutcome = childOutcome(syntheticRunner);
  /** @type {(ready: boolean) => void} */
  let resolveSyntheticReady;
  const syntheticReady = new Promise((resolveReady) => {
    resolveSyntheticReady = resolveReady;
    syntheticRunner.once("exit", () => resolveReady(false));
  });
  /** @type {ProcessEntry | undefined} */
  let lateDescendantIdentity;
  syntheticRunner.on("message", (message) => {
    if (message === "ready") {
      resolveSyntheticReady(true);
    } else if (
      typeof message === "object" &&
      message !== null &&
      "kind" in message &&
      message.kind === "child" &&
      "pid" in message &&
      typeof message.pid === "number"
    ) {
      lateDescendantIdentity = readProcessTable().find((entry) => entry.pid === message.pid);
    }
  });
  /** @type {ProcessEntry | undefined} */
  let runnerIdentity;

  try {
    runnerIdentity = (await processIdentityWithin(syntheticRunner, 2_000)) ?? undefined;
    if (runnerIdentity === undefined) {
      throw new Error("The synthetic hung runner did not become observable.");
    }
    if (!(await Promise.race([syntheticReady, delay(2_000).then(() => false)]))) {
      throw new Error("The synthetic hung runner did not install its signal handler.");
    }

    const initialDescendants = descendantsOf(syntheticRunner.pid ?? -1, readProcessTable());
    if (initialDescendants.length > 0) {
      throw new Error("The synthetic runner spawned a descendant before the cleanup snapshot.");
    }
    syntheticRunner.send("begin", () => {});
    const cleanupSucceeded = await cleanupOwnedProbe(
      syntheticRunner,
      syntheticOutcome,
      runnerIdentity,
      initialDescendants,
      ownedDirectory,
      500,
      2_000,
    );
    if (!cleanupSucceeded) {
      throw new Error("Hung-runner cleanup did not report a complete stop.");
    }
    if (liveSnapshotEntries([runnerIdentity]).length > 0) {
      throw new Error("Hung-runner cleanup returned while the exact runner was still alive.");
    }
    if (
      lateDescendantIdentity === undefined ||
      liveSnapshotEntries([lateDescendantIdentity]).length > 0
    ) {
      throw new Error("Hung-runner cleanup did not stop its late exact descendant.");
    }
    console.log("Hung-runner cleanup self-test passed: exact runner and late descendants stopped.");
  } finally {
    const currentTable = readProcessTable();
    const emergencySnapshot =
      syntheticRunner.pid === undefined
        ? []
        : descendantsOf(syntheticRunner.pid, currentTable);
    if (runnerIdentity !== undefined) {
      emergencySnapshot.push(runnerIdentity);
    }
    if (lateDescendantIdentity !== undefined) {
      emergencySnapshot.push(lateDescendantIdentity);
    }
    for (const entry of emergencySnapshot.reverse()) {
      signalRecordedProcess(entry, "SIGKILL");
    }
    if (emergencySnapshot.length > 0) {
      await delay(250);
    }
    if (
      runnerIdentity !== undefined &&
      lateDescendantIdentity !== undefined &&
      liveSnapshotEntries(emergencySnapshot).length === 0
    ) {
      removeOwnedProbeDirectory(ownedDirectory);
    } else {
      console.error(`Synthetic cleanup remains uncertain; preserving ${ownedDirectory}.`);
    }
  }
}

async function verifyExitedRunnerCleanup() {
  const ownedDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const syntheticSource = [
    'const { spawn } = require("node:child_process")',
    'let stopping = false',
    'process.on("SIGTERM", () => { if (stopping) return; stopping = true; const child = spawn(process.execPath, ["--input-type=commonjs", "-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.send?.({ kind: "child", pid: child.pid }); setTimeout(() => process.exit(1), 500) })',
    'process.send?.("ready")',
    'setInterval(() => {}, 1000)',
  ].join(";");
  const syntheticRunner = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", syntheticSource],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const syntheticOutcome = childOutcome(syntheticRunner);
  /** @type {(ready: boolean) => void} */
  let resolveSyntheticReady;
  const syntheticReady = new Promise((resolveReady) => {
    resolveSyntheticReady = resolveReady;
    syntheticRunner.once("exit", () => resolveReady(false));
  });
  /** @type {ProcessEntry | undefined} */
  let lateDescendantIdentity;
  syntheticRunner.on("message", (message) => {
    if (message === "ready") {
      resolveSyntheticReady(true);
    } else if (
      typeof message === "object" &&
      message !== null &&
      "kind" in message &&
      message.kind === "child" &&
      "pid" in message &&
      typeof message.pid === "number"
    ) {
      lateDescendantIdentity = readProcessTable().find((entry) => entry.pid === message.pid);
    }
  });
  /** @type {ProcessEntry | undefined} */
  let runnerIdentity;

  try {
    runnerIdentity = (await processIdentityWithin(syntheticRunner, 2_000)) ?? undefined;
    if (
      runnerIdentity === undefined ||
      !(await Promise.race([syntheticReady, delay(2_000).then(() => false)]))
    ) {
      throw new Error("The synthetic exiting runner did not become ready.");
    }
    const initialDescendants = descendantsOf(syntheticRunner.pid ?? -1, readProcessTable());
    if (initialDescendants.length > 0) {
      throw new Error("The synthetic exiting runner spawned a child before the snapshot.");
    }

    signalRecordedProcess(runnerIdentity, "SIGTERM");
    const outcome = await outcomeWithinTracking(
      syntheticOutcome,
      runnerIdentity,
      initialDescendants,
      2_000,
    );
    if (outcome === null || outcome.code !== 1) {
      throw new Error("The synthetic exiting runner did not exit as expected.");
    }
    const childDeadline = Date.now() + 2_000;
    while (Date.now() < childDeadline && lateDescendantIdentity === undefined) {
      await delay(20);
    }
    if (lateDescendantIdentity === undefined) {
      throw new Error("The synthetic exiting runner did not expose its late descendant.");
    }
    const exactLateDescendant = lateDescendantIdentity;
    if (!initialDescendants.some((entry) => sameProcess(entry, exactLateDescendant))) {
      throw new Error("Continuous tracking missed the late descendant before runner exit.");
    }

    await cleanupOwnedProbe(
      syntheticRunner,
      syntheticOutcome,
      runnerIdentity,
      initialDescendants,
      ownedDirectory,
      300,
      2_000,
    );
    if (liveSnapshotEntries([exactLateDescendant]).length > 0) {
      throw new Error("Exited-runner cleanup returned while its late descendant was still alive.");
    }
    console.log("Exited-runner cleanup self-test passed: late reparented descendant stopped.");
  } finally {
    const emergencySnapshot = [];
    if (runnerIdentity !== undefined) {
      emergencySnapshot.push(runnerIdentity);
    }
    if (lateDescendantIdentity !== undefined) {
      emergencySnapshot.push(lateDescendantIdentity);
    }
    for (const entry of emergencySnapshot.reverse()) {
      signalRecordedProcess(entry, "SIGKILL");
    }
    if (emergencySnapshot.length > 0) {
      await delay(250);
    }
    if (
      runnerIdentity !== undefined &&
      lateDescendantIdentity !== undefined &&
      liveSnapshotEntries(emergencySnapshot).length === 0
    ) {
      removeOwnedProbeDirectory(ownedDirectory);
    } else {
      console.error(`Synthetic cleanup remains uncertain; preserving ${ownedDirectory}.`);
    }
  }
}

async function verifyEarlyWrapperCrashCleanup() {
  if (await isPortListening()) {
    throw new Error(`Refusing to run the early-wrapper-crash probe while ${E2E_HOST}:${E2E_PORT} is in use.`);
  }

  const probeDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const gateDirectory = join(probeDirectory, "early-wrapper-crash-gate");
  const childMarker = join(gateDirectory, "managed-child");
  mkdirSync(gateDirectory);
  /** @type {import("node:child_process").ChildProcess | null} */
  let runner = null;
  /** @type {Promise<ExitOutcome> | null} */
  let runnerOutcome = null;
  /** @type {ProcessEntry | null} */
  let runnerIdentity = null;
  /** @type {ProcessEntry | undefined} */
  let serverIdentity;
  /** @type {ProcessEntry | null} */
  let managedChildIdentity = null;
  /** @type {ProcessEntry[]} */
  let ownedProcessSnapshot = [];
  let ownedProcessSnapshotDescription;
  let postKillProcessSnapshotDescription;
  let runnerStopped = false;
  let runnerOutput = "";
  let runnerError = "";

  try {
    runner = spawn(process.execPath, [join(repositoryRoot, "scripts", "run-e2e.mjs")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TEMP: probeDirectory,
        TMP: probeDirectory,
        TMPDIR: probeDirectory,
        RT22_E2E_EARLY_CRASH_GATE: gateDirectory,
        RT22_E2E_EARLY_CRASH_CHILD_MARKER: childMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    runner.stdout?.on("data", (chunk) => {
      runnerOutput = appendBounded(runnerOutput, chunk.toString());
    });
    runner.stderr?.on("data", (chunk) => {
      runnerError = appendBounded(runnerError, chunk.toString());
    });
    runnerOutcome = childOutcome(runner);
    runnerIdentity = await processIdentityWithin(runner, 2_000);
    if (runnerIdentity === null || runner.pid === undefined) {
      throw new Error("The early-wrapper-crash probe runner did not become observable.");
    }
    const runnerProcessId = runner.pid;

    try {
      serverIdentity = await waitForProcessCondition(
        () =>
          descendantsOf(runnerProcessId, readProcessTable()).find((entry) =>
            entry.command.includes("scripts/e2e-server.mjs"),
          ) ?? null,
        "the real e2e-server.mjs wrapper",
        20_000,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} runner-exit=${runner.exitCode ?? "running"}\nstdout=${runnerOutput}\nstderr=${runnerError}`,
        { cause: error },
      );
    }
    await waitForProcessCondition(
      () => (existsSync(join(gateDirectory, "server-ready")) ? true : null),
      "the e2e-server.mjs early-crash gate",
      2_000,
    );

    signalRecordedProcess(runnerIdentity, "SIGSTOP");
    runnerStopped = true;
    await waitForProcessCondition(
      () => (isProcessStopped(runnerIdentity?.pid) ? runnerIdentity : null),
      "the outer E2E runner to stop",
      2_000,
    );
    writeFileSync(join(gateDirectory, "release"), "release\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    await waitForProcessCondition(
      () => (existsSync(childMarker) ? true : null),
      "the real managed E2E child marker while the outer runner is stopped",
      20_000,
    );
    const managedChildPid = Number.parseInt(readFileSync(childMarker, "utf8").trim(), 10);
    managedChildIdentity = await waitForProcessCondition(
      () => readProcessTable().find((entry) => entry.pid === managedChildPid) ?? null,
      "the real managed E2E child process",
      2_000,
    );
    if (serverIdentity === undefined || managedChildIdentity === null) {
      throw new Error("The early-wrapper-crash probe lost its owned process identities.");
    }
    const exactServerIdentity = serverIdentity;
    const processTable = readProcessTable();
    const ownedGroupIds = new Set([serverIdentity.pgid, managedChildIdentity.pgid]);
    ownedProcessSnapshot = processTable.filter((entry) => ownedGroupIds.has(entry.pgid));
    ownedProcessSnapshot.push(serverIdentity, managedChildIdentity);
    ownedProcessSnapshotDescription = ownedProcessSnapshot
      .map((entry) => `${entry.pid}:${entry.pgid}:${entry.command}`)
      .join(" | ");
    await waitForProcessCondition(
      () => {
        const current = readProcessTable().find(
          (entry) => entry.pid === managedChildIdentity?.pid,
        );
        if (current === undefined) {
          return null;
        }
        signalRecordedProcess(current, "SIGSTOP");
        if (isProcessStopped(current.pid)) {
          managedChildIdentity = current;
          return current;
        }
        return null;
      },
      "the real managed E2E child to stop",
      2_000,
    );

    signalRecordedProcess(exactServerIdentity, "SIGKILL");
    await waitForProcessCondition(
      () =>
        liveSnapshotEntries([exactServerIdentity]).length === 0
          ? exactServerIdentity
          : null,
      "the crashed e2e-server.mjs wrapper to exit",
      2_000,
    );
    postKillProcessSnapshotDescription = readProcessTable()
      .filter((entry) => entry.pgid === exactServerIdentity.pgid)
      .map((entry) => `${entry.pid}:${entry.pgid}:${entry.command}`)
      .join(" | ");
    signalRecordedProcess(runnerIdentity, "SIGCONT");
    runnerStopped = false;

    const outcome = await outcomeWithin(runnerOutcome, 20_000);
    if (outcome === null) {
      throw new Error("The E2E runner did not exit within 20 seconds after the early server crash.");
    }

    const cleanupStatus = await waitForEarlyCleanup(
      probeDirectory,
      ownedProcessSnapshot,
      10_000,
    );
    if (
      outcome.code !== 1 ||
      outcome.signal !== null ||
      !cleanupStatus.complete
    ) {
      throw new Error(
        [
          `Runner early-wrapper-crash regression: exit=${outcome.code}, signal=${outcome.signal ?? "none"}`,
          `port-listening=${cleanupStatus.portStillListening}`,
          `owned-temp-entries=${cleanupStatus.leakedEntries.length}`,
          `live-owned-processes=${cleanupStatus.liveOwnedProcesses.map((entry) => entry.pid).join(",") || "none"}`,
          `live-owned-groups=${cleanupStatus.liveOwnedGroups.map((entry) => `${entry.pid}:${entry.pgid}`).join(",") || "none"}`,
          `managed-child=${managedChildIdentity.pid}:${managedChildIdentity.pgid}`,
          `owned-snapshot=${ownedProcessSnapshotDescription ?? "none"}`,
          `post-kill-snapshot=${postKillProcessSnapshotDescription ?? "none"}`,
          `runner-stdout=${runnerOutput || "none"}`,
          `runner-stderr=${runnerError || "none"}`,
        ].join("\n"),
      );
    }

    const normalStart = spawn(
      process.execPath,
      [join(repositoryRoot, "scripts", "run-e2e.mjs"), "--list"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          TEMP: probeDirectory,
          TMP: probeDirectory,
          TMPDIR: probeDirectory,
        },
        stdio: "ignore",
      },
    );
    const normalOutcome = await outcomeWithin(childOutcome(normalStart), 120_000);
    if (normalOutcome === null || normalOutcome.code !== 0 || normalOutcome.signal !== null) {
      throw new Error(
        `A subsequent normal E2E start could not reuse ${E2E_HOST}:${E2E_PORT}: exit=${normalOutcome?.code ?? "timeout"}, signal=${normalOutcome?.signal ?? "none"}.`,
      );
    }
    const finalStatus = await waitForEarlyCleanup(probeDirectory, [], 5_000);
    if (finalStatus.portStillListening || finalStatus.leakedEntries.length > 0) {
      throw new Error(
        `The subsequent normal E2E start left port/state residue: port-listening=${finalStatus.portStillListening}, owned-temp-entries=${finalStatus.leakedEntries.length}.`,
      );
    }

    console.log(
      "Runner early-wrapper-crash cleanup passed: exit=1, port reusable, owned temp=0, owned groups=0, subsequent start=0.",
    );
  } finally {
    if (runnerStopped && runnerIdentity !== null) {
      signalRecordedProcess(runnerIdentity, "SIGCONT");
    }
    await cleanupOwnedProbe(
      runner,
      runnerOutcome,
      runnerIdentity,
      ownedProcessSnapshot,
      probeDirectory,
    );
  }
}

async function verifyNormalE2ERunnerShutdown() {
  if (await isPortListening()) {
    throw new Error(`Refusing to run the normal-shutdown probe while ${E2E_HOST}:${E2E_PORT} is in use.`);
  }

  const ownedDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const runner = spawn(
    process.execPath,
    [join(repositoryRoot, "scripts", "run-e2e.mjs")],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        TEMP: ownedDirectory,
        TMP: ownedDirectory,
        TMPDIR: ownedDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let runnerOutput = "";
  let runnerError = "";
  runner.stdout?.on("data", (chunk) => {
    runnerOutput = appendBounded(runnerOutput, chunk.toString());
  });
  runner.stderr?.on("data", (chunk) => {
    runnerError = appendBounded(runnerError, chunk.toString());
  });
  const runnerOutcome = childOutcome(runner);
  const runnerIdentity = await processIdentityWithin(runner, 2_000);
  /** @type {ProcessEntry[]} */
  const ownedProcessSnapshot =
    runnerIdentity === null || runner.pid === undefined
      ? []
      : descendantsOf(runner.pid, readProcessTable());

  try {
    if (runnerIdentity === null || runner.pid === undefined) {
      throw new Error("The normal-shutdown probe runner did not become observable.");
    }
    await waitForHealth(runnerOutcome);
    const outcome = await outcomeWithin(runnerOutcome, 120_000);
    const leakedEntries = findOwnedEntries(ownedDirectory);
    const portStillListening = await isPortListening();
    if (
      outcome === null ||
      outcome.code !== 0 ||
      outcome.signal !== null ||
      leakedEntries.length > 0 ||
      portStillListening
    ) {
      throw new Error(
        [
          `Normal E2E server shutdown regression: exit=${outcome?.code ?? "timeout"}, signal=${outcome?.signal ?? "none"}`,
          `port-listening=${portStillListening}`,
          `owned-temp-entries=${leakedEntries.length}`,
          runnerOutput ? `stdout-tail:\n${runnerOutput}` : "",
          runnerError ? `stderr-tail:\n${runnerError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    console.log("Normal E2E runner shutdown passed: exit=0, port=free, owned temp=0.");
  } finally {
    await cleanupOwnedProbe(
      runner,
      runnerOutcome,
      runnerIdentity,
      ownedProcessSnapshot,
      ownedDirectory,
    );
  }
}

async function verifyDisconnectedServerCleanup() {
  if (await isPortListening()) {
    throw new Error(`Refusing to run the disconnected-server probe while ${E2E_HOST}:${E2E_PORT} is in use.`);
  }

  const ownedDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const server = spawn(
    process.execPath,
    [join(repositoryRoot, "scripts", "e2e-server.mjs")],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        RT22_E2E_SERVER_GROUP_OWNER: "runner",
        RT22_E2E_SERVER_GROUP_TOKEN: `disconnected-server-${basename(ownedDirectory)}`,
        RT22_E2E_TMP_PARENT: ownedDirectory,
        TEMP: ownedDirectory,
        TMP: ownedDirectory,
        TMPDIR: ownedDirectory,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let serverOutput = "";
  let serverError = "";
  server.stdout?.on("data", (chunk) => {
    serverOutput = appendBounded(serverOutput, chunk.toString());
  });
  server.stderr?.on("data", (chunk) => {
    serverError = appendBounded(serverError, chunk.toString());
  });
  const serverOutcome = childOutcome(server);
  const serverIdentity = await processIdentityWithin(server, 2_000);
  /** @type {ProcessEntry[]} */
  const ownedProcessSnapshot =
    serverIdentity === null || server.pid === undefined
      ? []
      : descendantsOf(server.pid, readProcessTable());

  try {
    if (serverIdentity === null || server.pid === undefined) {
      throw new Error("The disconnected-server probe did not become observable.");
    }
    await waitForHealth(serverOutcome);
    server.disconnect();
    const outcome = await outcomeWithin(serverOutcome, 15_000);
    const groupStopped = await waitForProcessCondition(
      () => (liveProcessGroups([serverIdentity]).length === 0 ? true : null),
      "the disconnected E2E server process group to stop",
      5_000,
    ).catch(() => false);
    const liveOwnedGroups = liveProcessGroups([serverIdentity]);
    const leakedEntries = findOwnedEntries(ownedDirectory);
    const portStillListening = await isPortListening();
    if (
      outcome === null ||
      outcome.code !== 0 ||
      outcome.signal !== null ||
      !groupStopped ||
      liveOwnedGroups.length > 0 ||
      leakedEntries.length > 0 ||
      portStillListening
    ) {
      throw new Error(
        [
          `Disconnected E2E server cleanup regression: exit=${outcome?.code ?? "timeout"}, signal=${outcome?.signal ?? "none"}`,
          `port-listening=${portStillListening}`,
          `owned-temp-entries=${leakedEntries.length}`,
          `live-owned-processes=${liveOwnedGroups.map((entry) => entry.pid).join(",") || "none"}`,
          serverOutput ? `stdout-tail:\n${serverOutput}` : "",
          serverError ? `stderr-tail:\n${serverError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    console.log("Disconnected E2E server cleanup passed: exit=0, port=free, owned group=0.");
  } finally {
    await cleanupOwnedProbe(
      server,
      serverOutcome,
      serverIdentity,
      ownedProcessSnapshot,
      ownedDirectory,
    );
  }
}

async function verifyCrashedWorkerDuringShutdown() {
  await verifyCrashedE2EProcess(
    "RT22_E2E_ENABLE_CRASH_PROBE",
    "crashed-worker",
    "Crashed-worker shutdown",
  );
}

async function verifyCrashedRuntime() {
  await verifyCrashedE2EProcess(
    "RT22_E2E_ENABLE_RUNTIME_CRASH_PROBE",
    "crashed-runtime",
    "Crashed-runtime fail-closed",
  );
}

/**
 * @param {string} probeEnvironmentVariable
 * @param {string} probeLabel
 * @param {string} resultLabel
 */
async function verifyCrashedE2EProcess(
  probeEnvironmentVariable,
  probeLabel,
  resultLabel,
) {
  if (await isPortListening()) {
    throw new Error(`Refusing to run the ${probeLabel} probe while ${E2E_HOST}:${E2E_PORT} is in use.`);
  }

  const ownedDirectory = mkdtempSync(join(temporaryParent, PROBE_DIRECTORY_PREFIX));
  const runtimeCrashMarker = join(ownedDirectory, "runtime-crash-observed");
  const runner = spawn(
    process.execPath,
    [join(repositoryRoot, "scripts", "run-e2e.mjs")],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        [probeEnvironmentVariable]: "1",
        ...(probeEnvironmentVariable === "RT22_E2E_ENABLE_RUNTIME_CRASH_PROBE"
          ? { RT22_E2E_RUNTIME_CRASH_MARKER: runtimeCrashMarker }
          : {}),
        TEMP: ownedDirectory,
        TMP: ownedDirectory,
        TMPDIR: ownedDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let runnerOutput = "";
  let runnerError = "";
  runner.stdout?.on("data", (chunk) => {
    runnerOutput = appendBounded(runnerOutput, chunk.toString());
  });
  runner.stderr?.on("data", (chunk) => {
    runnerError = appendBounded(runnerError, chunk.toString());
  });
  const runnerOutcome = childOutcome(runner);
  const runnerIdentity = await processIdentityWithin(runner, 2_000);
  /** @type {ProcessEntry[]} */
  const ownedProcessSnapshot =
    runnerIdentity === null || runner.pid === undefined
      ? []
      : descendantsOf(runner.pid, readProcessTable());

  try {
    if (runnerIdentity === null || runner.pid === undefined) {
      throw new Error(`The ${probeLabel} probe runner did not become observable.`);
    }
    await waitForHealth(
      runnerOutcome,
      probeEnvironmentVariable === "RT22_E2E_ENABLE_RUNTIME_CRASH_PROBE",
    );
    const outcome = await outcomeWithin(runnerOutcome, 120_000);
    const leakedEntries = findOwnedEntries(ownedDirectory);
    const portStillListening = await isPortListening();
    const runtimeCrashObserved =
      probeEnvironmentVariable !== "RT22_E2E_ENABLE_RUNTIME_CRASH_PROBE" ||
      existsSync(runtimeCrashMarker);
    if (
      outcome === null ||
      outcome.code !== 1 ||
      outcome.signal !== null ||
      leakedEntries.length > 0 ||
      portStillListening ||
      !runtimeCrashObserved
    ) {
      throw new Error(
        [
          `${resultLabel} regression: exit=${outcome?.code ?? "timeout"}, signal=${outcome?.signal ?? "none"}`,
          `port-listening=${portStillListening}`,
          `owned-temp-entries=${leakedEntries.length}`,
          `runtime-crash-observed=${runtimeCrashObserved}`,
          runnerOutput ? `stdout-tail:\n${runnerOutput}` : "",
          runnerError ? `stderr-tail:\n${runnerError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    console.log(`${resultLabel} passed: exit=1, port=free, owned temp=0.`);
  } finally {
    await cleanupOwnedProbe(
      runner,
      runnerOutcome,
      runnerIdentity,
      ownedProcessSnapshot,
      ownedDirectory,
    );
  }
}

/**
 * @param {string} probeDirectory
 * @param {ProcessEntry[]} ownedProcessSnapshot
 * @param {number} timeoutMs
 */
async function waitForEarlyCleanup(probeDirectory, ownedProcessSnapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await readEarlyCleanupStatus(probeDirectory, ownedProcessSnapshot);
  while (Date.now() < deadline && !status.complete) {
    await delay(50);
    status = await readEarlyCleanupStatus(probeDirectory, ownedProcessSnapshot);
  }
  return status;
}

/**
 * @param {string} probeDirectory
 * @param {ProcessEntry[]} ownedProcessSnapshot
 */
async function readEarlyCleanupStatus(probeDirectory, ownedProcessSnapshot) {
  const portStillListening = await isPortListening();
  const leakedEntries = findOwnedEntries(probeDirectory);
  const liveOwnedProcesses = liveSnapshotEntries(ownedProcessSnapshot);
  const liveOwnedGroups = liveProcessGroups(ownedProcessSnapshot);
  return {
    complete:
      !portStillListening &&
      leakedEntries.length === 0 &&
      liveOwnedProcesses.length === 0 &&
      liveOwnedGroups.length === 0,
    leakedEntries,
    liveOwnedGroups,
    liveOwnedProcesses,
    portStillListening,
  };
}

/** @param {ProcessEntry[]} snapshot */
function liveProcessGroups(snapshot) {
  const groupIds = new Set(snapshot.map((entry) => entry.pgid).filter((pgid) => pgid > 1));
  if (groupIds.size === 0) {
    return [];
  }
  return readProcessTable().filter((entry) => groupIds.has(entry.pgid));
}

/**
 * @param {Promise<ExitOutcome>} outcome
 * @param {ProcessEntry} exactRunner
 * @param {ProcessEntry[]} trackedDescendants
 * @param {number} timeoutMs
 * @returns {Promise<ExitOutcome | null>}
 */
async function outcomeWithinTracking(
  outcome,
  exactRunner,
  trackedDescendants,
  timeoutMs,
) {
  let settled = false;
  /** @type {ExitOutcome | null} */
  let observedOutcome = null;
  outcome.then((result) => {
    observedOutcome = result;
    settled = true;
  });

  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    trackCurrentDescendants(exactRunner, trackedDescendants);
    await delay(20);
  }
  trackCurrentDescendants(exactRunner, trackedDescendants);
  return settled ? observedOutcome : null;
}

/**
 * @param {ProcessEntry} exactRunner
 * @param {ProcessEntry[]} trackedDescendants
 */
function trackCurrentDescendants(exactRunner, trackedDescendants) {
  const processTable = readProcessTable();
  const currentRunner = processTable.find((entry) => entry.pid === exactRunner.pid);
  if (!sameProcess(currentRunner, exactRunner)) {
    return;
  }
  for (const descendant of descendantsOf(exactRunner.pid, processTable)) {
    addTrackedProcess(trackedDescendants, descendant);
  }
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<ProcessEntry | null>}
 */
async function processIdentityWithin(child, timeoutMs) {
  if (child.pid === undefined) {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = readProcessTable().find((entry) => entry.pid === child.pid);
    if (identity !== undefined) {
      return identity;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return null;
    }
    await delay(20);
  }
  return null;
}

/**
 * @template T
 * @param {() => T | null | undefined | false} condition
 * @param {string} description
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function waitForProcessCondition(condition, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = condition();
    if (result) {
      return result;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/** @param {number | undefined} processId */
function isProcessStopped(processId) {
  if (processId === undefined) {
    return false;
  }
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(processId)], {
    encoding: "utf8",
  });
  return result.status === 0 && /(^|\s)T[+<]?/.test(result.stdout.trim());
}

/**
 * @param {ProcessEntry[]} tracked
 * @param {ProcessEntry} candidate
 */
function addTrackedProcess(tracked, candidate) {
  if (!tracked.some((entry) => sameProcess(entry, candidate))) {
    tracked.push(candidate);
  }
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
    left.command === right.command
  );
}

/**
 * @param {ProcessEntry} recorded
 * @param {NodeJS.Signals} signal
 */
function signalRecordedProcess(recorded, signal) {
  const current = readProcessTable().find((entry) => entry.pid === recorded.pid);
  if (
    current === undefined ||
    current.pgid !== recorded.pgid ||
    current.command !== recorded.command
  ) {
    return;
  }
  try {
    process.kill(recorded.pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

/** @returns {ProcessEntry[]} */
function readProcessTable() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect the signal-probe process tree: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }));
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

/** @param {ProcessEntry[]} snapshot */
function liveSnapshotEntries(snapshot) {
  const currentByPid = new Map(readProcessTable().map((entry) => [entry.pid, entry]));
  return snapshot.filter((recorded) => {
    const current = currentByPid.get(recorded.pid);
    return (
      current !== undefined &&
      current.pgid === recorded.pgid &&
      current.command === recorded.command
    );
  });
}

/** @param {string} directory */
function findOwnedEntries(directory) {
  /** @type {string[]} */
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (
      OWNED_ENTRY_PREFIXES.some((prefix) => entry.name.startsWith(prefix)) ||
      entry.name === "e2e.env" ||
      entry.name === "wrangler-state"
    ) {
      matches.push(entry.name);
    }
  }
  return matches;
}

/** @param {import("node:child_process").ChildProcess} child */
function childOutcome(child) {
  return new Promise((resolveOutcome) => {
    child.once("error", (error) => {
      standardError = appendBounded(standardError, error.message);
      resolveOutcome({ code: 1, signal: null });
    });
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
}

/**
 * @param {Promise<ExitOutcome>} outcome
 * @param {number} timeoutMs
 */
function outcomeWithin(outcome, timeoutMs) {
  return new Promise((resolveOutcome) => {
    const timeout = setTimeout(() => resolveOutcome(null), timeoutMs);
    outcome.then((result) => {
      clearTimeout(timeout);
      resolveOutcome(result);
    });
  });
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
 * @param {string} existing
 * @param {string} addition
 */
function appendBounded(existing, addition) {
  return `${existing}${addition}`.slice(-20_000);
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** @param {unknown} error */
function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

/** @param {string} directory */
function removeOwnedProbeDirectory(directory) {
  if (
    dirname(directory) !== temporaryParent ||
    !basename(directory).startsWith(PROBE_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to remove an unexpected signal-probe directory: ${directory}`);
  }
  rmSync(directory, { force: true, recursive: true });
}
