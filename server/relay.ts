// DeXterous relay.
//
// Serves the built web app and exposes the local adb server to it over a
// WebSocket (/adb), so browsers without WebUSB (or a phone already claimed by
// the system adb server) can still run DeXterous. Start with:
//
//   dexterous [--lan] [--port 8686] ...              (installed; see --help)
//   node server/relay.ts [--lan] [--port 8686] ...   (from a clone, unbuilt)
//
// `npm run build` compiles this file to build/server/relay.js, which is what
// bin/dexterous.js runs (and starts again after a self-update, see update.ts).
import fs from "node:fs";
import http, { STATUS_CODES } from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { ensureAdbServer, isAdbServerReachable, type AdbStartupStatus } from "./adb.ts";
import {
  collectCertificateNames,
  ensureSelfSignedCertificate,
  loadCustomCertificate,
  type TlsMaterial,
} from "./cert.ts";
import {
  SECURITY_HEADERS,
  applySecurityHeaders,
  sendJson,
  sendRawError,
  sendText,
} from "./http-utils.ts";
import { log, paint, setVerbose } from "./log.ts";
import {
  formatHost,
  isMacFirewallBlockingAll,
  isWildcardAddress,
  listLanIPv4Addresses,
} from "./network.ts";
import { autoOpenBlocker, openInBrowser } from "./open.ts";
import { formatUsage, parseOptions, UsageError, type RelayOptions } from "./options.ts";
import {
  findPackageRoot,
  migrateLegacyState,
  readPackageVersion as readVersionFrom,
  resolveStateDir,
} from "./paths.ts";
import {
  checkHost,
  checkTunnelOrigin,
  checkTunnelToken,
  checkUpdateRequest,
  isLocalRequest,
  createAccessPolicy,
  loadOrCreateToken,
  parseHostHeader,
  type AccessPolicy,
} from "./security.ts";
import { createStaticHandler } from "./static.ts";
import { TunnelManager } from "./tunnel.ts";
import {
  RESTART_EXIT_CODE,
  SUPERVISOR_ENV,
  UpdateManager,
  classifyInstall,
  runUpdateCommand,
  updateCheckBlocker,
} from "./update.ts";

/** The installed package (or the clone): holds package.json and dist/. */
const PACKAGE_ROOT = findPackageRoot(import.meta.dirname);
/** Per-user folder for the token and certificate (see paths.ts). */
const DATA_DIR = resolveStateDir();
const TUNNEL_PATH = "/adb";
const INFO_PATH = "/api/info";
const UPDATE_PATH = "/api/update";
/** Generous: a DeX session uses a handful of adb sockets at a time. */
const MAX_TUNNELS = 256;
/** Caps sockets per listener so a LAN client cannot exhaust file descriptors. */
const MAX_CONNECTIONS = 1024;
/** Large enough for any adb sync/push chunk the browser may send. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** A signal this soon after the first one is the same Ctrl+C, seen twice. */
const DUPLICATE_SIGNAL_MS = 500;

async function main(): Promise<void> {
  // Started by bin/dexterous.js, which restarts the relay after an update
  // and passes Ctrl+C (and other stop signals) on through the IPC channel.
  const supervised = process.env[SUPERVISOR_ENV] === "1" && typeof process.send === "function";
  delete process.env[SUPERVISOR_ENV];
  if (supervised) listenToSupervisor();

  const argv = process.argv.slice(2);
  if (argv[0] === "update") {
    process.exitCode = await runUpdateCommand(argv.slice(1), {
      current: readPackageVersion(),
      packageRoot: PACKAGE_ROOT,
      moduleFile: import.meta.filename,
    });
    return;
  }

  let options: RelayOptions | "help" | "version";
  try {
    options = parseOptions(argv, process.env, PACKAGE_ROOT);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      console.error("Run with --help to see the available options.");
      process.exit(2);
    }
    throw error;
  }
  if (options === "help") {
    process.stdout.write(formatUsage(DATA_DIR));
    return;
  }
  if (options === "version") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  setVerbose(options.verbose);

  migrateLegacyState(PACKAGE_ROOT, DATA_DIR);
  if (process.env.DEX_TOKEN && !process.env.DEXTEROUS_TOKEN) {
    log.warn("DEX_TOKEN is no longer used; rename it to DEXTEROUS_TOKEN.");
  }
  let tokenInfo: ReturnType<typeof loadOrCreateToken>;
  try {
    tokenInfo = loadOrCreateToken(DATA_DIR, process.env.DEXTEROUS_TOKEN);
  } catch (error) {
    log.error(
      `Cannot read or create the access token in ${DATA_DIR}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Check that folder's permissions, set DEXTEROUS_HOME to another folder, or set DEXTEROUS_TOKEN.",
    );
    process.exit(1);
  }
  if (tokenInfo.warning) log.warn(tokenInfo.warning);
  const policy = createAccessPolicy({
    loopbackOnly: options.loopbackOnly,
    bindHost: options.host,
    allowOrigins: options.allowOrigins,
    tokenRequired: options.tokenRequired,
    token: tokenInfo.token,
  });

  let tls: TlsMaterial | undefined;
  if (options.https) {
    try {
      tls = options.certFile && options.keyFile
        ? loadCustomCertificate(options.certFile, options.keyFile)
        : await ensureSelfSignedCertificate(
            DATA_DIR,
            collectCertificateNames(isWildcardAddress(options.host) ? [] : [options.host]),
          );
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  const updateBlocker = updateCheckBlocker(
    options.updateCheck,
    process.env,
    classifyInstall(PACKAGE_ROOT, import.meta.filename).kind,
  );
  let restart = (): void => {};
  const updater =
    updateBlocker === undefined
      ? new UpdateManager({
          current: readPackageVersion(),
          stateDir: DATA_DIR,
          packageRoot: PACKAGE_ROOT,
          moduleFile: import.meta.filename,
          supervised,
          restart: () => restart(),
        })
      : undefined;
  if (updateBlocker) log.debug(`Not checking for updates: ${updateBlocker}.`);

  const [adbStatus, firewallBlocksAll] = await Promise.all([
    ensureAdbServer(options.adb, options.autoStartAdb),
    options.lan ? isMacFirewallBlockingAll() : Promise.resolve(false),
  ]);
  const relay = createRelay(options, policy, tls, updater);

  try {
    await listen(relay.listener, options.port, options.host);
  } catch (error) {
    log.error(describeListenError(error, options));
    process.exit(1);
  }

  // Opened after listening so the page never races the server.
  const openBlocker = options.open ? autoOpenBlocker() : "--no-open";
  printBanner(options, tokenInfo.token, tls, adbStatus, openBlocker === undefined);
  if (openBlocker === undefined) {
    openInBrowser(localAppUrl(options, tokenInfo.token, tls));
  } else {
    log.debug(`Not opening a browser: ${openBlocker}.`);
  }
  if (firewallBlocksAll) {
    log.warn(
      "The macOS firewall is set to block all incoming connections, so other devices cannot reach the relay. " +
        "Turn that off in System Settings > Network > Firewall > Options.",
    );
  }
  const shutdown = installShutdownHandlers(relay);
  restart = () => {
    // Unless Ctrl+C got there first.
    if (!relay.isShuttingDown()) shutdown("Restarting with the new version...", RESTART_EXIT_CODE);
  };
  // In the background: the result is printed whenever it arrives.
  updater?.start();
}

interface Relay {
  /** The server bound to the port. */
  listener: net.Server;
  /** HTTP servers whose keep-alive connections must be closed on shutdown. */
  httpServers: http.Server[];
  tunnels: TunnelManager;
  heartbeat: NodeJS.Timeout;
  updater: UpdateManager | undefined;
  isShuttingDown(): boolean;
  beginShutdown(): void;
}

function createRelay(
  options: RelayOptions,
  policy: AccessPolicy,
  tls: TlsMaterial | undefined,
  updater: UpdateManager | undefined,
): Relay {
  const version = readPackageVersion();
  const serveStatic = createStaticHandler(options.distDir);
  const tunnels = new TunnelManager(options.adb);
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false, // video is already compressed; deflate only adds latency
    clientTracking: false, // TunnelManager tracks connections
    maxPayload: MAX_FRAME_BYTES,
  });
  // Keep the security headers on ws's own responses too.
  wss.on("headers", (headers) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.push(`${name}: ${value}`);
  });
  wss.on("wsClientError", (error, socket) => {
    sendRawError(socket, 400, `Bad WebSocket handshake: ${error.message}`);
  });
  let shuttingDown = false;

  const handleRequest: http.RequestListener = (req, res) => {
    applySecurityHeaders(res);
    const hostVerdict = checkHost(req, policy);
    if (!hostVerdict.ok) {
      sendText(res, hostVerdict.status, hostVerdict.reason);
      return;
    }
    const url = parseRequestTarget(req.url);
    if (!url) {
      sendText(res, 400, "Bad request.");
      return;
    }

    if (url.pathname === INFO_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed.", { Allow: "GET, HEAD" });
        return;
      }
      // Only a page on the computer running DeXterous can install updates (see
      // checkUpdateRequest), so other devices never see the option.
      const update = updater?.info();
      if (update && !isLocalRequest(req)) update.canSelfUpdate = false;
      void isAdbServerReachable(options.adb).then((adbReachable) => {
        // Never include the token itself. `update` is left out when update
        // checks are off.
        sendJson(res, 200, { relay: true, version, adbReachable, tokenRequired: policy.tokenRequired, update });
      });
      return;
    }
    if (url.pathname === UPDATE_PATH) {
      handleUpdateRequest(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (url.pathname === TUNNEL_PATH) {
      sendText(res, 426, "This endpoint only accepts WebSocket connections.", {
        Connection: "Upgrade",
        Upgrade: "websocket",
      });
      return;
    }

    serveStatic(req, res, url.pathname).catch((error: unknown) => {
      log.error(`Serving ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendText(res, 500, "Internal server error.");
      else res.destroy();
    });
  };

  // POST /api/update: install the latest version, then restart (update.ts).
  // No body or parameters: it can only ever install the latest DeXterous.
  const handleUpdateRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== "POST") {
      sendText(res, 405, "Method not allowed.", { Allow: "POST" });
      return;
    }
    req.resume(); // discard any body
    const verdict = checkUpdateRequest(req, policy);
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.reason });
      return;
    }
    if (!updater) {
      sendJson(res, 400, { error: "Update checks are turned off for this copy of DeXterous." });
      return;
    }
    if (updater.state === "installing" || updater.state === "restarting") {
      sendJson(res, 202, { state: updater.state });
      return;
    }
    if (shuttingDown) {
      sendJson(res, 409, { error: "DeXterous is shutting down." });
      return;
    }
    if (tunnels.dexTunnelCount > 0) {
      sendJson(res, 409, {
        error: "A DeX session is open. Disconnect it first, then update: DeXterous restarts afterwards.",
      });
      return;
    }
    const info = updater.info();
    if (!info.canSelfUpdate) {
      sendJson(res, 400, { error: `DeXterous can't update itself here. Run \`${info.command}\` in a terminal instead.` });
      return;
    }
    if (!info.available) {
      sendJson(res, 400, { error: "There's no new version to install." });
      return;
    }
    updater.install();
    sendJson(res, 202, { state: "installing" });
  };

  const rejections = new RejectionLogger();
  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Until ws takes over, make sure a client reset cannot crash the process.
    const onSocketError = (): void => {
      socket.destroy();
    };
    socket.on("error", onSocketError);

    const url = parseRequestTarget(req.url);
    if (!url || url.pathname !== TUNNEL_PATH) {
      sendRawError(socket, 404, "Not found.");
      return;
    }
    // Wrong Host or Origin: refuse before the handshake (HTTP 400/403).
    const verdict = checkTunnelOrigin(req, policy);
    if (!verdict.ok) {
      rejections.log(req, verdict.reason);
      sendRawError(socket, verdict.status, verdict.reason);
      return;
    }

    // The request comes from a legitimate same-origin page. Browsers hide the
    // HTTP status of a refused upgrade (the page only sees code 1006), so
    // remaining refusals complete the handshake and close immediately with a
    // code and reason the page can show. No adb connection is made for them.
    const tokenProblem = checkTunnelToken(url, policy);
    let refusal: { code: number; reason: string } | undefined;
    if (tokenProblem) {
      rejections.log(req, tokenProblem);
      refusal = { code: 4401, reason: tokenProblem };
    } else if (shuttingDown) {
      refusal = { code: 1001, reason: "The relay is shutting down." };
    } else if (updater?.state === "installing" || updater?.state === "restarting") {
      refusal = { code: 1012, reason: "DeXterous is updating. Try again in a moment." };
    } else if (tunnels.size >= MAX_TUNNELS) {
      refusal = { code: 1013, reason: "Too many open connections. Try again later." };
    }

    socket.off("error", onSocketError); // ws installs its own handler
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (refusal) {
        ws.on("error", () => ws.terminate());
        ws.close(refusal.code, refusal.reason);
        return;
      }
      tunnels.open(ws, req.socket.remoteAddress ?? "unknown");
    });
  };

  // Like Node's default handler for malformed requests, plus security headers.
  const handleClientError = (error: NodeJS.ErrnoException, socket: Duplex): void => {
    if (error.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    const status =
      error.code === "HPE_HEADER_OVERFLOW" ? 431 : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
    sendRawError(socket, status, STATUS_CODES[status] ?? "Bad request");
  };

  let listener: net.Server;
  let httpServers: http.Server[];
  if (tls) {
    const secure = https.createServer({ cert: tls.cert, key: tls.key }, handleRequest);
    secure.on("upgrade", handleUpgrade);
    secure.on("clientError", handleClientError);
    secure.on("tlsClientError", (error) => {
      // Expected once per device until the self-signed certificate is accepted.
      log.debug(`TLS handshake failed: ${error.message}`);
    });
    const redirect = createHttpsRedirectServer();
    redirect.on("clientError", handleClientError);
    listener = createProtocolSniffer(secure, redirect);
    // The inner servers never listen themselves, but Node only starts their
    // connection tracking (header/request timeouts, closeAllConnections) on
    // their 'listening' event.
    listener.once("listening", () => {
      secure.emit("listening");
      redirect.emit("listening");
    });
    httpServers = [secure, redirect];
  } else {
    const server = http.createServer(handleRequest);
    server.on("upgrade", handleUpgrade);
    server.on("clientError", handleClientError);
    listener = server;
    httpServers = [server];
  }
  listener.maxConnections = MAX_CONNECTIONS;

  const heartbeat = setInterval(() => tunnels.heartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    listener,
    httpServers,
    tunnels,
    heartbeat,
    updater,
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

/**
 * Parses an origin-form request target ("/path?query"). Absolute-form and
 * protocol-relative targets are rejected rather than reinterpreted.
 */
function parseRequestTarget(target: string | undefined): URL | undefined {
  if (!target || !target.startsWith("/")) return undefined;
  try {
    return new URL(`http://relay.invalid${target}`);
  } catch {
    return undefined;
  }
}

/**
 * In HTTPS mode, people often type http://<ip>:<port>. Plain HTTP requests on
 * the TLS port get a redirect to the https:// URL instead of a reset.
 */
function createHttpsRedirectServer(): http.Server {
  return http.createServer((req, res) => {
    applySecurityHeaders(res);
    const host = parseHostHeader(req.headers.host);
    const target = req.url ?? "/";
    if (!host || !target.startsWith("/")) {
      sendText(res, 400, "This server only speaks HTTPS.");
      return;
    }
    const authority = host.port ? `${host.hostname}:${host.port}` : host.hostname;
    sendText(res, 308, "This server only speaks HTTPS.", { Location: `https://${authority}${target}` });
  });
}

/**
 * A TCP listener that peeks at the first byte of each connection and hands it
 * to the TLS server (0x16 = TLS handshake record) or to the plain HTTP
 * redirect server.
 */
function createProtocolSniffer(secure: https.Server, plain: http.Server): net.Server {
  return net.createServer((socket) => {
    // Kept for the socket's lifetime; the HTTP servers add their own handlers.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy()); // never sent a byte
    const peek = (): void => {
      const first: Buffer | null = socket.read(1);
      if (first === null) {
        if (!socket.readableEnded && !socket.destroyed) socket.once("readable", peek);
        return;
      }
      socket.unshift(first);
      socket.setTimeout(0);
      (first[0] === 0x16 ? secure : plain).emit("connection", socket);
    };
    peek();
  });
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ port, host }, () => {
      server.off("error", onError);
      server.on("error", (error) => log.error(`Server error: ${error.message}`));
      resolve();
    });
  });
}

function describeListenError(error: unknown, options: RelayOptions): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const where = `${formatHost(options.host)}:${options.port}`;
  if (code === "EADDRINUSE") {
    return `Port ${options.port} is already in use (is another relay running?). Stop it or pick another port with --port.`;
  }
  if (code === "EACCES") return `Not allowed to listen on ${where}. Try a port above 1024 with --port.`;
  if (code === "EADDRNOTAVAIL") return `${options.host} is not a network address of the computer running DeXterous (--host).`;
  return `Cannot listen on ${where}: ${error instanceof Error ? error.message : String(error)}`;
}

/** What a stop request from bin/dexterous.js does; replaced once the relay runs. */
let onSupervisorStop = (signal: string): void => {
  // Still starting up, or a short command such as `dexterous update`.
  process.exit(signal === "SIGINT" ? 130 : 143);
};

/**
 * Listens for stop requests from bin/dexterous.js (it got a signal), and
 * stops if bin/dexterous.js goes away (e.g. killed), rather than keep running
 * unseen. The channel must not keep short commands (--help, update...) alive.
 */
function listenToSupervisor(): void {
  process.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "stop" in message) {
      onSupervisorStop(String((message as { stop: unknown }).stop));
    }
  });
  process.on("disconnect", () => onSupervisorStop("disconnect"));
  process.channel?.unref();
}

/**
 * Stops on SIGINT/SIGTERM/SIGHUP and on stop requests from bin/dexterous.js.
 * Returns the function that stops the relay with a message and an exit code.
 * While an update installs, a stop waits for npm to finish (stopping it
 * halfway could break the install); a second Ctrl+C forces the exit.
 */
function installShutdownHandlers(relay: Relay): (message: string, exitCode?: number) => void {
  let startedAt = 0;
  let waitingForUpdate = false;
  const stop = (message: string, exitCode: number): void => {
    relay.beginShutdown();
    process.exitCode = exitCode;
    log.info(message);
    clearInterval(relay.heartbeat);
    relay.updater?.stop();
    if (exitCode === RESTART_EXIT_CODE) relay.tunnels.closeAll(1012, "DeXterous is restarting after an update");
    else relay.tunnels.closeAll(1001, "Relay shutting down");
    relay.listener.close();
    for (const server of relay.httpServers) {
      server.close();
      server.closeAllConnections();
    }
    // Exit as soon as everything is closed, or after a short grace period.
    setTimeout(() => process.exit(exitCode), 1000).unref();
  };
  const shutdown = (message: string, exitCode = 0): void => {
    if (relay.isShuttingDown() || waitingForUpdate) {
      // Ctrl+C reaches the relay both from the terminal and from the
      // supervisor; only a later one means "hurry up".
      if (Date.now() - startedAt < DUPLICATE_SIGNAL_MS) return;
      log.info("Forcing exit.");
      process.exit(1);
    }
    startedAt = Date.now();
    const updater = relay.updater;
    if (exitCode !== RESTART_EXIT_CODE && updater?.state === "installing") {
      waitingForUpdate = true;
      log.info(`${message}\nFinishing the update first. Press Ctrl+C again to stop right away.`);
      void updater.finishInstall().then(() => stop("Stopped.", 0));
      return;
    }
    stop(message, exitCode);
  };
  const onSignal = (signal: string): void => {
    if (signal === "disconnect") shutdown("DeXterous's launcher stopped, shutting down...");
    else shutdown(`\n${signal} received, shutting down...`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  if (process.platform !== "win32") process.on("SIGHUP", () => onSignal("SIGHUP"));
  onSupervisorStop = onSignal;
  return shutdown;
}

/**
 * Logs rejected tunnel attempts once per (origin, reason) so a hostile page
 * retrying in a loop cannot flood the terminal.
 */
class RejectionLogger {
  readonly #seen = new Set<string>();

  log(req: http.IncomingMessage, reason: string): void {
    const origin = req.headers.origin ?? "(no origin)";
    const key = `${origin}\n${reason}`;
    // Origin is attacker-controlled: keep terminal escape sequences out.
    const message = printable(
      `Rejected tunnel connection from ${req.socket.remoteAddress ?? "unknown"} (origin ${origin}): ${reason}`,
    );
    if (this.#seen.has(key) || this.#seen.size >= 100) {
      log.debug(message);
      return;
    }
    this.#seen.add(key);
    log.warn(message);
  }
}

/** The app's URL (with the token, when one is required) under `host`. */
function appUrl(options: RelayOptions, token: string, tls: TlsMaterial | undefined, host: string): string {
  const scheme = tls ? "https" : "http";
  const fragment = options.tokenRequired ? `#token=${encodeURIComponent(token)}` : "";
  return `${scheme}://${formatHost(host)}:${options.port}/${fragment}`;
}

/** localhost is a secure context in every browser, whatever the scheme. */
function isDefaultLoopback(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

/**
 * The URL to open on the computer running DeXterous: localhost unless bound to one specific
 * address, or unless a custom LAN certificate does not cover localhost (it
 * only works under its own names, like the banner's links).
 */
function localAppUrl(options: RelayOptions, token: string, tls: TlsMaterial | undefined): string {
  if (options.lan && tls?.source === "custom" && !tls.dnsNames.includes("localhost")) {
    const [name] = lanHostsForBanner(options.host, tls);
    if (name) return appUrl(options, token, tls, name);
  }
  const host = isWildcardAddress(options.host) || isDefaultLoopback(options.host) ? "localhost" : options.host;
  return appUrl(options, token, tls, host);
}

function printBanner(
  options: RelayOptions,
  token: string,
  tls: TlsMaterial | undefined,
  adb: AdbStartupStatus,
  opening: boolean,
): void {
  const fragment = options.tokenRequired ? `#token=${encodeURIComponent(token)}` : "";
  const link = (host: string): string => `    ${paint(["bold", "cyan"], appUrl(options, token, tls, host))}`;
  const lines: string[] = ["", `  ${paint("bold", "DeXterous")} ${paint("gray", `v${readPackageVersion()}`)}`, ""];

  if (options.lan) {
    const hosts = lanHostsForBanner(options.host, tls);
    if (hosts.length > 0) {
      lines.push("  Open DeXterous on any device on your network:");
      for (const host of hosts) lines.push(link(host));
      lines.push("");
    } else {
      lines.push(paint("yellow", "  No network address found: is the computer connected to Wi-Fi or Ethernet?"), "");
    }
    if (isWildcardAddress(options.host)) {
      lines.push("  On the computer running DeXterous:", link("localhost"), "");
    }
    if (tls?.source !== "custom") {
      lines.push(
        "  The certificate is self-signed, so each browser will warn about it once:",
        "  choose Advanced, then Proceed / Accept the risk.",
      );
    }
    if (tls) lines.push(paint("gray", `  Certificate SHA-256: ${tls.fingerprint256}`));
    lines.push(
      paint("yellow", "  Anyone with this link can control your phone. Only open it on your own devices."),
      "",
    );
  } else {
    lines.push("  Open DeXterous in your browser:", link(isDefaultLoopback(options.host) ? "localhost" : options.host), "");
  }

  const adbAddress = `${formatHost(options.adb.host)}:${options.adb.port}`;
  lines.push(
    `  adb server:  ${adbAddress}  ${adb.reachable ? paint("green", "reachable") : paint("red", "not reachable")}`,
  );
  if (options.allowOrigins.length > 0) {
    lines.push("  Also allowed from:");
    for (const origin of options.allowOrigins) lines.push(`    ${paint(["bold", "cyan"], `${origin}/${fragment}`)}`);
  }
  if (!fs.existsSync(path.join(options.distDir, "index.html"))) {
    lines.push(paint("yellow", `  No web app found in ${options.distDir}: run \`npm run build\` in the DeXterous folder.`));
  }
  if (opening) lines.push("", paint("gray", "  Opening it in your default browser (--no-open to skip)..."));
  lines.push("", "  Keep this window open while using DeXterous. Ctrl+C to stop.", "");
  console.log(lines.join("\n"));

  if (!adb.reachable) {
    const tried = adb.attemptedStart ? ` (tried \`${adb.adbPath} start-server\`)` : "";
    log.warn(
      `Cannot reach the adb server at ${adbAddress}${tried}. ` +
        "Install Android platform-tools (https://developer.android.com/tools/releases/platform-tools), " +
        "plug in the phone with USB debugging enabled, and run `adb devices` once to authorize it.",
    );
  }
}

/** Which hostnames to print as LAN links. */
function lanHostsForBanner(bindHost: string, tls: TlsMaterial | undefined): string[] {
  if (tls?.source === "custom") {
    // A real certificate (mkcert, Tailscale...) only works under its own names.
    const names = tls.dnsNames.filter((name) => !name.includes("*") && name !== "localhost");
    if (names.length > 0) return names;
  }
  if (!isWildcardAddress(bindHost)) return [bindHost];
  return listLanIPv4Addresses({ includeLinkLocal: false });
}

/** Escapes control and non-ASCII characters, and caps the length. */
function printable(text: string): string {
  const escaped = text.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return escaped.length > 300 ? `${escaped.slice(0, 300)}...` : escaped;
}

let cachedVersion: string | undefined;
function readPackageVersion(): string {
  cachedVersion ??= readVersionFrom(PACKAGE_ROOT);
  return cachedVersion;
}

await main();
