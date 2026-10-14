// Update checks and self-updates.
//
// The relay asks the npm registry for the `latest` version of DeXterous on
// startup and then about once a day. The answer is cached in the state
// directory (update-check.json), so most starts don't touch the network. The
// request is a plain GET of the package's dist-tags: no identifiers, no
// version, nothing about your computer. Checks are off with --no-update-check
// or DEXTEROUS_NO_UPDATE_CHECK=1, when $CI is set, and when running from a
// clone (`npm run relay`, `npm start`, `npm install -g .`).
//
// How DeXterous was installed decides what an update looks like:
//   global      `npm install -g @subsneaker/dexterous`: the relay can run
//               that again itself, if npm is found and its global folder is
//               writable (not, e.g., system Node on Linux that needs sudo)
//   npx         npm's npx cache: `npx @subsneaker/dexterous@latest`
//   source      a clone, linked or not: `git pull && npm install`
//   dependency  a project's node_modules: `npm install @subsneaker/dexterous@latest`
//   other       anything else (pnpm, yarn or bun included): a command to run by hand
//
// A self-update (POST /api/update or `dexterous update`) only ever runs
// `npm install -g @subsneaker/dexterous@latest`, with --prefix set to the
// global folder this copy was found in, and --engine-strict so a version that
// needs a newer Node.js is refused. From the page, npm runs in the background
// (its own process group, output in update.log in the state directory), so
// Ctrl+C can't interrupt it halfway. Afterwards the relay exits with
// RESTART_EXIT_CODE, and bin/dexterous.js (the supervisor) starts the new
// version in the same terminal.
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { log, paint } from "./log.ts";
import { readPackageVersion } from "./paths.ts";
import { ensurePrivateDir, readOptionalFile, writePrivateFile } from "./storage.ts";

export const PACKAGE_NAME = "@subsneaker/dexterous";
/** The relay exits with this code to ask bin/dexterous.js for a restart (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;
/** Set by bin/dexterous.js on the relay it starts (and only there). */
export const SUPERVISOR_ENV = "DEXTEROUS_SUPERVISOR";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const NOTES_URL = "https://github.com/SubSneaker/DeXterous/blob/main/CHANGELOG.md";
const CACHE_FILE = "update-check.json";
const LOG_FILE = "update.log";
/** A successful check is good for this long (shared by every running relay). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed check (e.g. offline), try again this much later. */
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** How often a running relay looks at the cache to see if a check is due. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** Long enough for a polling page to see "restarting" before the relay goes away. */
const RESTART_DELAY_MS = 1500;
const GLOBAL_INSTALL_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

const isWindows = process.platform === "win32";

export type InstallKind = "global" | "npx" | "source" | "dependency" | "other";
export type UpdateState = "idle" | "installing" | "restarting" | "failed";

/** The `update` field of /api/info. Keep in sync with the web app. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  canSelfUpdate: boolean;
  command: string;
  notesUrl: string;
  state: UpdateState;
  error?: string;
}

export interface InstallInfo {
  kind: InstallKind;
  /** What to run by hand to update this copy. */
  command: string;
  /** Where to run `command`, when that matters (a clone or a project). */
  directory?: string;
  /** npm can update this copy in place (ignores whether a supervisor is running). */
  canInstall: boolean;
  /** Why npm can't, in plain language, when `kind` is "global" or "other". */
  problem?: string;
  /** How to run npm. */
  npm?: NpmCommand;
  /**
   * npm's global prefix this copy lives under. The update is installed there
   * explicitly (`--prefix`), so it replaces this copy even if npm's own
   * settings have changed since.
   */
  prefix?: string;
}

/**
 * Where this copy lives, from the path alone. `packageRoot` is the folder
 * holding package.json; `moduleFile` is the running relay module (a .ts file
 * means `npm run relay` from a clone). A global install is recognized by
 * npm's global layout: <prefix>/lib/node_modules/@subsneaker/dexterous with
 * the command in <prefix>/bin (on Windows: <prefix>/node_modules/... with
 * <prefix>/dexterous.cmd).
 */
export function classifyInstall(packageRoot: string, moduleFile: string): {
  kind: InstallKind;
  /** npm's global prefix, for a global install. */
  prefix?: string;
  /** The project folder, for a dependency. */
  project?: string;
  /** Another package manager's global folder. */
  manager?: "pnpm" | "yarn" | "bun";
  realRoot: string;
} {
  const realRoot = realpath(packageRoot);
  if (moduleFile.endsWith(".ts")) return { kind: "source", realRoot };
  const segments = realRoot.split(/[\\/]/);
  if (segments.includes("_npx")) return { kind: "npx", realRoot };
  if (segments.includes(".pnpm")) return { kind: "other", manager: "pnpm", realRoot };
  if (segments.includes(".bun")) return { kind: "other", manager: "bun", realRoot };
  if (segments.some((segment, i) => segment.toLowerCase() === "yarn" && segments[i + 1] === "global")) {
    return { kind: "other", manager: "yarn", realRoot };
  }
  // A clone, or one linked with `npm install -g .` (the link resolves to it).
  if (!segments.includes("node_modules") || fs.existsSync(path.join(realRoot, ".git"))) {
    return { kind: "source", realRoot };
  }
  // <node_modules>/@subsneaker/dexterous
  const nodeModules = path.dirname(path.dirname(realRoot));
  if (path.basename(nodeModules) !== "node_modules") return { kind: "other", realRoot };
  const prefix = isWindows ? path.dirname(nodeModules) : path.dirname(path.dirname(nodeModules));
  const command = isWindows ? path.join(prefix, "dexterous.cmd") : path.join(prefix, "bin", "dexterous");
  if ((isWindows || path.basename(path.dirname(nodeModules)) === "lib") && fs.existsSync(command)) {
    return { kind: "global", prefix, realRoot };
  }
  const project = path.dirname(nodeModules);
  if (fs.existsSync(path.join(project, "package.json"))) return { kind: "dependency", project, realRoot };
  return { kind: "other", realRoot };
}

/**
 * Works out how this copy can be updated: for a global install, whether npm
 * is there and can write to the global folder without sudo.
 */
export function inspectInstall(packageRoot: string, moduleFile: string): InstallInfo {
  const { kind, prefix, project, manager, realRoot } = classifyInstall(packageRoot, moduleFile);
  if (kind === "npx") return { kind, command: `npx ${PACKAGE_NAME}@latest`, canInstall: false };
  if (kind === "source") {
    return { kind, command: "git pull && npm install", directory: realRoot, canInstall: false };
  }
  if (kind === "dependency") {
    return { kind, command: `npm install ${PACKAGE_NAME}@latest`, directory: project, canInstall: false };
  }
  if (manager) {
    const command = {
      pnpm: `pnpm add -g ${PACKAGE_NAME}@latest`,
      yarn: `yarn global add ${PACKAGE_NAME}@latest`,
      bun: `bun add -g ${PACKAGE_NAME}@latest`,
    }[manager];
    return { kind: "other", command, canInstall: false, problem: `DeXterous was installed with ${manager}.` };
  }
  if (kind === "other" || !prefix) {
    return { kind: "other", command: GLOBAL_INSTALL_COMMAND, canInstall: false, problem: "DeXterous isn't in npm's global folder." };
  }

  const npm = findNpm();
  if (!npm) {
    return { kind, command: GLOBAL_INSTALL_COMMAND, canInstall: false, problem: "npm wasn't found." };
  }
  // npm replaces the package folder and its link in <prefix>/bin.
  const nodeModules = path.dirname(path.dirname(realRoot));
  const mustWrite = [nodeModules, path.dirname(realRoot), realRoot, isWindows ? prefix : path.join(prefix, "bin")];
  if (mustWrite.some((dir) => !isWritable(dir))) {
    return {
      kind,
      command: isWindows ? GLOBAL_INSTALL_COMMAND : `sudo ${GLOBAL_INSTALL_COMMAND}`,
      canInstall: false,
      problem: `npm's global folder (${prefix}) needs administrator rights to change.`,
      npm,
    };
  }
  return { kind, command: GLOBAL_INSTALL_COMMAND, canInstall: true, npm, prefix };
}

/** Why automatic update checks are off, or undefined if they are on. */
export function updateCheckBlocker(flagEnabled: boolean, env: NodeJS.ProcessEnv, kind: InstallKind): string | undefined {
  if (!flagEnabled) return "--no-update-check";
  if (isSet(env.DEXTEROUS_NO_UPDATE_CHECK)) return "DEXTEROUS_NO_UPDATE_CHECK is set";
  if (isSet(env.CI)) return "CI is set";
  if (kind === "source") return "running from a clone";
  return undefined;
}

/**
 * Compares two versions by semver precedence: <0, 0 or >0. Assumes both
 * match VERSION_PATTERN.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): [number[], string[]] => {
    const [core, pre = ""] = version.split("+")[0].split(/-(.*)/s);
    return [core.split(".").map(Number), pre === "" ? [] : pre.split(".")];
  };
  const [coreA, preA] = parse(a);
  const [coreB, preB] = parse(b);
  for (let i = 0; i < 3; i++) {
    if (coreA[i] !== coreB[i]) return coreA[i] - coreB[i];
  }
  // A release ranks above its prereleases.
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const [x, y] = [preA[i], preB[i]];
    if (x === y) continue;
    const [numX, numY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numX && numY) return Number(x) - Number(y);
    if (numX !== numY) return numX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return preA.length - preB.length;
}

/**
 * Asks the registry for the `latest` dist-tag. Throws on any failure
 * (offline, timeout, unexpected answer). The request carries no
 * identifying headers (only `Accept`, plus what Node's fetch always sends).
 */
export async function fetchLatestVersion(
  registry: string = registryUrl(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string> {
  const url = `${registry.replace(/\/+$/, "")}/-/package/${PACKAGE_NAME.replace("/", "%2f")}/dist-tags`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 404) throw new Error(`the registry doesn't list ${PACKAGE_NAME}`);
  if (!response.ok) throw new Error(`the registry answered ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("the registry's answer is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("the registry's answer is too large");
  const latest = (JSON.parse(text) as { latest?: unknown }).latest;
  if (typeof latest !== "string" || !VERSION_PATTERN.test(latest)) {
    throw new Error("the registry's answer has no valid latest version");
  }
  return latest;
}

interface CheckCache {
  /** When the registry last answered (ms since the epoch). */
  checkedAt?: number;
  latest?: string;
  /** When the last attempt failed. */
  failedAt?: number;
}

export interface UpdateManagerInit {
  current: string;
  stateDir: string;
  packageRoot: string;
  moduleFile: string;
  /** bin/dexterous.js is watching and restarts the relay on RESTART_EXIT_CODE. */
  supervised: boolean;
  /** Called once a new version is installed: stop and exit with RESTART_EXIT_CODE. */
  restart: () => void;
  fetchImpl?: typeof fetch;
}

/** Background update checks plus the state behind /api/info and /api/update. */
export class UpdateManager {
  readonly #init: UpdateManagerInit;
  #install: InstallInfo | undefined;
  #latest: string | null = null;
  #announced: string | undefined;
  #state: UpdateState = "idle";
  #error: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** The running install, if any. */
  #installing: Promise<void> | undefined;
  /** Set when DeXterous is asked to stop during an install: don't restart. */
  #stopAfterInstall = false;

  constructor(init: UpdateManagerInit) {
    this.#init = init;
  }

  /** Starts checking in the background. Never throws and never blocks. */
  start(): void {
    try {
      this.#install = inspectInstall(this.#init.packageRoot, this.#init.moduleFile);
    } catch (error) {
      log.debug(`Could not inspect the installation: ${describe(error)}`);
      this.#install = { kind: "other", command: GLOBAL_INSTALL_COMMAND, canInstall: false };
    }
    log.debug(`Install kind: ${this.#install.kind}${this.#install.problem ? ` (${this.#install.problem})` : ""}.`);
    const tick = (): void => {
      this.#checkIfDue()
        .then(() => this.#announce())
        .catch((error: unknown) => log.debug(`Update check failed: ${describe(error)}`));
    };
    tick();
    this.#timer = setInterval(tick, POLL_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  get canSelfUpdate(): boolean {
    return this.#init.supervised && this.#install?.canInstall === true && this.#install.npm !== undefined;
  }

  get available(): boolean {
    return this.#latest !== null && compareVersions(this.#latest, this.#init.current) > 0;
  }

  get state(): UpdateState {
    return this.#state;
  }

  /** The `update` field of /api/info. */
  info(): UpdateInfo {
    const info: UpdateInfo = {
      current: this.#init.current,
      latest: this.#latest,
      available: this.available,
      canSelfUpdate: this.canSelfUpdate,
      command: this.#install?.command ?? GLOBAL_INSTALL_COMMAND,
      notesUrl: NOTES_URL,
      state: this.#state,
    };
    if (this.#state === "failed" && this.#error) info.error = this.#error;
    return info;
  }

  /**
   * Installs the latest version in the background, then restarts. The
   * caller has checked canSelfUpdate and available.
   */
  install(): void {
    const { npm, prefix } = this.#install ?? {};
    if (this.#state === "installing" || this.#state === "restarting" || !npm || !prefix) return;
    this.#state = "installing";
    this.#error = undefined;
    log.info(`Updating DeXterous to ${this.#latest ?? "the latest version"}: running ${GLOBAL_INSTALL_COMMAND}...`);
    const logFile = path.join(this.#init.stateDir, LOG_FILE);
    this.#installing = runNpm(npm, installArgs(prefix), { timeoutMs: INSTALL_TIMEOUT_MS, logFile }).then(
      (result) => {
        if (result.code !== 0) {
          this.#fail(describeNpmFailure(result), result.output);
          return;
        }
        const installed = readPackageVersion(this.#init.packageRoot);
        if (!VERSION_PATTERN.test(installed) || compareVersions(installed, this.#init.current) <= 0) {
          this.#fail(
            `npm finished, but DeXterous is still version ${this.#init.current}. Run \`${GLOBAL_INSTALL_COMMAND}\` in a terminal to see why.`,
            result.output,
          );
          return;
        }
        if (this.#stopAfterInstall) {
          this.#state = "idle";
          log.info(paint("green", `Updated DeXterous to ${installed}. The new version starts next time.`));
          return;
        }
        this.#state = "restarting";
        log.info(paint("green", `Updated DeXterous to ${installed}. Restarting...`));
        setTimeout(() => this.#init.restart(), RESTART_DELAY_MS).unref();
      },
      (error: unknown) => this.#fail(`Couldn't run npm: ${describe(error)}`, ""),
    );
  }

  /**
   * For stopping DeXterous during an install: lets npm finish (stopping it
   * halfway could leave a broken install) and skips the restart. Resolves
   * once npm is done.
   */
  finishInstall(): Promise<void> {
    this.#stopAfterInstall = true;
    return this.#installing ?? Promise.resolve();
  }

  #fail(message: string, output: string): void {
    this.#state = "failed";
    this.#error = message;
    log.warn(`The update failed: ${message}`);
    const tail = output.trim().split(/\r?\n/).slice(-15).join("\n");
    if (tail) console.error(tail);
  }

  /** Checks unless the cache (shared with other relays) is recent enough. */
  async #checkIfDue(): Promise<void> {
    const cache = this.#readCache();
    if (cache.latest && VERSION_PATTERN.test(cache.latest)) this.#latest = cache.latest;
    const now = Date.now();
    const within = (time: number | undefined, ms: number): boolean => time !== undefined && now >= time && now - time < ms;
    if (within(cache.checkedAt, CHECK_INTERVAL_MS) || within(cache.failedAt, RETRY_AFTER_FAILURE_MS)) return;
    await this.#check();
  }

  async #check(): Promise<void> {
    try {
      const latest = await fetchLatestVersion(registryUrl(), this.#init.fetchImpl);
      this.#latest = latest;
      this.#writeCache({ checkedAt: Date.now(), latest });
      log.debug(`Update check: the latest version is ${latest}.`);
    } catch (error) {
      // Offline, a firewall, an unpublished package...: not worth a warning.
      log.debug(`Update check failed: ${describe(error)}`);
      this.#writeCache({ ...this.#readCache(), failedAt: Date.now() });
    }
  }

  /** Prints one line per newly seen version. */
  #announce(): void {
    if (!this.available || !this.#latest || this.#latest === this.#announced || !this.#install) return;
    this.#announced = this.#latest;
    const how = this.canSelfUpdate
      ? "use the update button on the DeXterous page, or stop DeXterous and run `dexterous update`"
      : this.#install.canInstall
        ? "stop DeXterous and run `dexterous update`"
        : `run \`${this.#install.command}\`${this.#install.directory ? ` in ${this.#install.directory}` : ""}`;
    log.info(
      paint("yellow", `DeXterous ${this.#latest} is available (you have ${this.#init.current}). To update, ${how}.`),
    );
  }

  #readCache(): CheckCache {
    try {
      const text = readOptionalFile(path.join(this.#init.stateDir, CACHE_FILE));
      const value: unknown = text === undefined ? undefined : JSON.parse(text);
      if (!value || typeof value !== "object") return {};
      const { checkedAt, latest, failedAt } = value as Record<string, unknown>;
      return {
        checkedAt: typeof checkedAt === "number" ? checkedAt : undefined,
        latest: typeof latest === "string" ? latest : undefined,
        failedAt: typeof failedAt === "number" ? failedAt : undefined,
      };
    } catch {
      return {};
    }
  }

  #writeCache(cache: CheckCache): void {
    try {
      ensurePrivateDir(this.#init.stateDir);
      writePrivateFile(path.join(this.#init.stateDir, CACHE_FILE), `${JSON.stringify(cache)}\n`);
    } catch (error) {
      log.debug(`Could not save the update check: ${describe(error)}`);
    }
  }
}

/**
 * `dexterous update [--check]`. Returns the exit code (never
 * RESTART_EXIT_CODE).
 */
export async function runUpdateCommand(
  argv: string[],
  init: { current: string; packageRoot: string; moduleFile: string },
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (error) {
    log.error(describe(error));
    console.error("Usage: dexterous update [--check]");
    return 2;
  }
  if (values.help) {
    process.stdout.write(`Usage: dexterous update [--check]

Installs the latest version of DeXterous with
  ${GLOBAL_INSTALL_COMMAND}
or explains how to update when DeXterous wasn't installed that way.

  --check    Only check for a new version
`);
    return 0;
  }

  console.log(`Checking for a new version of DeXterous (you have ${init.current})...`);
  const install = inspectInstall(init.packageRoot, init.moduleFile);
  const latest = await fetchLatestVersion().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (latest instanceof Error) {
    const offline = latest.name === "TimeoutError" || latest.name === "AbortError" || latest.message === "fetch failed";
    log.error(
      offline
        ? "Couldn't reach the npm registry. Check your internet connection and try again."
        : `Couldn't get the latest version from the npm registry: ${describe(latest)}.`,
    );
    return 1;
  }
  if (compareVersions(latest, init.current) <= 0) {
    console.log(`You have the latest version (${init.current}).`);
    return 0;
  }
  console.log(`DeXterous ${latest} is available. What's new: ${NOTES_URL}`);
  const where = install.directory ? ` in ${install.directory}` : "";
  if (values.check) {
    console.log(install.canInstall ? "Run `dexterous update` to install it." : `To update, run \`${install.command}\`${where}.`);
    return 0;
  }
  if (!install.canInstall || !install.npm || !install.prefix) {
    console.log(manualUpdateAdvice(install));
    return 1;
  }

  console.log(`Running ${GLOBAL_INSTALL_COMMAND}...`);
  const result = await runNpm(install.npm, installArgs(install.prefix), {
    timeoutMs: INSTALL_TIMEOUT_MS,
    showOutput: true,
  }).catch((error: unknown) => ({ code: -1, output: describe(error), timedOut: false }));
  if (result.code !== 0) {
    log.error(describeNpmFailure(result));
    return 1;
  }
  const installed = readPackageVersion(init.packageRoot);
  if (!VERSION_PATTERN.test(installed) || compareVersions(installed, init.current) <= 0) {
    log.error(`npm finished, but DeXterous is still version ${init.current}.`);
    return 1;
  }
  console.log(paint("green", `DeXterous ${installed} is installed.`) + " If DeXterous is running, stop it with Ctrl+C and start it again.");
  return 0;
}

function manualUpdateAdvice(install: InstallInfo): string {
  const where = install.directory ? ` in ${install.directory}` : "";
  switch (install.kind) {
    case "npx":
      return `You're running DeXterous through npx. Start it with \`${install.command}\` to get the new version.`;
    case "source":
      return `This copy of DeXterous runs from a clone of the repository. To update it, run \`${install.command}\`${where}.`;
    case "dependency":
      return `DeXterous is installed inside a project. To update it, run \`${install.command}\`${where}.`;
    default:
      return `${install.problem ?? "DeXterous can't update itself here."} To update, run \`${install.command}\` yourself.`;
  }
}

/**
 * `npm install -g @subsneaker/dexterous@latest`, into this copy's prefix.
 * --engine-strict makes npm refuse a version this Node.js can't run.
 */
function installArgs(prefix: string): string[] {
  return ["install", "--global", "--prefix", prefix, "--engine-strict", `${PACKAGE_NAME}@latest`];
}

/** How to run npm: `file` with `args` before npm's own arguments. */
export interface NpmCommand {
  file: string;
  args: string[];
  /** Windows .cmd fallback, which only runs through cmd.exe. */
  shell: boolean;
}

interface NpmResult {
  code: number;
  output: string;
  timedOut: boolean;
}

/**
 * Runs npm with fixed arguments. Output is collected, and shown as it comes
 * with `showOutput`. With `logFile`, npm gets its own process group and
 * writes to that file instead, so Ctrl+C in the terminal doesn't reach it and
 * it isn't cut off if the relay has to exit.
 */
function runNpm(
  npm: NpmCommand,
  args: string[],
  options: { timeoutMs: number; showOutput?: boolean; logFile?: string },
): Promise<NpmResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    };
    delete env[SUPERVISOR_ENV];
    let logFd: number | undefined;
    if (options.logFile) {
      ensurePrivateDir(path.dirname(options.logFile));
      logFd = fs.openSync(options.logFile, "w", 0o600);
    }
    const stdio: StdioOptions = logFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", logFd, logFd];
    const spawnOptions = { env, stdio, detached: logFd !== undefined, windowsHide: true };
    let child: ChildProcess;
    try {
      child = npm.shell
        ? // One command string (no argument array): cmd.exe needs quotes around
          // paths with spaces. The arguments are fixed, apart from paths, which
          // can't contain quotes on Windows.
          spawn([npm.file, ...npm.args, ...args].map((arg) => `"${arg}"`).join(" "), { ...spawnOptions, shell: true })
        : spawn(npm.file, [...npm.args, ...args], spawnOptions);
    } finally {
      if (logFd !== undefined) fs.closeSync(logFd);
    }
    let output = "";
    const collect = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      if (options.showOutput) stream.write(chunk);
      output = (output + chunk.toString("utf8")).slice(-32 * 1024);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, process.stderr));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (options.logFile) output = (readOptionalFile(options.logFile) ?? "").slice(-32 * 1024);
      resolve({ code: code ?? -1, output, timedOut });
    });
  });
}

/** A plain-language reason for a failed `npm install -g`. */
function describeNpmFailure(result: NpmResult): string {
  const manual = `Run \`${GLOBAL_INSTALL_COMMAND}\` in a terminal to see what went wrong.`;
  if (result.timedOut) return `npm took too long to install the update. ${manual}`;
  const output = result.output;
  if (/\bEBADENGINE\b/.test(output)) {
    return `The new version needs a newer Node.js than this one (${process.version}). Update Node.js first, then try again.`;
  }
  if (/\b(EACCES|EPERM)\b/.test(output)) {
    return `npm isn't allowed to change its global folder. Run \`${isWindows ? "" : "sudo "}${GLOBAL_INSTALL_COMMAND}\` in a terminal instead.`;
  }
  if (/\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH)\b/.test(output)) {
    return "npm couldn't reach the npm registry. Check your internet connection and try again.";
  }
  if (/\bENOSPC\b/.test(output)) return "The disk is full. Free up some space and try again.";
  if (/\bETARGET\b|\bE404\b/.test(output)) return `npm couldn't find the new version on the registry yet. Try again in a few minutes.`;
  return `npm couldn't install the update (exit code ${result.code}). ${manual}`;
}

/**
 * npm, run with this Node.js: the npm that ships with it (npm-cli.js next to
 * the node executable), so no shell or PATH lookup is involved. Otherwise the
 * first npm on PATH (on Windows, npm.cmd through cmd.exe).
 */
function findNpm(env: NodeJS.ProcessEnv = process.env): NpmCommand | undefined {
  const nodeDir = path.dirname(process.execPath);
  const cli = isWindows
    ? path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (isFile(cli)) return { file: process.execPath, args: [cli], shell: false };

  const name = isWindows ? "npm.cmd" : "npm";
  for (const dir of [nodeDir, ...(env.PATH ?? "").split(path.delimiter)]) {
    if (dir && isFile(path.join(dir, name))) return { file: path.join(dir, name), args: [], shell: isWindows };
  }
  return undefined;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.DEXTEROUS_UPDATE_REGISTRY?.trim();
  return custom && /^https?:\/\//i.test(custom) ? custom : DEFAULT_REGISTRY;
}

/** Same convention as $CI in open.ts: set, and not "0" or "false". */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
