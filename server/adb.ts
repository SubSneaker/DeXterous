// Locating and (if needed) starting the local adb server.
//
// The relay never stops or restarts the adb server: other tools (Android
// Studio, scrcpy...) may be using it. It only runs `adb start-server` when
// nothing is listening, which is a no-op for an already running server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";
import { isLoopbackAddress, type HostPort } from "./network.ts";

const isWindows = process.platform === "win32";

/** Resolves true if a TCP connection to the adb server succeeds in time. */
export function isAdbServerReachable(server: HostPort, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: server.host, port: server.port });
    const finish = (reachable: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface AdbStartupStatus {
  reachable: boolean;
  /** We ran `adb start-server` (successfully or not). */
  attemptedStart: boolean;
  /** Path of the adb executable we found, if any. */
  adbPath?: string;
}

/**
 * Makes sure an adb server is listening at `server`. If not, and `allowStart`
 * is set, starts one with the locally installed platform-tools (loopback
 * addresses only). Never throws.
 */
export async function ensureAdbServer(server: HostPort, allowStart: boolean): Promise<AdbStartupStatus> {
  if (await isAdbServerReachable(server)) return { reachable: true, attemptedStart: false };
  // Starting a server only makes sense on the computer running DeXterous.
  if (!allowStart || !isLoopbackAddress(server.host)) return { reachable: false, attemptedStart: false };

  const adbPath = findAdbExecutable();
  if (!adbPath) return { reachable: false, attemptedStart: false };

  log.info(`adb server not running; starting it with ${adbPath} ...`);
  await runAdbStartServer(adbPath, server.port);
  return {
    reachable: await isAdbServerReachable(server, 2000),
    attemptedStart: true,
    adbPath,
  };
}

/** Finds `adb` on PATH or in the usual Android SDK locations. */
export function findAdbExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = isWindows ? "adb.exe" : "adb";
  const candidates: string[] = [];

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const cleaned = dir.trim().replace(/^"(.*)"$/, "$1");
    if (cleaned) candidates.push(path.join(cleaned, exe));
  }
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (sdk) candidates.push(path.join(sdk, "platform-tools", exe));
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Android", "sdk", "platform-tools", exe));
    // Homebrew installs, which GUI-launched shells may not have on PATH.
    candidates.push("/opt/homebrew/bin/adb", "/usr/local/bin/adb");
  } else if (isWindows) {
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", exe));
    }
  } else {
    candidates.push(path.join(home, "Android", "Sdk", "platform-tools", exe));
  }

  return candidates.find(isExecutableFile);
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `adb -P <port> start-server`; resolves when it exits (or times out). */
function runAdbStartServer(adbPath: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    // No shell, no inherited stdio: the forked adb daemon would otherwise keep
    // our pipes open. On POSIX, `detached` puts it in its own process group so
    // Ctrl+C on the relay does not also kill the freshly started adb server.
    const child = spawn(adbPath, ["-P", String(port), "start-server"], {
      stdio: "ignore",
      windowsHide: true,
      detached: !isWindows,
    });
    const timer = setTimeout(() => {
      // Only the short-lived `adb start-server` client process, never the server.
      child.kill();
      resolve();
    }, 15_000);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("error", (error) => {
      log.debug(`adb start-server failed: ${error.message}`);
      done();
    });
  });
}
