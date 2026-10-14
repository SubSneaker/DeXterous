import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";

/** A size in device pixels (the phone's virtual display / video stream). */
export interface VideoSize {
  width: number;
  height: number;
}

/**
 * What the input layer needs from a live session.
 * `controller` is undefined while connecting or after the session ended,
 * so every send must be guarded.
 */
export interface InputSink {
  readonly controller: ScrcpyControlMessageWriter | undefined;
  /** Current size of the virtual display (== decoded video size). */
  readonly videoSize: VideoSize;
}

export interface InputSettings {
  /**
   * Treat ⌘ (Command) as Ctrl so Mac shortcuts like ⌘C / ⌘V / ⌘A behave
   * like DeX's Ctrl shortcuts. Defaults to true on macOS / iPadOS.
   */
  commandAsCtrl: boolean;
}

/** How the page talks to the phone. */
export type TransportKind = "relay" | "webusb";

/** A phone the user can pick from the connect screen. */
export interface DeviceChoice {
  kind: TransportKind;
  /** Stable id for the phone card, built from the serial. */
  id: string;
  /** Human label, e.g. "SM-F976Q · USB". */
  label: string;
  serial: string;
  /** Model code (or the best name the transport knows), e.g. "SM-F976Q". */
  model: string;
  /** Reached over Wi‑Fi rather than a cable. */
  wireless: boolean;
  /**
   * Relay: the adb state is "device", so the phone has allowed the computer running DeXterous.
   * WebUSB: always true here; the browser asks the phone when connecting.
   */
  ready: boolean;
  /** For relay devices: the adb server transport id. */
  transportId?: bigint;
  /** For WebUSB devices: whatever the transport needs to reconnect. */
  handle?: unknown;
}

/** Persisted user preferences (localStorage). */
export interface DexSettings {
  /** Render scale: virtual display pixels per CSS pixel. 1 | 1.5 | 2 */
  resolutionScale: number;
  /** DeX UI zoom: multiplies the virtual display DPI. 0.75 .. 1.5 */
  uiZoom: number;
  videoCodec: "h264" | "h265" | "av1";
  /** Megabits per second. */
  videoBitRate: number;
  maxFps: number;
  /** Forward phone audio to the browser (phone speaker goes quiet). */
  audio: boolean;
  /** Keep the phone's own screen usable for audio (duplicate instead of redirect). */
  audioDup: boolean;
  /**
   * Share one clipboard with this device: phone copies reach this device and
   * Ctrl/⌘V pastes this device's clipboard. Off: the clipboards are separate.
   */
  clipboardSync: boolean;
  /** Show the Android on-screen keyboard on the DeX display. */
  showAndroidKeyboard: boolean;
  commandAsCtrl: boolean;
  /** When the tab closes, move open apps to the phone instead of closing them. */
  keepAppsOnDisconnect: boolean;
  /**
   * Keep DeX usable while the phone itself is locked. Off by default: when the
   * phone locks, DeXterous hides the desktop and ignores input until it's unlocked.
   */
  allowWhileLocked: boolean;
}
