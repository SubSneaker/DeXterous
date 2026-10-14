#!/usr/bin/env node
// The `dexterous` command: starts the DeXterous relay (see `dexterous --help`).
//
// Runs the relay compiled by `npm run build` (build/server/relay.js), not the
// TypeScript sources: Node refuses to strip types from files inside
// node_modules, which is where an installed copy lives. Plain JavaScript only,
// and nothing here may depend on the current working directory.
//
// This file is a small supervisor. The relay runs as a child process that
// shares this terminal. When it exits with RESTART_EXIT_CODE (after updating
// itself, see server/update.ts), it is started again, from the newly
// installed files, without opening another browser tab. Any other exit code
// is passed through. Keep the restart protocol stable: after an update, this
// old copy of the supervisor starts the new relay.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`DeXterous needs Node.js 22.18 or newer (this is ${process.version}).`);
  process.exit(1);
}

/** Must match RESTART_EXIT_CODE and SUPERVISOR_ENV in server/update.ts. */
const RESTART_EXIT_CODE = 75;
const SUPERVISOR_ENV = "DEXTEROUS_SUPERVISOR";
/** Gives up if the relay asks for this many restarts within a minute. */
const MAX_RESTARTS_PER_MINUTE = 3;

const relay = fileURLToPath(new URL("../build/server/relay.js", import.meta.url));
if (!existsSync(relay)) {
  console.error("DeXterous isn't built yet. Reinstall it, or run `npm run build` in a clone of the repository.");
  process.exit(1);
}

let args = process.argv.slice(2);
let child;
let restarts = [];
/** Ctrl+C (or another stop signal) arrived: never restart after that. */
let stopRequested = false;

function start() {
  // The IPC channel carries stop requests (see below) and lets the relay
  // notice if this process dies.
  child = spawn(process.execPath, [relay, ...args], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, [SUPERVISOR_ENV]: "1" },
  });
  child.once("error", (error) => {
    console.error(`Couldn't start DeXterous: ${error.message}`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (code === RESTART_EXIT_CODE && !stopRequested) {
      const now = Date.now();
      restarts = [...restarts.filter((time) => now - time < 60_000), now];
      if (restarts.length > MAX_RESTARTS_PER_MINUTE) {
        console.error("DeXterous keeps restarting, so it was stopped. Start it again with `dexterous`.");
        process.exit(1);
      }
      // The browser tab is already open; it reloads by itself.
      if (!args.includes("--no-open")) args = [...args, "--no-open"];
      start();
      return;
    }
    if (code === RESTART_EXIT_CODE) process.exit(0);
    if (signal) {
      // Die the same way, so shells and service managers see the signal.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// Ctrl+C in a terminal reaches the relay directly too (same process group, or
// same console on Windows), and the relay ignores the duplicate. Stop requests
// go over the IPC channel rather than as a second signal: a signal arriving
// while the relay is already exiting would kill it instead. Passing them on
// covers `kill <pid>`, service managers and closed terminals.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  if (signal === "SIGHUP" && process.platform === "win32") continue;
  process.on(signal, () => {
    stopRequested = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ stop: signal }, () => {});
    // No channel (it can't happen, but just in case). On Windows this ends
    // the relay without letting it clean up.
    else child.kill(signal);
  });
}

start();
