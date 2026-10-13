import type { AdbServerClient } from "@yume-chan/adb";
import { MaybeConsumable, PushReadableStream } from "@yume-chan/stream-extra";

/** Above this many queued bytes, writes wait for the socket to drain. */
const HIGH_WATER_MARK = 1024 * 1024;

/**
 * Connects Tango's `AdbServerClient` to the local adb server through the
 * DeXterous relay. Every `connect()` opens one WebSocket, which the relay turns
 * into one TCP connection to the adb server (127.0.0.1:5037), so the browser
 * speaks the plain adb server protocol end to end.
 */
export class WebSocketServerConnector implements AdbServerClient.ServerConnector {
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async connect(
    options?: AdbServerClient.ServerConnectionOptions,
  ): Promise<AdbServerClient.ServerConnection> {
    const socket = new WebSocket(this.#url);
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = (event: CloseEvent) => {
        cleanup();
        reject(new Error(describeClose(event)));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
    });

    // Closes we start ourselves are never errors.
    let closingByUs = false;
    const closeSocket = () => {
      closingByUs = true;
      socket.close();
    };

    let resolveClosed!: () => void;
    const closed = new Promise<undefined>((resolve) => {
      resolveClosed = () => resolve(undefined);
    });

    const readable = new PushReadableStream<Uint8Array>((controller) => {
      socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
        void controller.enqueue(new Uint8Array(event.data));
      });
      socket.addEventListener("close", (event) => {
        try {
          // 1000 = adb closed the connection, 1005 = closed without a code.
          // Anything else (bad token, adb unreachable, relay shutting down)
          // should reach the user.
          if (closingByUs || event.code === 1000 || event.code === 1005) {
            controller.close();
          } else {
            controller.error(new Error(describeClose(event)));
          }
        } catch {
          // Already closed or cancelled by the consumer.
        }
        resolveClosed();
      });
      controller.abortSignal.addEventListener("abort", closeSocket);
    });

    const writable = new MaybeConsumable.WritableStream<Uint8Array>({
      async write(chunk) {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("ADB relay connection is closed");
        }
        // `send` snapshots the bytes, so the chunk can be reused afterwards.
        socket.send(chunk as Uint8Array<ArrayBuffer>);
        while (socket.bufferedAmount > HIGH_WATER_MARK && socket.readyState === WebSocket.OPEN) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
      close: closeSocket,
      abort: closeSocket,
    });

    options?.signal?.addEventListener("abort", closeSocket);

    return { readable, writable, closed, close: closeSocket };
  }

  addReverseTunnel(): never {
    // A browser can't listen on a TCP port. DeXterous always starts scrcpy with
    // `tunnelForward: true`, so reverse tunnels are never needed.
    throw new Error("Reverse tunnels are not supported through the relay");
  }

  removeReverseTunnel(): void {}

  clearReverseTunnels(): void {}
}

/** Close codes sent by server/relay.ts. */
const RelayCloseCode = {
  ShuttingDown: 1001,
  AdbFailed: 1011,
  TooManyTunnels: 1013,
  BadToken: 4401,
} as const;

function describeClose(event: CloseEvent): string {
  switch (event.code) {
    case 1006:
      // Also what a refused upgrade (wrong Host/Origin) looks like from a page.
      return "Couldn't reach DeXterous on your computer. Is it still running?";
    case RelayCloseCode.BadToken:
      // The relay explains whether the token is missing or wrong.
      return (
        event.reason ||
        "The relay needs an access token. Open the link (with #token=…) that the relay printed when it started."
      );
    case RelayCloseCode.AdbFailed:
      return `The relay couldn't talk to adb${event.reason ? `: ${event.reason}` : ""}. Is Android platform-tools installed?`;
    case RelayCloseCode.ShuttingDown:
      return "The DeXterous relay was stopped.";
    case RelayCloseCode.TooManyTunnels:
      return "The relay has too many open connections. Reload the page.";
    default:
      return `The DeXterous relay closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
  }
}
