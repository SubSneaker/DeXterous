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
// bin/dexterous.js runs.
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
  createAccessPolicy,
  loadOrCreateToken,
  parseHostHeader,
  type AccessPolicy,
} from "./security.ts";
import { createStaticHandler } from "./static.ts";
import { TunnelManager } from "./tunnel.ts";

/** The installed package (or the clone): holds package.json and dist/. */
const PACKAGE_ROOT = findPackageRoot(import.meta.dirname);
/** Per-user folder for the token and certificate (see paths.ts). */
const DATA_DIR = resolveStateDir();
const TUNNEL_PATH = "/adb";
const INFO_PATH = "/api/info";
/** Generous: a DeX session uses a handful of adb sockets at a time. */
const MAX_TUNNELS = 256;
/** Caps sockets per listener so a LAN client cannot exhaust file descriptors. */
const MAX_CONNECTIONS = 1024;
/** Large enough for any adb sync/push chunk the browser may send. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  let options: RelayOptions | "help" | "version";
  try {
    options = parseOptions(process.argv.slice(2), process.env, PACKAGE_ROOT);
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

  const [adbStatus, firewallBlocksAll] = await Promise.all([
    ensureAdbServer(options.adb, options.autoStartAdb),
    options.lan ? isMacFirewallBlockingAll() : Promise.resolve(false),
  ]);
  const relay = createRelay(options, policy, tls);

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
  installShutdownHandlers(relay);
}

interface Relay {
  /** The server bound to the port. */
  listener: net.Server;
  /** HTTP servers whose keep-alive connections must be closed on shutdown. */
  httpServers: http.Server[];
  tunnels: TunnelManager;
  heartbeat: NodeJS.Timeout;
  isShuttingDown(): boolean;
  beginShutdown(): void;
}

function createRelay(options: RelayOptions, policy: AccessPolicy, tls: TlsMaterial | undefined): Relay {
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
      void isAdbServerReachable(options.adb).then((adbReachable) => {
        // Never include the token itself.
        sendJson(res, 200, { relay: true, version, adbReachable, tokenRequired: policy.tokenRequired });
      });
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
  if (code === "EADDRNOTAVAIL") return `${options.host} is not an address of this machine (--host).`;
  return `Cannot listen on ${where}: ${error instanceof Error ? error.message : String(error)}`;
}

function installShutdownHandlers(relay: Relay): void {
  const shutdown = (signal: string): void => {
    if (relay.isShuttingDown()) {
      log.info("Forcing exit.");
      process.exit(1);
    }
    relay.beginShutdown();
    log.info(`\n${signal} received, shutting down...`);
    clearInterval(relay.heartbeat);
    relay.tunnels.closeAll(1001, "Relay shutting down");
    relay.listener.close();
    for (const server of relay.httpServers) {
      server.close();
      server.closeAllConnections();
    }
    // Exit as soon as everything is closed, or after a short grace period.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (process.platform !== "win32") process.on("SIGHUP", () => shutdown("SIGHUP"));
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
 * The URL to open on this computer: localhost unless bound to one specific
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
      lines.push(paint("yellow", "  No network address found: is this computer connected to Wi-Fi or Ethernet?"), "");
    }
    if (isWildcardAddress(options.host)) {
      lines.push("  On this computer:", link("localhost"), "");
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
