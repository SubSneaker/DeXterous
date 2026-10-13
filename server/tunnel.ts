// WebSocket <-> TCP byte tunnel to the adb server.
//
// Each WebSocket on /adb gets its own fresh TCP connection to the adb server,
// and bytes are copied verbatim in both directions as binary frames. The
// browser speaks the adb server ("smart socket") protocol itself; the relay
// never parses it.
//
// Close codes the browser can see (the relay never forwards adb data on
// anything but a successfully opened tunnel):
//   1000  the adb server closed the connection (normal end of a service)
//   1001  the relay is shutting down (sent by relay.ts too)
//   1003  a text frame was received (only binary frames are accepted)
//   1011  the adb server is unreachable or the connection failed
//   1013  too many open tunnels, try again later (relay.ts)
//   4401  missing or invalid access token (relay.ts)
import net from "node:net";
import { WebSocket, type RawData } from "ws";
import { log } from "./log.ts";
import type { HostPort } from "./network.ts";

/** Stop reading from adb while more than this is queued towards the browser. */
const HIGH_WATER_MARK = 1024 * 1024;
/** ...and resume once the queue drains below this. */
const LOW_WATER_MARK = 256 * 1024;
/** How long to let adb flush after the browser closes before forcing it shut. */
const TCP_LINGER_MS = 2000;
/** Give up on an adb server that neither accepts nor refuses the connection. */
const ADB_CONNECT_TIMEOUT_MS = 10_000;

interface Tunnel {
  readonly id: number;
  readonly ws: WebSocket;
  readonly tcp: net.Socket;
  /** Cleared on each heartbeat ping, set again when the pong arrives. */
  alive: boolean;
  /**
   * The WebSocket is paused because adb is not reading. Pongs cannot be
   * received meanwhile, so the heartbeat must not count them as missing.
   */
  wsPaused: boolean;
}

export class TunnelManager {
  readonly #target: HostPort;
  readonly #tunnels = new Set<Tunnel>();
  #nextId = 1;

  constructor(target: HostPort) {
    this.#target = target;
  }

  get size(): number {
    return this.#tunnels.size;
  }

  /** Connects a freshly upgraded WebSocket to a new adb server connection. */
  open(ws: WebSocket, peer: string): void {
    const target = this.#target;
    const id = this.#nextId++;
    const startedAt = Date.now();
    const tcp = net.connect({ host: target.host, port: target.port });
    tcp.setNoDelay(true);
    const connectTimer = setTimeout(() => {
      const error: NodeJS.ErrnoException = new Error("connection timed out");
      error.code = "ETIMEDOUT";
      tcp.destroy(error);
    }, ADB_CONNECT_TIMEOUT_MS);

    const tunnel: Tunnel = { id, ws, tcp, alive: true, wsPaused: false };
    this.#tunnels.add(tunnel);
    log.debug(`tunnel #${id} opened from ${peer} to adb ${target.host}:${target.port}`);

    let connected = false;
    let tcpError: NodeJS.ErrnoException | undefined;
    let tcpPaused = false;
    let bytesToAdb = 0;
    let bytesFromAdb = 0;

    // adb -> browser, pausing the TCP socket while the WebSocket is backed up.
    tcp.on("data", (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      bytesFromAdb += chunk.length;
      ws.send(chunk, { binary: true }, (error) => {
        if (!error && tcpPaused && ws.bufferedAmount <= LOW_WATER_MARK) {
          tcpPaused = false;
          tcp.resume();
        }
      });
      if (!tcpPaused && ws.bufferedAmount > HIGH_WATER_MARK) {
        tcpPaused = true;
        tcp.pause();
      }
    });

    // browser -> adb, pausing the WebSocket while the TCP socket is backed up.
    // (Writes made before the TCP connect completes are queued by Node.)
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        ws.close(1003, "Only binary frames are accepted");
        return;
      }
      if (tcp.destroyed) return;
      const chunk = toBuffer(data);
      bytesToAdb += chunk.length;
      if (!tcp.write(chunk) && !tunnel.wsPaused) {
        tunnel.wsPaused = true;
        ws.pause();
        tcp.once("drain", () => {
          tunnel.wsPaused = false;
          ws.resume();
        });
      }
    });

    ws.on("pong", () => {
      tunnel.alive = true;
    });

    tcp.once("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
    });

    tcp.on("error", (error: NodeJS.ErrnoException) => {
      tcpError = error;
    });

    // The adb side ended (normally or not): close the WebSocket after any
    // queued data has been sent.
    tcp.once("close", () => {
      clearTimeout(connectTimer);
      // Keep reading so the browser's close frame can be received.
      if (tunnel.wsPaused) {
        tunnel.wsPaused = false;
        ws.resume();
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        if (tcpError) {
          const what = connected ? "adb connection failed" : "adb server unreachable";
          ws.close(1011, truncateReason(`${what} at ${target.host}:${target.port} (${tcpError.code ?? tcpError.message})`));
        } else {
          ws.close(1000, "adb closed the connection");
        }
      }
    });

    ws.on("error", (error) => {
      log.debug(`tunnel #${id} WebSocket error: ${error.message}`);
    });

    // The browser side ended: half-close towards adb so already-written bytes
    // still get delivered, then force it shut if adb does not hang up.
    ws.once("close", (code: number) => {
      this.#tunnels.delete(tunnel);
      if (!tcp.destroyed) {
        if (connected) {
          // Drain (and discard) whatever adb still sends so its FIN is seen.
          tcp.resume();
          tcp.end();
          setTimeout(() => tcp.destroy(), TCP_LINGER_MS).unref();
        } else {
          tcp.destroy();
        }
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log.debug(
        `tunnel #${id} closed (code ${code}, ${seconds}s, ${formatBytes(bytesToAdb)} to adb, ${formatBytes(bytesFromAdb)} from adb${
          tcpError ? `, adb error ${tcpError.code ?? tcpError.message}` : ""
        })`,
      );
    });
  }

  /**
   * Pings every tunnel and terminates the ones that did not answer the
   * previous ping (e.g. a laptop that went to sleep), so their adb
   * connections do not stay open forever. Call periodically.
   */
  heartbeat(): void {
    for (const tunnel of this.#tunnels) {
      if (tunnel.wsPaused) {
        // Backpressure from adb, not a dead browser: check again next time.
        tunnel.alive = true;
        continue;
      }
      if (!tunnel.alive) {
        log.debug(`tunnel #${tunnel.id} timed out`);
        tunnel.ws.terminate();
        tunnel.tcp.destroy();
        continue;
      }
      tunnel.alive = false;
      if (tunnel.ws.readyState === WebSocket.OPEN) tunnel.ws.ping();
    }
  }

  /** Closes every tunnel, e.g. on shutdown. */
  closeAll(code: number, reason: string): void {
    for (const tunnel of this.#tunnels) {
      tunnel.tcp.destroy();
      tunnel.ws.close(code, reason);
      // Don't wait long for the browser to acknowledge the close frame.
      setTimeout(() => tunnel.ws.terminate(), 500).unref();
    }
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** WebSocket close reasons are limited to 123 bytes of UTF-8. */
function truncateReason(reason: string): string {
  let text = reason;
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1);
  return text;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
