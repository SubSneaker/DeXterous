// Opens the app in the user's default browser once the relay is listening.
import { spawn } from "node:child_process";
import { log } from "./log.ts";

/**
 * Why the browser should not be opened automatically, or undefined if it
 * should: CI, output not going to a terminal (service managers, pipes), or a
 * Linux/BSD session without a graphical display (e.g. over SSH).
 */
export function autoOpenBlocker(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isTTY: boolean = process.stdout.isTTY === true,
): string | undefined {
  if (env.CI && env.CI !== "false" && env.CI !== "0") return "CI is set";
  if (!isTTY) return "the output is not a terminal";
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return "there is no graphical display";
  }
  return undefined;
}

/**
 * Asks the OS to open `url` in the default browser. Fire and forget: detached,
 * output ignored, and failures are only logged with --verbose. No shell is
 * involved, except cmd.exe for its `start` builtin on Windows (see below).
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args, verbatim] = browserCommand(url, platform);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    child.once("error", (error) => log.debug(`Could not open a browser with ${command}: ${error.message}`));
    child.unref();
  } catch (error) {
    log.debug(`Could not open a browser with ${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Characters that need no quoting or escaping for cmd.exe inside double quotes. */
const CMD_SAFE_URL = /^[A-Za-z0-9:/.[\]#=?_~-]+$/;

/** The command that opens `url` on `platform`: [command, args, windowsVerbatimArguments]. */
export function browserCommand(url: string, platform: NodeJS.Platform): [string, string[], boolean] {
  if (platform === "darwin") return ["open", [url], false];
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty "" is the window title. Only
    // used when the URL cannot be misread by cmd.exe (no &, ^, %, " ...);
    // anything else goes to explorer.exe, which takes the URL as a plain
    // argument.
    if (CMD_SAFE_URL.test(url)) return ["cmd.exe", ["/d", "/s", "/c", `"start "" "${url}""`], true];
    return ["explorer.exe", [url], false];
  }
  return ["xdg-open", [url], false];
}
