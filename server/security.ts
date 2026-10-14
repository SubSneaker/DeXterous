// Access control for the relay.
//
// The /adb tunnel grants full `adb shell` access to the phone, so every
// WebSocket upgrade must pass three checks:
//
//  1. Host check (loopback mode only): defeats DNS rebinding, where a hostile
//     site makes its own hostname resolve to 127.0.0.1 so the browser treats
//     the relay as same-origin with the attacker's page.
//  2. Origin check: browsers always send `Origin` on WebSocket upgrades and
//     scripts cannot forge it, so requiring Origin to match Host (or an
//     explicit --allow-origin) stops cross-site WebSocket hijacking.
//  3. Token check (LAN mode, or --require-token): a random secret shown in the
//     startup banner, so other people on the network cannot connect.
//
// POST /api/update (install the latest DeXterous with npm, then restart) is
// stricter still: see checkUpdateRequest.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { isLoopbackAddress } from "./network.ts";
import { ensurePrivateDir, readOptionalFile, restrictMode, writePrivateFile } from "./storage.ts";

/** Hostnames accepted in the Host header when bound to loopback only. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Generated tokens are 32 base64url chars; also bounds what we accept from disk. */
const TOKEN_FILE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const MIN_ENV_TOKEN_LENGTH = 16;

export interface AccessPolicy {
  /** When true, the Host header must name a loopback host (or an allowed origin's host). */
  readonly checkHostHeader: boolean;
  readonly allowedHostnames: ReadonlySet<string>;
  /** Normalized origins (scheme://host[:port]) always accepted for the tunnel. */
  readonly allowedOrigins: ReadonlySet<string>;
  readonly tokenRequired: boolean;
  readonly token: string;
}

export type Verdict = { ok: true } | { ok: false; status: number; reason: string };

const ALLOW: Verdict = { ok: true };

export function createAccessPolicy(init: {
  loopbackOnly: boolean;
  bindHost: string;
  allowOrigins: readonly string[];
  tokenRequired: boolean;
  token: string;
}): AccessPolicy {
  const allowedHostnames = new Set(LOOPBACK_HOSTNAMES);
  const bound = parseHostHeader(init.bindHost);
  if (bound) allowedHostnames.add(bound.hostname);
  // An explicitly allowed origin (e.g. a reverse proxy such as `tailscale
  // serve`) must also be able to reach the relay under its own hostname.
  for (const origin of init.allowOrigins) {
    allowedHostnames.add(new URL(origin).hostname);
  }
  return {
    checkHostHeader: init.loopbackOnly,
    allowedHostnames,
    allowedOrigins: new Set(init.allowOrigins),
    tokenRequired: init.tokenRequired,
    token: init.token,
  };
}

/** DNS-rebinding protection, applied to every HTTP request and upgrade. */
export function checkHost(req: IncomingMessage, policy: AccessPolicy): Verdict {
  const host = parseHostHeader(req.headers.host);
  if (!host) return { ok: false, status: 400, reason: "Missing or malformed Host header." };
  if (policy.checkHostHeader && !policy.allowedHostnames.has(host.hostname)) {
    return {
      ok: false,
      status: 403,
      reason: `Host "${host.hostname}" is not allowed. Open the relay at http://localhost instead (or start it with --allow-origin).`,
    };
  }
  return ALLOW;
}

/**
 * Host + Origin checks for a WebSocket upgrade to the adb tunnel. Failing
 * requests must be refused before the handshake.
 */
export function checkTunnelOrigin(req: IncomingMessage, policy: AccessPolicy): Verdict {
  const hostVerdict = checkHost(req, policy);
  if (!hostVerdict.ok) return hostVerdict;
  return checkOrigin(req, policy);
}

/** Token check for the tunnel; returns why it failed, or undefined if it passed. */
export function checkTunnelToken(url: URL, policy: AccessPolicy): string | undefined {
  if (!policy.tokenRequired) return undefined;
  const supplied = url.searchParams.get("token");
  if (!supplied) return "This relay requires an access token. Open the link printed by the relay.";
  if (!tokensEqual(supplied, policy.token)) return "Invalid access token. Open the link printed by the relay.";
  return undefined;
}

/**
 * Checks for POST /api/update, which makes the computer running DeXterous download and run
 * new code. Only a page on that computer may ask, even in LAN mode:
 *  - the connection comes from a loopback address (not from another device);
 *  - the page is same-origin with the relay under a loopback name, so pages
 *    served through a reverse proxy (--allow-origin) don't qualify, and
 *    cross-site form posts and DNS rebinding fail;
 *  - when the relay requires a token, the request carries
 *    `Authorization: Bearer <token>`.
 * The Host check (checkHost) has already run.
 */
export function checkUpdateRequest(req: IncomingMessage, policy: AccessPolicy): Verdict {
  const remote = req.socket.remoteAddress;
  if (!remote || !isLoopbackAddress(remote)) {
    return { ok: false, status: 403, reason: "Updates can only be started on the computer running DeXterous." };
  }
  const originHeader = req.headers.origin;
  const origin = originHeader === undefined ? undefined : normalizeOrigin(originHeader);
  if (!origin || !isLoopbackAddress(new URL(origin).hostname) || !isSameOrigin(origin, req)) {
    return { ok: false, status: 403, reason: "Updates can only be started from a DeXterous page open on the computer running DeXterous." };
  }
  if (policy.tokenRequired) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
    if (!match || !tokensEqual(match[1], policy.token)) {
      return { ok: false, status: 401, reason: "This relay requires an access token. Open the link printed by the relay." };
    }
  }
  return ALLOW;
}

/**
 * True when the request comes from the computer running DeXterous and names the relay by a
 * loopback name: the only requests that may start an update.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  const host = parseHostHeader(req.headers.host);
  return remote !== undefined && isLoopbackAddress(remote) && host !== undefined && isLoopbackAddress(host.hostname);
}

function checkOrigin(req: IncomingMessage, policy: AccessPolicy): Verdict {
  const originHeader = req.headers.origin;
  if (!originHeader) return { ok: false, status: 403, reason: "Missing Origin header." };

  const origin = normalizeOrigin(originHeader);
  if (origin === undefined) {
    return { ok: false, status: 403, reason: `Origin "${originHeader}" is not allowed.` };
  }
  if (policy.allowedOrigins.has(origin)) return ALLOW;
  if (!isSameOrigin(origin, req)) {
    return { ok: false, status: 403, reason: `Origin "${originHeader}" is not allowed.` };
  }
  return ALLOW;
}

/**
 * Same-origin check: the page's host[:port] must equal the Host it is
 * connecting to. Ports are compared after applying the origin scheme's
 * default so "Host: example.com" matches "https://example.com". `origin`
 * is normalized (see normalizeOrigin).
 */
function isSameOrigin(origin: string, req: IncomingMessage): boolean {
  const host = parseHostHeader(req.headers.host);
  const originUrl = new URL(origin);
  const defaultPort = originUrl.protocol === "https:" ? "443" : "80";
  return (
    host !== undefined &&
    originUrl.hostname === host.hostname &&
    (originUrl.port || defaultPort) === (host.port || defaultPort)
  );
}

/**
 * Normalizes an http(s) origin to `scheme://host[:port]` (lowercase, default
 * port dropped). Returns undefined for anything else, including "null".
 */
export function normalizeOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return undefined;
  return url.origin;
}

export interface HostHeader {
  /** Lowercase; IPv6 literals keep their brackets, e.g. "[::1]". */
  hostname: string;
  /** Empty when the header has no explicit port. */
  port: string;
}

/** Parses a Host header (`name`, `name:port`, `[v6]:port` or bare `::1`). */
export function parseHostHeader(value: string | undefined): HostHeader | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (!/^[a-z0-9.:_[\]-]+$/.test(text)) return undefined;

  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return undefined;
    const rest = text.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return undefined;
    return { hostname: text.slice(0, end + 1), port: rest.slice(1) };
  }

  const colons = text.split(":").length - 1;
  if (colons > 1) return { hostname: `[${text}]`, port: "" }; // bare IPv6 literal
  if (colons === 1) {
    const [hostname, port] = text.split(":");
    if (!hostname || !/^\d{1,5}$/.test(port)) return undefined;
    return { hostname, port };
  }
  return { hostname: text, port: "" };
}

/** Constant-time comparison; hashing first makes both inputs equal-length. */
export function tokensEqual(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export interface LoadedToken {
  token: string;
  source: "env" | "file" | "generated";
  /** Set when DEXTEROUS_TOKEN looks too weak. */
  warning?: string;
}

/**
 * Returns the access token: DEXTEROUS_TOKEN if set, else the one persisted in
 * `<dataDir>/token` (generated on first run so bookmarked links keep working).
 */
export function loadOrCreateToken(dataDir: string, envToken: string | undefined): LoadedToken {
  const fromEnv = envToken?.trim();
  if (fromEnv) {
    return {
      token: fromEnv,
      source: "env",
      warning:
        fromEnv.length < MIN_ENV_TOKEN_LENGTH
          ? `DEXTEROUS_TOKEN is only ${fromEnv.length} characters long; use at least ${MIN_ENV_TOKEN_LENGTH} random characters.`
          : undefined,
    };
  }

  const file = path.join(dataDir, "token");
  const existing = readOptionalFile(file)?.trim();
  if (existing && TOKEN_FILE_PATTERN.test(existing)) {
    restrictMode(file, 0o600);
    return { token: existing, source: "file" };
  }

  const token = randomBytes(24).toString("base64url");
  ensurePrivateDir(dataDir);
  writePrivateFile(file, `${token}\n`);
  return { token, source: "generated" };
}
