// Command-line parsing for the relay.
import path from "node:path";
import { parseArgs } from "node:util";
import { isLoopbackAddress, parseHostPort, parsePort, type HostPort } from "./network.ts";
import { STATE_DIR_DESCRIPTIONS } from "./paths.ts";
import { normalizeOrigin } from "./security.ts";

export const DEFAULT_PORT = 8686;
export const DEFAULT_ADB_SERVER: HostPort = { host: "127.0.0.1", port: 5037 };

export interface RelayOptions {
  port: number;
  /** Address the server binds to. */
  host: string;
  /** Only loopback clients can connect (enables the DNS-rebinding Host check). */
  loopbackOnly: boolean;
  /** Reachable from other devices: implies HTTPS and a mandatory token. */
  lan: boolean;
  https: boolean;
  /** User-supplied certificate (PEM file paths); otherwise self-signed. */
  certFile?: string;
  keyFile?: string;
  adb: HostPort;
  /**
   * Whether `adb start-server` may be run when nothing listens at `adb`.
   * Off for an explicit --adb on a non-default port: starting a second adb
   * server there would fight the usual one for the USB devices.
   */
  autoStartAdb: boolean;
  /** Normalized extra origins allowed to open the tunnel. */
  allowOrigins: string[];
  tokenRequired: boolean;
  verbose: boolean;
  distDir: string;
  /** Open the app in the default browser once listening (unless --no-open). */
  open: boolean;
  /**
   * Check the npm registry for new versions (unless --no-update-check).
   * update.ts also turns checks off for $CI, DEXTEROUS_NO_UPDATE_CHECK and
   * copies running from a clone.
   */
  updateCheck: boolean;
}

/** A user error in the command line; printed without a stack trace. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The --help text. `stateDir` is the state directory in use. */
export function formatUsage(stateDir: string): string {
  const defaultDirs = STATE_DIR_DESCRIPTIONS.map(([platform, dir]) => `  ${platform.padEnd(26)}${dir}`).join("\n");
  return `DeXterous: run Samsung DeX from your Galaxy phone in any web browser.
This relay serves the DeXterous app and tunnels it to your local adb server.

Usage:
  dexterous [options]
  dexterous update [--check]  Install the latest version (--check: only check)
  npm start -- [options]

Options:
  -p, --port <n>            Port to listen on (default: ${DEFAULT_PORT}, or $PORT)
      --host <addr>         Address to bind (default: 127.0.0.1, or 0.0.0.0 with --lan).
                            A non-loopback address implies --lan.
      --lan                 Let other devices on your network connect: binds all
                            interfaces, serves HTTPS with a self-signed certificate
                            and requires the access token
      --https               Serve HTTPS on localhost too
      --cert <file>         TLS certificate (PEM) to use instead of the self-signed
                            one, e.g. from mkcert or \`tailscale cert\` (needs --key)
      --key <file>          Private key (PEM) for --cert
      --adb <host:port>     adb server address (default: 127.0.0.1:5037,
                            or $ADB_SERVER_SOCKET / $ANDROID_ADB_SERVER_PORT).
                            If no server is running on the default address, the
                            relay starts one with \`adb start-server\`.
      --allow-origin <url>  Also accept tunnel connections from pages on this origin,
                            e.g. a reverse proxy such as https://my-pc.tailnet.ts.net
                            (repeatable; implies --require-token)
      --require-token       Require the access token on localhost too
      --dist <dir>          Directory containing the built web app
                            (default: the dist/ folder that ships with DeXterous)
      --no-open             Don't open the app in your browser at startup (it is
                            not opened anyway when $CI is set, when the output is
                            not a terminal, or on Linux without a graphical display)
      --no-update-check     Don't check for new versions. DeXterous otherwise asks
                            the npm registry about once a day (not when $CI is set,
                            or when it runs from a clone of the repository)
  -v, --verbose             Log every tunnel connection
  -V, --version             Print the version and exit
  -h, --help                Show this help

Environment:
  PORT                      Default for --port
  ADB_SERVER_SOCKET         adb server address in adb's format, e.g. tcp:127.0.0.1:5037
  ANDROID_ADB_SERVER_PORT   adb server port on 127.0.0.1
  DEXTEROUS_TOKEN           Use this access token instead of the generated one
  DEXTEROUS_HOME            Folder for the files below, instead of the default
  DEXTEROUS_NO_UPDATE_CHECK Set to 1 to turn off update checks (like --no-update-check)
  DEXTEROUS_UPDATE_REGISTRY npm registry to check for updates
                            (default: https://registry.npmjs.org)

Files (created on first use, keep them private):
  token                     Access token (also used in the #token=... link)
  cert.pem                  Self-signed certificate for --lan / --https
  key.pem                   Its private key
  update-check.json         When the last update check ran, and its result
  update.log                npm's output from the last update installed from the page
They are kept in $DEXTEROUS_HOME if set, otherwise in a per-user folder:
${defaultDirs}
In use now: ${stateDir}
`;
}

/**
 * Parses argv into options. Returns "help" / "version" when --help /
 * --version was given. `packageRoot` locates the default dist/ folder.
 * Throws UsageError for invalid input.
 */
export function parseOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  packageRoot: string,
): RelayOptions | "help" | "version" {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string", short: "p" },
        host: { type: "string" },
        lan: { type: "boolean" },
        https: { type: "boolean" },
        cert: { type: "string" },
        key: { type: "string" },
        adb: { type: "string" },
        "allow-origin": { type: "string", multiple: true },
        "require-token": { type: "boolean" },
        dist: { type: "string" },
        "no-open": { type: "boolean" },
        "no-update-check": { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        version: { type: "boolean", short: "V" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) return "help";
  if (values.version) return "version";

  const portText = values.port ?? env.PORT ?? String(DEFAULT_PORT);
  const port = parsePort(portText.trim());
  if (port === undefined) {
    throw new UsageError(`Invalid port "${portText}" (expected a number from 1 to 65535).`);
  }

  // Brackets are URL syntax, not part of the address: "[::1]" -> "::1".
  const host = (values.host ?? (values.lan ? "0.0.0.0" : "127.0.0.1")).trim().replace(/^\[(.*)\]$/, "$1");
  if (host === "") throw new UsageError("--host must not be empty.");
  const loopbackOnly = isLoopbackAddress(host);
  // Binding anything other than loopback exposes the phone to the network, so
  // it always gets the LAN protections (HTTPS + token).
  const lan = values.lan === true || !loopbackOnly;

  if ((values.cert === undefined) !== (values.key === undefined)) {
    throw new UsageError("--cert and --key must be used together.");
  }

  const allowOrigins = (values["allow-origin"] ?? []).map((origin) => {
    const normalized = normalizeOrigin(origin);
    if (normalized === undefined) {
      throw new UsageError(
        `Invalid --allow-origin "${origin}" (expected an http:// or https:// origin such as https://my-pc.example.com).`,
      );
    }
    return normalized;
  });

  const adb = resolveAdbServer(values.adb, env);

  return {
    port,
    host,
    loopbackOnly,
    lan,
    https: lan || values.https === true || values.cert !== undefined,
    certFile: values.cert === undefined ? undefined : path.resolve(values.cert),
    keyFile: values.key === undefined ? undefined : path.resolve(values.key),
    adb,
    autoStartAdb: values.adb === undefined || adb.port === DEFAULT_ADB_SERVER.port,
    allowOrigins,
    // An allowed origin usually means a reverse proxy (e.g. `tailscale serve`)
    // in front of the relay. Proxied clients connect from loopback, so the
    // token is the only thing keeping other people out.
    tokenRequired: lan || values["require-token"] === true || allowOrigins.length > 0,
    verbose: values.verbose === true,
    distDir: path.resolve(values.dist ?? path.join(packageRoot, "dist")),
    open: values["no-open"] !== true,
    updateCheck: values["no-update-check"] !== true,
  };
}

/** --adb flag, then ADB_SERVER_SOCKET, then ANDROID_ADB_SERVER_PORT, then the default. */
function resolveAdbServer(flag: string | undefined, env: NodeJS.ProcessEnv): HostPort {
  const defaultHost = DEFAULT_ADB_SERVER.host;

  if (flag !== undefined) {
    const parsed = parseHostPort(flag, defaultHost);
    if (!parsed) throw new UsageError(`Invalid --adb "${flag}" (expected host:port, e.g. 127.0.0.1:5037).`);
    return parsed;
  }

  const socketSpec = env.ADB_SERVER_SOCKET?.trim();
  if (socketSpec) {
    const parsed = socketSpec.startsWith("tcp:")
      ? parseHostPort(socketSpec.slice("tcp:".length), defaultHost)
      : undefined;
    if (!parsed) {
      throw new UsageError(
        `Unsupported ADB_SERVER_SOCKET "${socketSpec}" (only tcp:host:port is supported). Use --adb host:port instead.`,
      );
    }
    return parsed;
  }

  const portSpec = env.ANDROID_ADB_SERVER_PORT?.trim();
  if (portSpec) {
    const port = parsePort(portSpec);
    if (port === undefined) throw new UsageError(`Invalid ANDROID_ADB_SERVER_PORT "${portSpec}".`);
    return { host: defaultHost, port };
  }

  return { ...DEFAULT_ADB_SERVER };
}
