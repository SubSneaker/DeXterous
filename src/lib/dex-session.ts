import type { Adb, AdbNoneProtocolProcess } from "@yume-chan/adb";
import {
  AdbScrcpyClient,
  AdbScrcpyExitedError,
  AdbScrcpyOptionsLatest,
} from "@yume-chan/adb-scrcpy";
import {
  ScrcpyInstanceId,
  ScrcpyNewDisplay,
  type ScrcpyAudioStreamPacket,
  type ScrcpyControlMessageWriter,
  type ScrcpyVideoSize,
} from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
  type VideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { Int16PcmPlayer } from "@yume-chan/pcm-player";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";

import type { DexSettings, InputSink, VideoSize } from "./types";

/** Must match the binary in public/scrcpy-server.jar (see scripts/fetch-server.mjs). */
export const SCRCPY_SERVER_VERSION = "5.0.1";

/**
 * Where the server is pushed on the phone. Deliberately not scrcpy's default
 * path so a desktop scrcpy running at the same time keeps working.
 */
const SERVER_PATH = "/data/local/tmp/dexterous-server.jar";

/**
 * Call this synchronously inside the click that starts the session: browsers
 * only let an AudioContext play if it was created during a user gesture.
 * scrcpy's raw audio is 48 kHz, stereo, signed 16-bit little endian.
 */
export function createAudioPlayer(): Int16PcmPlayer {
  return new Int16PcmPlayer(48_000, 2);
}

/** A representative WebCodecs config string per codec, for support checks. */
const CODEC_PROBES: Record<DexSettings["videoCodec"], string> = {
  h264: "avc1.640033",
  h265: "hev1.1.6.L153.B0",
  av1: "av01.0.13M.08",
};

/** Whether this browser can decode the codec (in hardware or software). */
export async function isCodecSupported(codec: DexSettings["videoCodec"]): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") {
    return false;
  }
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec: CODEC_PROBES[codec] });
    return supported === true;
  } catch {
    return false;
  }
}

export interface DisplayRequest {
  width: number;
  height: number;
  dpi: number;
}

export interface DexSessionInit {
  adb: Adb;
  canvas: HTMLCanvasElement;
  display: DisplayRequest;
  settings: DexSettings;
  /**
   * Created by the caller during the click that started the session:
   * browsers only let an AudioContext play if it was created in a user gesture.
   */
  audioPlayer?: Int16PcmPlayer | undefined;
  onStatus?: (message: string) => void;
  onClipboard?: (text: string) => void;
}

export interface PhoneState {
  /** The phone's own screen is on. */
  awake: boolean;
  /** The lock screen is up (PIN, pattern, fingerprint…). */
  locked: boolean;
}

export interface DeviceSummary {
  model: string;
  manufacturer: string;
  androidVersion: string;
  /** e.g. 90000 for One UI 9.0; undefined on non-Samsung phones. */
  oneUiVersion: number | undefined;
}

/**
 * scrcpy options with one fix-up: the server defaults to destroying a virtual
 * display's apps when it closes, but Tango believes the default is `false` and
 * therefore never sends `vd_destroy_content=false`. Always send it explicitly.
 */
class DexScrcpyOptions extends AdbScrcpyOptionsLatest<AdbScrcpyOptionsLatest.Init> {
  #destroyContent = true;

  setDestroyContent(value: boolean) {
    this.#destroyContent = value;
  }

  override serialize(): string[] {
    return [
      ...super.serialize().filter((arg) => !arg.startsWith("vd_destroy_content=")),
      `vd_destroy_content=${this.#destroyContent}`,
    ];
  }
}

interface AudioGate {
  muted: boolean;
  /** False once audio turned out to be unavailable or failed to start. */
  available: boolean;
}

/** Things that go wrong in background pipelines, kept for the exit message. */
interface Diagnostics {
  decoderError?: string;
}

/**
 * One running DeX desktop: a scrcpy server on the phone that owns a virtual
 * display, plus the browser-side video decoder, audio player and control channel.
 */
export class DexSession implements InputSink {
  readonly #adb: Adb;
  readonly #client: AdbScrcpyClient<DexScrcpyOptions>;
  readonly #decoder: WebCodecsVideoDecoder;
  readonly #audioPlayer: Int16PcmPlayer | undefined;
  /** Shared with the audio pipeline: while muted, phone audio is dropped. */
  readonly #audioGate: AudioGate;
  readonly #serverOutput: string[];
  readonly #diagnostics: Diagnostics;
  readonly #ended: Promise<string | undefined>;
  #videoSize: VideoSize;
  #requestedSize: VideoSize | undefined;
  #closed = false;
  /** Set when the user disconnects, so the server exiting isn't reported as an error. */
  #closeRequested = false;
  #inputBlocked = false;

  readonly device: DeviceSummary;

  /** Undefined while closed or while input is blocked (phone locked). */
  get controller(): ScrcpyControlMessageWriter | undefined {
    return this.#closed || this.#inputBlocked ? undefined : this.#client.controller;
  }

  get videoSize(): VideoSize {
    return this.#videoSize;
  }

  get decoder(): WebCodecsVideoDecoder {
    return this.#decoder;
  }

  /** Whether phone audio is playing (requested, and the phone sends it). */
  get hasAudio(): boolean {
    return this.#audioPlayer !== undefined && this.#audioGate.available;
  }

  /** Silences phone audio without stopping the stream. */
  setAudioMuted(muted: boolean): void {
    this.#audioGate.muted = muted;
  }

  /**
   * Resolves (never rejects) when the session stops for any reason.
   * The value is an error message, or undefined for a normal disconnect.
   */
  get ended(): Promise<string | undefined> {
    return this.#ended;
  }

  private constructor(
    client: AdbScrcpyClient<DexScrcpyOptions>,
    videoStream: ScrcpyVideoSize,
    requested: DisplayRequest,
    decoder: WebCodecsVideoDecoder,
    audioPlayer: Int16PcmPlayer | undefined,
    audioGate: AudioGate,
    serverOutput: string[],
    diagnostics: Diagnostics,
    device: DeviceSummary,
    adb: Adb,
  ) {
    this.#adb = adb;
    this.#client = client;
    this.#decoder = decoder;
    this.#audioPlayer = audioPlayer;
    this.#audioGate = audioGate;
    this.#serverOutput = serverOutput;
    this.#diagnostics = diagnostics;
    this.device = device;
    // The stream reports 0×0 until the server's first size packet arrives;
    // until then, the size we asked for is the best guess.
    this.#videoSize = videoStream.width
      ? { width: videoStream.width, height: videoStream.height }
      : { width: requested.width, height: requested.height };

    // The stream's size comes from the server's own resize notifications, so
    // it is exactly the size the server validates touch coordinates against.
    videoStream.sizeChanged(({ width, height }) => {
      this.#videoSize = { width, height };
    });

    const describeExit = () => this.#describeExit();
    this.#ended = Promise.race([
      client.exited.then(describeExit, describeExit),
      adb.disconnected.then(
        () => (this.#closeRequested ? undefined : "The phone disconnected."),
        (error: unknown) =>
          this.#closeRequested
            ? undefined
            : `Lost the connection to the phone${error instanceof Error ? `: ${error.message}` : "."}`,
      ),
    ]).finally(() => this.#teardown());
  }

  static async start(init: DexSessionInit): Promise<DexSession> {
    const { adb, settings } = init;
    const status = init.onStatus ?? (() => {});

    status("Checking your phone…");
    const device = await readDeviceSummary(adb);

    let videoCodec = settings.videoCodec;
    if (videoCodec !== "h264" && !(await isCodecSupported(videoCodec))) {
      status(`This browser can't decode ${videoCodec.toUpperCase()}; using H.264.`);
      videoCodec = "h264";
    }

    status("Installing the DeX bridge on your phone…");
    await pushServer(adb);

    status("Starting DeX…");
    const options = new DexScrcpyOptions(
      {
        scid: ScrcpyInstanceId.random(),
        logLevel: "info",
        // The browser can't listen for the phone to connect back, so open
        // the sockets from this side.
        tunnelForward: true,

        newDisplay: new ScrcpyNewDisplay(init.display.width, init.display.height, init.display.dpi),
        // Let the browser resize the virtual display as the window changes.
        flexDisplay: true,
        vdSystemDecorations: true,
        displayImePolicy: settings.showAndroidKeyboard ? "local" : "hide",

        video: true,
        videoCodec,
        videoBitRate: Math.round(settings.videoBitRate * 1_000_000),
        maxFps: settings.maxFps,
        minSizeAlignment: 8,

        audio: settings.audio,
        audioCodec: "raw",
        audioDup: settings.audioDup,

        control: true,
        // Always on; the UI decides whether to pass copies on, so the
        // setting can change mid-session.
        clipboardAutosync: true,
        // Keep the phone awake while DeXterous is connected, over USB
        // (stay_awake) and Wi‑Fi (keep_active reports activity on the DeX
        // display), so DeX never dozes off mid-use. Locking is explicit:
        // the side key or DeXterous's Lock command.
        stayAwake: true,
        keepActive: true,
        powerOn: true,
      },
      { version: SCRCPY_SERVER_VERSION },
    );
    options.setDestroyContent(!settings.keepAppsOnDisconnect);

    const serverOutput: string[] = [];
    let client: AdbScrcpyClient<DexScrcpyOptions>;
    try {
      client = await AdbScrcpyClient.start(adb, SERVER_PATH, options);
    } catch (error) {
      if (error instanceof AdbScrcpyExitedError) {
        throw new Error(summarizeServerOutput(error.output) ?? "The DeX bridge stopped while starting.");
      }
      throw error;
    }

    void collectOutput(client.output, serverOutput);

    const videoStream = await client.videoStream;
    if (!videoStream) {
      await client.close();
      throw new Error("The phone didn't send any video.");
    }

    const diagnostics: Diagnostics = {};
    const decoder = new WebCodecsVideoDecoder({
      codec: videoStream.metadata.codec,
      renderer: createRenderer(init.canvas),
      optimizeForLatency: true,
    });
    void videoStream.stream.pipeTo(decoder.writable).catch((error: unknown) => {
      // Usually just the session ending; if the decoder broke, `ended` says so.
      if (error instanceof DOMException || (error instanceof Error && /decod/i.test(error.message))) {
        diagnostics.decoderError = `The browser couldn't decode the video (${error.message}). Try H.264.`;
      }
    });

    const audioPlayer = settings.audio ? init.audioPlayer : undefined;
    if (init.audioPlayer && !audioPlayer) {
      void init.audioPlayer.stop();
    }
    // Starts muted: the UI unmutes once it knows the phone isn't locked.
    const audioGate: AudioGate = { muted: true, available: true };
    if (audioPlayer) {
      void startAudio(client, audioPlayer, audioGate, status);
    }

    if (client.clipboard && init.onClipboard) {
      void forwardClipboard(client.clipboard, init.onClipboard);
    }

    return new DexSession(
      client,
      videoStream,
      init.display,
      decoder,
      audioPlayer,
      audioGate,
      serverOutput,
      diagnostics,
      device,
      adb,
    );
  }

  /** Ask the phone to resize the virtual display (flex display). */
  resize(width: number, height: number): void {
    // Compare with the last request too: while a resize is in flight,
    // `videoSize` still holds the old size.
    const last = this.#requestedSize ?? this.#videoSize;
    if (width === last.width && height === last.height) {
      return;
    }
    this.#requestedSize = { width, height };
    void this.#client.controller?.resizeDisplay({ width, height }).catch(() => {});
  }

  /** While blocked (phone locked), every input path sees no controller. */
  setInputBlocked(blocked: boolean): void {
    this.#inputBlocked = blocked;
  }

  /**
   * Streams the phone's screen and lock state, about once a second, until the
   * returned function is called. Reports `undefined` whenever the state is
   * unknown (starting up, the shell died, or no report for a few seconds), so
   * the UI can fail closed.
   */
  watchPhoneState(onChange: (state: PhoneState | undefined) => void): () => void {
    let disposed = false;
    let process: AdbNoneProtocolProcess | undefined;
    let retryTimer = 0;
    let last: string | undefined = "";
    let lastReportAt = 0;

    const report = (line: string | undefined) => {
      if (line === last || disposed) {
        return;
      }
      last = line;
      onChange(line === undefined ? undefined : parsePhoneState(line));
    };

    // A hung or silent shell must not leave a stale "unlocked" in force.
    const watchdog = window.setInterval(() => {
      if (performance.now() - lastReportAt > STATE_STALE_AFTER_MS) {
        report(undefined);
      }
    }, 1000);

    // One long-lived shell instead of a new one per check. Each line looks
    // like "mWakefulness=Awake deviceLocked=1" (lock state of the current user).
    const script =
      "while true; do " +
      "echo \"$(dumpsys power 2>/dev/null | grep -m1 -o 'mWakefulness=[A-Za-z]*') " +
      "$(dumpsys trust 2>/dev/null | grep -m1 '(current)' | grep -o 'deviceLocked=[01]')\"; " +
      "sleep 1; done";

    const run = async () => {
      try {
        process = await this.#adb.subprocess.noneProtocol.spawn(script);
        if (disposed) {
          await process.kill();
          return;
        }
        const reader = process.output.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) {
            break;
          }
          buffered += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            lastReportAt = performance.now();
            report(line);
          }
        }
      } catch {
        // The shell died (session ending, adb hiccup); retry below.
      }
      report(undefined);
      if (!disposed && !this.#closed) {
        retryTimer = window.setTimeout(() => void run(), 2000);
      }
    };
    void run();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      void Promise.resolve(process?.kill()).catch(() => {});
    };
  }

  /** Turns the phone's screen on so the user can unlock it. */
  async wakePhone(): Promise<void> {
    await this.#adb.subprocess.noneProtocol.spawn(["input", "keyevent", "KEYCODE_WAKEUP"]).wait();
  }

  /** Turns the phone's screen off, which locks it (like pressing the side key). */
  async lockPhone(): Promise<void> {
    await this.#adb.subprocess.noneProtocol.spawn(["input", "keyevent", "KEYCODE_SLEEP"]).wait();
  }

  /**
   * Turn the phone's own screen off (or back on) while DeX keeps running.
   * Allowed while DeX is hidden: it reveals nothing and can't unlock anything.
   */
  setPhoneScreenPower(on: boolean): void {
    void this.#client.controller?.setDisplayPower(on).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closeRequested = true;
    await this.#client.close().catch(() => {});
    await this.#ended;
  }

  #describeExit(): string | undefined {
    if (this.#closed || this.#closeRequested) {
      return undefined;
    }
    return (
      this.#diagnostics.decoderError ??
      summarizeServerOutput(this.#serverOutput) ??
      "DeX stopped on the phone."
    );
  }

  #teardown(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#decoder.dispose();
    void this.#audioPlayer?.stop().catch(() => {});
    void this.#client.close().catch(() => {});
  }
}

/** No report for this long means the lock state is unknown. */
const STATE_STALE_AFTER_MS = 3500;

/**
 * Fails closed: the phone only counts as awake/unlocked when the report says
 * so explicitly; missing or garbled fields count as asleep/locked.
 */
function parsePhoneState(line: string): PhoneState {
  return {
    awake: /mWakefulness=Awake\b/.test(line),
    locked: !/deviceLocked=0\b/.test(line),
  };
}

async function readDeviceSummary(adb: Adb): Promise<DeviceSummary> {
  const [model, manufacturer, androidVersion, oneUi] = await Promise.all([
    adb.getProp("ro.product.model"),
    adb.getProp("ro.product.manufacturer"),
    adb.getProp("ro.build.version.release"),
    adb.getProp("ro.build.version.oneui"),
  ]);
  const oneUiVersion = Number.parseInt(oneUi, 10);
  return {
    model: model.trim(),
    manufacturer: manufacturer.trim(),
    androidVersion: androidVersion.trim(),
    oneUiVersion: Number.isFinite(oneUiVersion) ? oneUiVersion : undefined,
  };
}

async function pushServer(adb: Adb): Promise<void> {
  const response = await fetch(new URL("scrcpy-server.jar", document.baseURI));
  if (!response.ok) {
    throw new Error(`Couldn't load the scrcpy server (${response.status}). Reinstall DeXterous or run \`npm run build\`.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    SERVER_PATH,
  );
}

function createRenderer(canvas: HTMLCanvasElement): VideoFrameRenderer {
  // The canvas keeps the video's resolution; CSS scales it to fit.
  if (WebGLVideoFrameRenderer.isSupported) {
    return new WebGLVideoFrameRenderer({ canvas });
  }
  return new BitmapVideoFrameRenderer({ canvas });
}

async function startAudio(
  client: AdbScrcpyClient<DexScrcpyOptions>,
  player: Int16PcmPlayer,
  gate: AudioGate,
  status: (message: string) => void,
): Promise<void> {
  const metadata = await client.audioStream;
  if (!metadata || metadata.type !== "success") {
    gate.available = false;
    void player.stop();
    if (metadata?.type === "errored") {
      status("Audio isn't available from this phone; continuing without it.");
    }
    return;
  }

  try {
    await player.start();
  } catch {
    // Without a player, cancel the stream so it can't back up the connection.
    gate.available = false;
    void player.stop();
    await metadata.stream.cancel().catch(() => {});
    return;
  }

  await metadata.stream
    .pipeTo(
      new WritableStream<ScrcpyAudioStreamPacket>({
        write(packet) {
          if (packet.type !== "data" || gate.muted) {
            return;
          }
          // The player transfers the buffer to its worklet, so hand it a copy
          // that is aligned for Int16Array.
          const samples = new Int16Array(packet.data.byteLength >> 1);
          new Uint8Array(samples.buffer).set(packet.data.subarray(0, samples.byteLength));
          player.feed(samples);
        },
      }),
    )
    .catch(() => {});
}

async function forwardClipboard(
  stream: ReadableStream<string>,
  onClipboard: (text: string) => void,
): Promise<void> {
  try {
    for await (const text of stream) {
      onClipboard(text);
    }
  } catch {
    // Ends with the session.
  }
}

async function collectOutput(output: ReadableStream<string>, lines: string[]): Promise<void> {
  try {
    for await (const line of output) {
      lines.push(line);
      if (lines.length > 200) {
        lines.shift();
      }
      console.debug("[scrcpy]", line);
    }
  } catch {
    // Ends with the session.
  }
}

/** Pick the most useful line from the server log for an error message. */
function summarizeServerOutput(lines: readonly string[]): string | undefined {
  const error = [...lines].reverse().find((line) => /ERROR|Exception/.test(line));
  if (!error) {
    return undefined;
  }
  if (/Could not create display|createVirtualDisplay/i.test(error)) {
    return "The phone refused to create a virtual display. DeX in the browser needs One UI 8 or newer.";
  }
  return error.replace(/^\[server\]\s*/, "").trim();
}
