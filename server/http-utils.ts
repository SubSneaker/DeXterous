// Shared HTTP response helpers.
import { STATUS_CODES, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** Headers sent on every response (including rejected WebSocket upgrades). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // The app is never meant to be framed; this blocks clickjacking the
  // "connect" button from another site.
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function sendText(
  res: ServerResponse,
  status: number,
  message: string,
  headers: OutgoingHttpHeaders = {},
): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

/**
 * Writes a minimal HTTP error response directly to a socket and closes it.
 * Used where there is no ServerResponse: refused WebSocket upgrades and
 * malformed requests (the servers' `clientError` event).
 */
export function sendRawError(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${message}\n`;
  const headers = {
    Connection: "close",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  };
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n${head}\r\n${body}`);
}
