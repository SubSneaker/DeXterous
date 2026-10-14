/**
 * Keyboard helpers: DOM `KeyboardEvent.code` → Android key codes, Android
 * meta-state computation, and platform detection.
 *
 * Everything here is pure (no DOM listeners) so it can be unit-tested.
 */
import { AndroidKeyCode, AndroidKeyEventMeta } from "@yume-chan/scrcpy";

/**
 * Real Android key codes (android.view.KeyEvent) that Tango's `AndroidKeyCode`
 * table does not define but that ordinary PC keyboards can produce.
 */
const ExtraAndroidKeyCode = {
  MediaPlayPause: 85,
  MediaStop: 86,
  MediaNext: 87,
  MediaPrevious: 88,
  Henkan: 214,
  Muhenkan: 213,
  KatakanaHiragana: 215,
  Yen: 216,
  Ro: 217,
  Calculator: 210,
  Refresh: 285,
} as const;

/**
 * DOM codes whose names differ from Tango's `AndroidKeyCode` names (which
 * already match the standard DOM codes for everything else).
 */
const DOM_CODE_ALIASES: Readonly<Record<string, number>> = {
  // Legacy Firefox names for the Windows / Command keys.
  OSLeft: AndroidKeyCode.MetaLeft,
  OSRight: AndroidKeyCode.MetaRight,
  // ISO key between left Shift and Z; Android's Generic.kl maps it to BACKSLASH.
  IntlBackslash: AndroidKeyCode.Backslash,
  IntlRo: ExtraAndroidKeyCode.Ro,
  IntlYen: ExtraAndroidKeyCode.Yen,
  Convert: ExtraAndroidKeyCode.Henkan,
  NonConvert: ExtraAndroidKeyCode.Muhenkan,
  KanaMode: ExtraAndroidKeyCode.KatakanaHiragana,
  NumpadEqual: AndroidKeyCode.NumpadEquals,
  NumpadParenLeft: AndroidKeyCode.NumpadLeftParen,
  NumpadParenRight: AndroidKeyCode.NumpadRightParen,
  AudioVolumeUp: AndroidKeyCode.VolumeUp,
  AudioVolumeDown: AndroidKeyCode.VolumeDown,
  AudioVolumeMute: AndroidKeyCode.VolumeMute,
  MediaPlayPause: ExtraAndroidKeyCode.MediaPlayPause,
  MediaStop: ExtraAndroidKeyCode.MediaStop,
  MediaTrackNext: ExtraAndroidKeyCode.MediaNext,
  MediaTrackPrevious: ExtraAndroidKeyCode.MediaPrevious,
  BrowserBack: AndroidKeyCode.AndroidBack,
  BrowserForward: AndroidKeyCode.AndroidForward,
  BrowserSearch: AndroidKeyCode.AndroidSearch,
  BrowserRefresh: ExtraAndroidKeyCode.Refresh,
  LaunchMail: AndroidKeyCode.AndroidEnvelope,
  LaunchApp2: ExtraAndroidKeyCode.Calculator,
  Copy: AndroidKeyCode.AndroidCopy,
  Cut: AndroidKeyCode.AndroidCut,
  Paste: AndroidKeyCode.AndroidPaste,
};

/**
 * Tango names that must never be produced from a DOM code even though a DOM
 * code with the same name exists. `Power` would put the phone to sleep and
 * end the DeX session.
 */
const BLOCKED_NAMES: ReadonlySet<string> = new Set(["Power"]);

const DOM_CODE_TO_ANDROID: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [name, value] of Object.entries(AndroidKeyCode)) {
    // `Android*` entries are Android-only keys with no DOM counterpart.
    if (typeof value === "number" && !name.startsWith("Android") && !BLOCKED_NAMES.has(name)) {
      map.set(name, value);
    }
  }
  for (const [code, value] of Object.entries(DOM_CODE_ALIASES)) {
    map.set(code, value);
  }
  return map;
})();

/** Android key code for a DOM `KeyboardEvent.code`, or `undefined` if unmapped. */
export function domCodeToAndroidKeyCode(code: string): number | undefined {
  return DOM_CODE_TO_ANDROID.get(code);
}

/**
 * Lock keys are not forwarded as key presses: the browser already resolves
 * them into the characters it reports, and their state travels in every key
 * event's `metaState`. (macOS also never sends a keyup for Caps Lock until it
 * is toggled off, which would leave it "held" on the phone.)
 */
export const LOCK_KEY_CODES: ReadonlySet<string> = new Set(["CapsLock", "NumLock", "ScrollLock"]);

/** DOM codes of the Shift / Ctrl / Alt / Meta keys themselves. */
export const MODIFIER_KEY_CODES: ReadonlySet<string> = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** Snapshot of the modifier flags of a DOM keyboard / mouse event. */
export interface ModifierFlags {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  capsLock: boolean;
  numLock: boolean;
  scrollLock: boolean;
}

export function readModifierFlags(event: KeyboardEvent): ModifierFlags {
  return {
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    capsLock: event.getModifierState("CapsLock"),
    numLock: event.getModifierState("NumLock"),
    scrollLock: event.getModifierState("ScrollLock"),
  };
}

/**
 * Modifier state after applying "⌘ acts as Ctrl". Only the LEFT ⌘ becomes
 * Ctrl; the right one stays Meta so DeX's ⊞ shortcuts (⊞+D, ⊞+arrows,
 * ⊞+/) remain reachable. DOM `metaKey` doesn't say which side is down, so
 * `heldCodes` (DOM codes currently held) decides; an unseen ⌘ (pressed
 * before the page had focus) counts as the left one.
 */
export function effectiveModifiers(
  flags: ModifierFlags,
  commandAsCtrl: boolean,
  heldCodes: { has(code: string): boolean },
): ModifierFlags {
  if (!commandAsCtrl || !flags.meta) {
    return flags;
  }
  const left = heldCodes.has("MetaLeft") || heldCodes.has("OSLeft");
  const right = heldCodes.has("MetaRight") || heldCodes.has("OSRight");
  return { ...flags, ctrl: flags.ctrl || left || !right, meta: right };
}

/**
 * Android key code to send for a DOM code, honouring "⌘ acts as Ctrl"
 * (left ⌘ becomes Ctrl, right ⌘ stays Meta).
 */
export function resolveAndroidKeyCode(code: string, commandAsCtrl: boolean): number | undefined {
  if (commandAsCtrl && (code === "MetaLeft" || code === "OSLeft")) {
    return AndroidKeyCode.ControlLeft;
  }
  return domCodeToAndroidKeyCode(code);
}

/** Label for the key that acts as DeX's ⊞ / Meta key, for the UI. */
export function metaKeyLabel(commandAsCtrl: boolean): string {
  if (isMacLike()) {
    return commandAsCtrl ? "Right ⌘" : "⌘";
  }
  return commandAsCtrl ? "Right ⊞ Win" : "⊞ Win";
}

/**
 * The app's own shortcut chord: physical Ctrl + Alt (⌃⌥ on Mac) plus a
 * non-modifier key. AltGr, which Windows reports as Ctrl + Alt, is excluded
 * because it types characters.
 */
export function isAppChord(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.metaKey &&
    // AltGr on Windows/Linux reports Ctrl+Alt, so exclude it there. On Macs,
    // Firefox reports Option as AltGraph, which must not disable the chord.
    (isMacLike() || !event.getModifierState("AltGraph")) &&
    !MODIFIER_KEY_CODES.has(event.code)
  );
}

/** Label for the app chord's modifiers, e.g. "⌃⌥" + "K". */
export function appChordLabel(): string {
  return isMacLike() ? "⌃⌥" : "Ctrl+Alt";
}

interface ModifierBits {
  /** Generic bit, e.g. META_SHIFT_ON. */
  on: number;
  left: number;
  right: number;
  leftKey: number;
  rightKey: number;
}

const SHIFT_BITS: ModifierBits = {
  on: AndroidKeyEventMeta.Shift,
  left: AndroidKeyEventMeta.ShiftLeft,
  right: AndroidKeyEventMeta.ShiftRight,
  leftKey: AndroidKeyCode.ShiftLeft,
  rightKey: AndroidKeyCode.ShiftRight,
};
const CTRL_BITS: ModifierBits = {
  on: AndroidKeyEventMeta.Ctrl,
  left: AndroidKeyEventMeta.CtrlLeft,
  right: AndroidKeyEventMeta.CtrlRight,
  leftKey: AndroidKeyCode.ControlLeft,
  rightKey: AndroidKeyCode.ControlRight,
};
const ALT_BITS: ModifierBits = {
  on: AndroidKeyEventMeta.Alt,
  left: AndroidKeyEventMeta.AltLeft,
  right: AndroidKeyEventMeta.AltRight,
  leftKey: AndroidKeyCode.AltLeft,
  rightKey: AndroidKeyCode.AltRight,
};
const META_BITS: ModifierBits = {
  on: AndroidKeyEventMeta.Meta,
  left: AndroidKeyEventMeta.MetaLeft,
  right: AndroidKeyEventMeta.MetaRight,
  leftKey: AndroidKeyCode.MetaLeft,
  rightKey: AndroidKeyCode.MetaRight,
};

function sideBits(bits: ModifierBits, heldAndroidKeys: ReadonlySet<number>): number {
  const left = heldAndroidKeys.has(bits.leftKey);
  const right = heldAndroidKeys.has(bits.rightKey);
  // Flags say the modifier is down but we never saw which key (e.g. it was
  // pressed before the page had focus): assume the left one.
  return bits.on | (left || !right ? bits.left : 0) | (right ? bits.right : 0);
}

/**
 * Android `metaState` for a key event.
 *
 * @param flags Modifier flags of the DOM event, already passed through
 *   {@link effectiveModifiers}.
 * @param heldAndroidKeys Android key codes currently held down (used only to
 *   tell left from right modifiers).
 */
export function computeMetaState(flags: ModifierFlags, heldAndroidKeys: ReadonlySet<number>): number {
  let meta = 0;
  if (flags.shift) meta |= sideBits(SHIFT_BITS, heldAndroidKeys);
  if (flags.ctrl) meta |= sideBits(CTRL_BITS, heldAndroidKeys);
  if (flags.alt) meta |= sideBits(ALT_BITS, heldAndroidKeys);
  if (flags.meta) meta |= sideBits(META_BITS, heldAndroidKeys);
  if (flags.capsLock) meta |= AndroidKeyEventMeta.CapsLock;
  if (flags.numLock) meta |= AndroidKeyEventMeta.NumLock;
  if (flags.scrollLock) meta |= AndroidKeyEventMeta.ScrollLock;
  return meta;
}

/**
 * Whether `key` (a `KeyboardEvent.key` value) is a single printed character
 * rather than a named key like "Enter" or "ArrowUp". Counts code points so
 * astral characters (surrogate pairs, e.g. emoji) qualify.
 */
export function isPrintableKey(key: string): boolean {
  if (key.length === 0 || key.length > 2) {
    return false;
  }
  const codePoints = [...key];
  return codePoints.length === 1 && codePoints[0] >= " " && codePoints[0] !== "\u007f";
}

/** Text that scrcpy's `injectText` can type (it only handles printable ASCII). */
export function isInjectableAscii(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text);
}

/** Minimal shape of a keyboard event needed by {@link isPasteShortcut}. */
export interface ShortcutKeyInfo {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether this keydown is the browser's own paste shortcut (Ctrl+V,
 * Ctrl+Shift+V or Shift+Insert; ⌘V on Apple platforms). Those keydowns must
 * reach the browser untouched so it fires a `paste` event carrying the
 * this device's clipboard.
 */
export function isPasteShortcut(event: ShortcutKeyInfo, macLike: boolean): boolean {
  if (event.altKey) {
    return false;
  }
  // Shortcuts follow the layout's letter when it is Latin, otherwise
  // (Hebrew, Cyrillic, ...) the physical key position.
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : event.code === "KeyV" ? "v" : "";
  if (macLike) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && letter === "v";
  }
  if (event.ctrlKey && !event.metaKey && letter === "v") {
    return true;
  }
  return event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "Insert";
}

interface NavigatorUAData {
  platform?: string;
}

/** True on macOS, iOS and iPadOS, where ⌘ plays the role of Ctrl. */
export function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  if (/mac|iphone|ipad|ipod/i.test(platform)) {
    return true;
  }
  return /Mac OS X|iPhone|iPad|iPod/.test(navigator.userAgent);
}
