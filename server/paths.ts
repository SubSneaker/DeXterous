// Where the relay finds its own files (package.json, the built app) and where
// it keeps its private state (access token, self-signed certificate).
//
// The relay runs from two layouts, and must not depend on the current working
// directory (`dexterous` is usually a global command):
//   <package>/server/relay.ts         `npm run relay` (TypeScript sources)
//   <package>/build/server/relay.js   `dexterous` / `npm start` (compiled)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";
import { ensurePrivateDir, readOptionalFile, writePrivateFile } from "./storage.ts";

/** Product name, used for the per-user folder on macOS and Windows. */
export const APP_NAME = "DeXterous";

/** Files kept in the state directory (all secrets). */
const STATE_FILES = ["token", "cert.pem", "key.pem"] as const;

/**
 * The package root: the nearest directory at or above `moduleDir` (at most a
 * few levels up) that contains a package.json.
 */
export function findPackageRoot(moduleDir: string): string {
  let dir = path.resolve(moduleDir);
  for (let depth = 0; depth < 4; depth++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Should not happen in a real install; assume the source layout.
  return path.resolve(moduleDir, "..");
}

/** The `version` field of `<packageRoot>/package.json`, or "0.0.0". */
export function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Default state directory for each platform, as shown in --help. */
export const STATE_DIR_DESCRIPTIONS: readonly (readonly [platform: string, dir: string])[] = [
  ["macOS", `~/Library/Application Support/${APP_NAME}`],
  ["Windows", `%APPDATA%\\${APP_NAME}`],
  ["Linux and others", "$XDG_CONFIG_HOME/dexterous (default: ~/.config/dexterous)"],
];

/**
 * The per-user directory holding the token and the TLS certificate:
 *   $DEXTEROUS_HOME, if set
 *   macOS    ~/Library/Application Support/DeXterous
 *   Windows  %APPDATA%\DeXterous (or ~/AppData/Roaming/DeXterous)
 *   others   $XDG_CONFIG_HOME/dexterous (or ~/.config/dexterous)
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const override = env.DEXTEROUS_HOME?.trim();
  // A leading ~ is expanded too, for shells and service files that don't.
  if (override) return path.resolve(override.replace(/^~(?=$|[\\/])/, () => home));

  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_NAME);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return path.join(appData || path.join(home, "AppData", "Roaming"), APP_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // The XDG spec says relative values must be ignored.
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "dexterous");
}

/**
 * Earlier versions kept their state in `<package>/.dex-web/`. If that folder
 * has a token and the new state directory does not, copy the files over so
 * bookmarked links (and an accepted certificate) keep working. The old folder
 * is left untouched. Never throws.
 */
export function migrateLegacyState(packageRoot: string, stateDir: string): void {
  const legacyDir = path.join(packageRoot, ".dex-web");
  try {
    if (path.resolve(legacyDir) === path.resolve(stateDir)) return;
    if (!fs.existsSync(path.join(legacyDir, "token")) || fs.existsSync(path.join(stateDir, "token"))) return;

    const copied: string[] = [];
    for (const name of STATE_FILES) {
      const target = path.join(stateDir, name);
      if (fs.existsSync(target)) continue;
      const contents = readOptionalFile(path.join(legacyDir, name));
      if (contents === undefined) continue;
      ensurePrivateDir(stateDir);
      writePrivateFile(target, contents);
      copied.push(name);
    }
    if (copied.length > 0) log.info(`Copied ${copied.join(", ")} from ${legacyDir} to ${stateDir}.`);
  } catch (error) {
    log.debug(`Could not migrate ${legacyDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
