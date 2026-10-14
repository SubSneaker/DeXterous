/**
 * Input layer: turns DOM pointer / wheel / keyboard / clipboard events into
 * scrcpy control messages for the DeX virtual display.
 *
 * Integration notes (styling is the integrator's job, nothing here sets CSS):
 * - The canvas needs `touch-action: none` (plus `user-select: none` and
 *   `-webkit-touch-callout: none` for iOS) and no CSS border or padding,
 *   because coordinates are mapped from its border box assuming
 *   `object-fit: contain`.
 * - The keyboard textarea must stay focusable (not `display: none` or
 *   `visibility: hidden`) but be visually hidden, e.g. absolutely positioned,
 *   1px, `opacity: 0`, transparent caret, no resize handle.
 */
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  ScrcpyPointerId,
} from "@yume-chan/scrcpy";
import type { AndroidKeyEventMeta, ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import {
  computeMetaState,
  effectiveModifiers,
  isInjectableAscii,
  isMacLike,
  isPasteShortcut,
  isPrintableKey,
  LOCK_KEY_CODES,
  MODIFIER_KEY_CODES,
  readModifierFlags,
  resolveAndroidKeyCode,
} from "./keymap";
import type { ModifierFlags } from "./keymap";
import type { InputSettings, InputSink, VideoSize } from "./types";

/** App callbacks; can be swapped at any time with {@link InputController.setHooks}. */
export interface InputControllerHooks {
  /**
   * Called first for every keydown in the textarea, even while input is
   * blocked. Return true to claim the key for the app: the keydown is
   * prevented and not forwarded, and its keyup is swallowed. Modifiers already
   * forwarded (the Ctrl / Alt of a chord) stay forwarded and release normally.
   */
  onShortcut?: (event: KeyboardEvent) => boolean;
  /**
   * Return true to forward the paste shortcut (Ctrl+V, Ctrl+Shift+V,
   * Shift+Insert; ⌘V on Apple platforms) to the phone as ordinary key events,
   * so DeX pastes the phone's own clipboard, instead of letting the browser
   * paste this device's clipboard.
   */
  preferPhonePaste?: () => boolean;
}

export interface InputControllerOptions extends InputControllerHooks {
  /** Pointer + wheel events target, displayed with `object-fit: contain`. */
  canvas: HTMLCanvasElement;
  /** Hidden textarea that holds keyboard focus. */
  keyboardTarget: HTMLTextAreaElement;
  /**
   * Input is blocked while `sink.controller` is undefined; nothing is queued
   * and held keys / buttons are released once it comes back.
   */
  sink: InputSink;
  settings: InputSettings;
  /**
   * Value handed to `injectScroll` per wheel notch. scrcpy ≥ 3.3.1 servers
   * read the wire value as `value × 16` notches; Tango's `ScrcpyOptions3_3_x`
   * divides by 16 for you, but its `ScrcpyOptions4_0`+ (including
   * `AdbScrcpyOptionsLatest` / 5.0.1) does not, so the default is `1 / 16`.
   * Pass `1` when using `ScrcpyOptions3_3_x`.
   */
  scrollNotchScale?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A position in video (virtual display) pixels. */
export interface VideoPoint {
  x: number;
  y: number;
  /** False when the client position is outside the video, e.g. over a letterbox bar. */
  inside: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The part of an `object-fit: contain` box that the video actually covers. */
export function containedContentRect(box: Rect, video: VideoSize): Rect {
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * Map a client (viewport) position to integer video pixels, clamped to
 * `[0, size - 1]`. Returns `undefined` while the video or box has no size.
 */
export function clientToVideoPoint(
  clientX: number,
  clientY: number,
  box: Rect,
  video: VideoSize,
): VideoPoint | undefined {
  if (video.width <= 0 || video.height <= 0 || box.width <= 0 || box.height <= 0) {
    return undefined;
  }
  const content = containedContentRect(box, video);
  const relX = (clientX - content.left) / content.width;
  const relY = (clientY - content.top) / content.height;
  return {
    x: clamp(Math.floor(relX * video.width), 0, video.width - 1),
    y: clamp(Math.floor(relY * video.height), 0, video.height - 1),
    inside: relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1,
  };
}

/**
 * Mouse button bits, identical in DOM `PointerEvent.buttons` and Android
 * `MotionEvent` buttons: primary, secondary, tertiary, back, forward.
 */
const MOUSE_BUTTON_BITS = [1, 2, 4, 8, 16] as const;
const ALL_MOUSE_BUTTONS = 0b11111;
/** Buttons forwarded as pointer buttons (left, right, middle). */
const POINTER_BUTTONS = 0b00111;

/**
 * Real Android mice get their back / forward buttons turned into
 * KEYCODE_BACK / KEYCODE_FORWARD by the framework's InputReader. Injected
 * motion events skip that step, so the side buttons are sent as key presses.
 */
const SIDE_BUTTON_KEY_CODES: ReadonlyMap<number, number> = new Map([
  [8, AndroidKeyCode.AndroidBack],
  [16, AndroidKeyCode.AndroidForward],
]);

export interface ButtonChange {
  /** The single button bit that changed. */
  button: number;
  pressed: boolean;
  /** Full bitmask right after this change. */
  buttonsAfter: number;
}

/**
 * Per-button transitions from `previous` to `next`, releases first, one
 * entry per changed bit. Needed because a second button pressed while one is
 * held fires `pointermove`, not `pointerdown` (chorded buttons).
 */
export function diffButtons(previous: number, next: number): ButtonChange[] {
  const changes: ButtonChange[] = [];
  let current = previous;
  for (const bit of MOUSE_BUTTON_BITS) {
    if (current & bit && !(next & bit)) {
      current &= ~bit;
      changes.push({ button: bit, pressed: false, buttonsAfter: current });
    }
  }
  for (const bit of MOUSE_BUTTON_BITS) {
    if (!(current & bit) && next & bit) {
      current |= bit;
      changes.push({ button: bit, pressed: true, buttonsAfter: current });
    }
  }
  return changes;
}

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** Chrome / Edge / Safari report ~100px per mouse-wheel notch. */
const PIXELS_PER_NOTCH = 100;
/** Firefox reports 3 lines per mouse-wheel notch. */
const LINES_PER_NOTCH = 3;

/** Convert a DOM wheel delta to wheel notches (same sign as the DOM delta). */
export function wheelDeltaToNotches(delta: number, deltaMode: number): number {
  switch (deltaMode) {
    case DOM_DELTA_LINE:
      return delta / LINES_PER_NOTCH;
    case DOM_DELTA_PAGE:
      return delta;
    default:
      return delta / PIXELS_PER_NOTCH;
  }
}

/**
 * Wheel event → `injectScroll` values. Android's AXIS_HSCROLL is positive
 * towards the right like DOM `deltaX`, but AXIS_VSCROLL is positive *up*,
 * the opposite of DOM `deltaY`. Shift + vertical wheel scrolls horizontally
 * (Android only does that itself when the event carries Shift in its meta
 * state, which scroll messages cannot). Results are clamped to the wire range
 * [-1, 1] (16 notches at the default scale); a single wheel event never gets
 * near that in practice.
 */
export function wheelToScroll(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  notchScale: number,
): { scrollX: number; scrollY: number } {
  const horizontalFromShift = event.shiftKey && event.deltaX === 0;
  const deltaX = horizontalFromShift ? event.deltaY : event.deltaX;
  const deltaY = horizontalFromShift ? 0 : event.deltaY;
  return {
    scrollX: clamp(wheelDeltaToNotches(deltaX, event.deltaMode) * notchScale, -1, 1),
    scrollY: clamp(-wheelDeltaToNotches(deltaY, event.deltaMode) * notchScale, -1, 1),
  };
}

/** Cut `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  // A UTF-16 code unit never takes more than 3 UTF-8 bytes.
  if (text.length * 3 <= maxBytes) {
    return text;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** scrcpy's `injectText` limit (CONTROL_MSG_INJECT_TEXT_MAX_LENGTH). */
const INJECT_TEXT_MAX_LENGTH = 300;
/** scrcpy's clipboard limit (SC_CONTROL_MSG_CLIPBOARD_TEXT_MAX_LENGTH, bytes). */
const CLIPBOARD_TEXT_MAX_BYTES = (1 << 18) - 14;
/** `KeyboardEvent.keyCode` while an IME is processing the key. */
const IME_PROCESS_KEY_CODE = 229;

interface HeldKey {
  keyCode: number;
  repeat: number;
}

interface ClientPosition {
  clientX: number;
  clientY: number;
}


/**
 * State tracked here always mirrors what the phone believes (it only changes
 * when a message is actually handed to a controller), so nothing gets stuck
 * when input is blocked mid-gesture: lost releases are sent once
 * `sink.controller` comes back.
 */
export class InputController {
  readonly #canvas: HTMLCanvasElement;
  readonly #keyboard: HTMLTextAreaElement;
  readonly #sink: InputSink;
  readonly #scrollNotchScale: number;
  readonly #macLike = isMacLike();
  readonly #listeners = new AbortController();
  #settings: InputSettings;
  #hooks: InputControllerHooks;
  /** `sink.controller` as of the last event, to notice input being unblocked. */
  #controllerSeen: ScrcpyControlMessageWriter | undefined;

  /** Mouse buttons the phone considers pressed (DOM / Android bit layout). */
  #mouseButtons = 0;
  /**
   * Physically held buttons that must not reach the phone until released:
   * pressed over a letterbox bar, while input was blocked, or still held when
   * the phone's buttons were force-released.
   */
  #ignoredMouseButtons = 0;
  #lastMousePosition: ClientPosition | undefined;
  /** Touch / pen pointers the phone considers down → last position. */
  readonly #touches = new Map<number, ClientPosition>();

  /** DOM `code` → key the phone considers held, so it can be released later. */
  readonly #heldKeys = new Map<string, HeldKey>();
  /** DOM codes claimed by `onShortcut`, whose keyup must not leak. */
  readonly #swallowedKeyups = new Set<string>();
  #composing = false;
  /** Set while a keydown we handled is in flight, to drop a duplicate `beforeinput`. */
  #keydownHandled = false;
  #reportedSendError = false;

  constructor(options: InputControllerOptions) {
    this.#canvas = options.canvas;
    this.#keyboard = options.keyboardTarget;
    this.#sink = options.sink;
    this.#settings = { ...options.settings };
    this.#hooks = { onShortcut: options.onShortcut, preferPhonePaste: options.preferPhonePaste };
    this.#scrollNotchScale = options.scrollNotchScale ?? 1 / 16;
    this.#controllerSeen = options.sink.controller;

    // The textarea is always emptied, so autocorrect / autocapitalize would
    // only ever see a blank field (and iOS would capitalize every letter).
    this.#keyboard.setAttribute("autocomplete", "off");
    this.#keyboard.setAttribute("autocorrect", "off");
    this.#keyboard.setAttribute("autocapitalize", "off");
    this.#keyboard.setAttribute("spellcheck", "false");

    const canvas = this.#canvas;
    this.#listen(canvas, "pointerdown", this.#onPointerDown);
    this.#listen(canvas, "pointermove", this.#onPointerMove);
    this.#listen(canvas, "pointerup", this.#onPointerUp);
    this.#listen(canvas, "pointercancel", this.#onPointerCancel);
    this.#listen(canvas, "lostpointercapture", this.#onPointerCancel);
    this.#listen(canvas, "wheel", this.#onWheel, { passive: false });

    const signal = this.#listeners.signal;
    // Right-click must reach Android (DeX context menus), not the browser.
    canvas.addEventListener("contextmenu", preventDefault, { signal });
    // Keeps focus in the textarea and stops text selection, drag and
    // middle-click autoscroll.
    canvas.addEventListener("mousedown", preventDefault, { signal });
    canvas.addEventListener("mouseup", this.#onMouseUp, { signal });
    canvas.addEventListener("auxclick", preventDefault, { signal });
    // Safari trackpad / touch pinch → page zoom.
    canvas.addEventListener("gesturestart", preventDefault, { signal });

    const keyboard = this.#keyboard;
    this.#listen(keyboard, "keydown", this.#onKeyDown);
    this.#listen(keyboard, "keyup", this.#onKeyUp);
    this.#listen(keyboard, "beforeinput", this.#onBeforeInput);
    this.#listen(keyboard, "input", this.#onInput);
    this.#listen(keyboard, "compositionstart", this.#onCompositionStart);
    this.#listen(keyboard, "compositionend", this.#onCompositionEnd);
    this.#listen(keyboard, "paste", this.#onPaste);
    keyboard.addEventListener("blur", this.#onKeyboardBlur, { signal });

    window.addEventListener("blur", this.#onWindowBlur, { signal });
    document.addEventListener("visibilitychange", this.#onVisibilityChange, { signal });
  }

  updateSettings(settings: Partial<InputSettings>): void {
    // Held keys were mapped with the old settings; release them first.
    this.#releaseKeys();
    this.#settings = { ...this.#settings, ...settings };
  }

  /** Replace app callbacks; pass `undefined` for a hook to remove it. */
  setHooks(hooks: InputControllerHooks): void {
    this.#hooks = { ...this.#hooks, ...hooks };
  }

  /** Send a full press + release of an Android key (toolbar Back / Home / Recents). */
  pressKey(keyCode: number): void {
    this.#syncController();
    this.#injectKey(AndroidKeyEventAction.Down, keyCode, 0, 0);
    this.#injectKey(AndroidKeyEventAction.Up, keyCode, 0, 0);
  }

  /** Focus the hidden textarea (after toolbar clicks, or to open a soft keyboard). */
  focusKeyboard(): void {
    this.#keyboard.focus({ preventScroll: true });
  }

  /**
   * Release every key, mouse button and touch the phone considers held.
   * Already runs on blur, when the tab is hidden and when input is unblocked.
   * While input is blocked it does nothing, keeping the state so the
   * releases go out once `sink.controller` is back.
   */
  releaseAll(): void {
    this.#releaseKeys();
    this.#releasePointers();
  }

  /** Release all held keys / buttons / touches and remove every event listener. */
  dispose(): void {
    this.releaseAll();
    this.#listeners.abort();
  }

  // -- plumbing -------------------------------------------------------------

  /** Add an input listener that first checks whether input was just unblocked. */
  #listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(
      type,
      (event) => {
        this.#syncController();
        handler(event);
      },
      { ...options, signal: this.#listeners.signal },
    );
  }

  /** Whether messages can reach the phone right now. */
  get #live(): boolean {
    return this.#sink.controller !== undefined;
  }

  /** When the controller comes back, release whatever the phone still holds. */
  #syncController(): void {
    const controller = this.#sink.controller;
    const cameBack = controller !== undefined && this.#controllerSeen === undefined;
    this.#controllerSeen = controller;
    if (cameBack) {
      this.releaseAll();
    }
  }

  /**
   * Fire-and-forget a control message; dropped while input is blocked. The
   * session can close at any moment, so failures are expected; they are
   * logged once at debug level.
   */
  #send(write: (controller: ScrcpyControlMessageWriter) => Promise<void>): void {
    const controller = this.#sink.controller;
    if (!controller) {
      return;
    }
    try {
      write(controller).catch(this.#onSendError);
    } catch (error) {
      this.#onSendError(error);
    }
  }

  #onSendError = (error: unknown): void => {
    if (!this.#reportedSendError) {
      this.#reportedSendError = true;
      console.debug("[input] control message failed", error);
    }
  };

  #injectTouch(
    action: AndroidMotionEventAction,
    pointerId: bigint,
    point: VideoPoint,
    pressure: number,
    actionButton: number,
    buttons: number,
  ): void {
    // Must equal the server's current display size or it drops the event.
    const { width, height } = this.#sink.videoSize;
    this.#send((controller) =>
      controller.injectTouch({
        action,
        pointerId,
        pointerX: point.x,
        pointerY: point.y,
        videoWidth: width,
        videoHeight: height,
        pressure,
        actionButton,
        buttons,
      }),
    );
  }

  #injectKey(action: AndroidKeyEventAction, keyCode: number, repeat: number, metaState: number): void {
    this.#send((controller) =>
      controller.injectKeyCode({
        action,
        // Tango types these as unions of its named constants; any Android key
        // code / combination of meta flags is valid on the wire.
        keyCode: keyCode as AndroidKeyCode,
        repeat,
        metaState: metaState as AndroidKeyEventMeta,
      }),
    );
  }

  /** Type text on the phone. */
  #sendText(text: string): void {
    if (text.length <= INJECT_TEXT_MAX_LENGTH && isInjectableAscii(text)) {
      this.#send((controller) => controller.injectText(text));
    } else {
      // `injectText` can only type ASCII; Hebrew, accents, emoji, IME output
      // and long text go through the phone clipboard + a paste key instead.
      this.#pasteText(text);
    }
  }

  /**
   * Put `text` on the phone clipboard and press paste. `sequence: 0n` skips
   * the acknowledgement round trip. Note this replaces the phone's clipboard
   * (the server tries not to echo its own change back via clipboard sync).
   */
  #pasteText(text: string): void {
    const content = truncateUtf8(text, CLIPBOARD_TEXT_MAX_BYTES);
    this.#send((controller) => controller.setClipboard({ content, paste: true, sequence: 0n }));
  }

  // -- pointer --------------------------------------------------------------

  #toVideoPoint(position: ClientPosition): VideoPoint | undefined {
    return clientToVideoPoint(
      position.clientX,
      position.clientY,
      this.#canvas.getBoundingClientRect(),
      this.#sink.videoSize,
    );
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") {
      this.focusKeyboard();
      if (this.#updateMouse(event, event.buttons) && this.#mouseButtons !== 0) {
        this.#canvas.setPointerCapture(event.pointerId);
      }
      return;
    }

    // Touch / pen. Taps don't focus the textarea on purpose: that would pop
    // up the soft keyboard on every touch (use focusKeyboard() instead).
    const point = this.#toVideoPoint(event);
    if (!point?.inside || !this.#live) {
      return;
    }
    this.#canvas.setPointerCapture(event.pointerId);
    this.#touches.set(event.pointerId, positionOf(event));
    this.#injectTouch(AndroidMotionEventAction.Down, BigInt(event.pointerId), point, event.pressure || 1, 0, 0);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") {
      this.#updateMouse(event, event.buttons);
      return;
    }
    // Pen hovering, a touch that started over the letterbox or while input
    // was blocked: never send a move for a pointer the phone doesn't hold,
    // the server would register it as down.
    if (!this.#live || !this.#touches.has(event.pointerId)) {
      return;
    }
    const point = this.#toVideoPoint(event);
    if (!point) {
      return;
    }
    this.#touches.set(event.pointerId, positionOf(event));
    this.#injectTouch(AndroidMotionEventAction.Move, BigInt(event.pointerId), point, event.pressure || 1, 0, 0);
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") {
      this.#updateMouse(event, event.buttons);
    } else {
      this.#endTouch(event.pointerId, event);
    }
  };

  /** `pointercancel` and `lostpointercapture`: release whatever this pointer still holds. */
  #onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") {
      this.#releaseMouse();
    } else {
      this.#endTouch(event.pointerId, this.#touches.get(event.pointerId) ?? event);
    }
  };

  /**
   * Lift a touch / pen pointer. Cancellations are also sent as `Up`: the
   * scrcpy server only forgets a pointer on ACTION_UP, so an ACTION_CANCEL
   * would leave a ghost finger that turns every later touch into multi-touch.
   * While input is blocked the pointer stays tracked, to be lifted later.
   */
  #endTouch(pointerId: number, position: ClientPosition): void {
    if (!this.#live || !this.#touches.delete(pointerId)) {
      return;
    }
    const point = this.#toVideoPoint(position);
    if (point) {
      this.#injectTouch(AndroidMotionEventAction.Up, BigInt(pointerId), point, 0, 0, 0);
    }
  }

  /**
   * Bring the phone's mouse in line with `domButtons` at `position`: one
   * Down / Up per changed button (scrcpy semantics: `actionButton` = that
   * button, `buttons` = mask after the change), otherwise a Move (buttons
   * held) or HoverMove (no buttons). Returns false if nothing was sent.
   */
  #updateMouse(position: ClientPosition, domButtons: number): boolean {
    const point = this.#toVideoPoint(position);
    if (!point) {
      return false;
    }
    this.#lastMousePosition = positionOf(position);

    const buttons = domButtons & ALL_MOUSE_BUTTONS;
    const live = this.#live;
    // A released button stops being ignored. A new press is ignored until
    // released if input is blocked, or if it starts over the letterbox while
    // no drag is in progress.
    this.#ignoredMouseButtons &= buttons;
    if (!live || (!point.inside && this.#mouseButtons === 0)) {
      this.#ignoredMouseButtons |= buttons & ~this.#mouseButtons;
    }
    if (!live) {
      return false;
    }
    const target = buttons & ~this.#ignoredMouseButtons;

    const changes = diffButtons(this.#mouseButtons, target);
    this.#mouseButtons = target;
    for (const change of changes) {
      this.#sendMouseButton(change, point);
    }
    if (changes.length > 0) {
      return true;
    }

    const pointerButtons = target & POINTER_BUTTONS;
    if (pointerButtons !== 0) {
      this.#injectTouch(AndroidMotionEventAction.Move, ScrcpyPointerId.Mouse, point, 1, 0, pointerButtons);
    } else if (point.inside) {
      this.#injectTouch(AndroidMotionEventAction.HoverMove, ScrcpyPointerId.Mouse, point, 0, 0, 0);
    }
    // No HoverExit when leaving the video: the server would treat it as a
    // finger event and never release the mouse pointer.
    return true;
  }

  #sendMouseButton(change: ButtonChange, point: VideoPoint): void {
    const sideKeyCode = SIDE_BUTTON_KEY_CODES.get(change.button);
    if (sideKeyCode !== undefined) {
      const action = change.pressed ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up;
      this.#injectKey(action, sideKeyCode, 0, 0);
      return;
    }
    const buttons = change.buttonsAfter & POINTER_BUTTONS;
    this.#injectTouch(
      change.pressed ? AndroidMotionEventAction.Down : AndroidMotionEventAction.Up,
      ScrcpyPointerId.Mouse,
      point,
      buttons !== 0 ? 1 : 0,
      change.button,
      buttons,
    );
  }

  /**
   * Release the phone's mouse buttons. Any still physically held are then
   * ignored until let go, so they don't re-press mid-gesture.
   */
  #releaseMouse(): void {
    if (this.#mouseButtons === 0 || !this.#live) {
      return;
    }
    const point = this.#lastMousePosition && this.#toVideoPoint(this.#lastMousePosition);
    if (point) {
      for (const change of diffButtons(this.#mouseButtons, 0)) {
        this.#sendMouseButton(change, point);
      }
    }
    this.#ignoredMouseButtons |= this.#mouseButtons;
    this.#mouseButtons = 0;
  }

  /** Chrome navigates back / forward on mouse button 3 / 4 release. */
  #onMouseUp = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  };

  #onWheel = (event: WheelEvent): void => {
    // Also blocks page scroll and ctrl + wheel / pinch browser zoom.
    event.preventDefault();
    const point = this.#toVideoPoint(event);
    if (!point?.inside) {
      return;
    }
    const { scrollX, scrollY } = wheelToScroll(event, this.#scrollNotchScale);
    if (scrollX === 0 && scrollY === 0) {
      return;
    }
    const { width, height } = this.#sink.videoSize;
    const buttons = this.#mouseButtons & POINTER_BUTTONS;
    this.#send((controller) =>
      controller.injectScroll({
        pointerX: point.x,
        pointerY: point.y,
        videoWidth: width,
        videoHeight: height,
        scrollX,
        scrollY,
        buttons,
      }),
    );
  };

  #releasePointers(): void {
    this.#releaseMouse();
    for (const [pointerId, position] of [...this.#touches]) {
      this.#endTouch(pointerId, position);
    }
  }

  // -- keyboard -------------------------------------------------------------

  #modifiers(event: KeyboardEvent): ModifierFlags {
    return effectiveModifiers(readModifierFlags(event), this.#settings.commandAsCtrl, this.#heldKeys);
  }

  #heldKeyCodes(): Set<number> {
    return new Set([...this.#heldKeys.values()].map((held) => held.keyCode));
  }

  /** Whether a printable key should be typed as text rather than sent as a shortcut. */
  #typesText(event: KeyboardEvent, modifiers: ModifierFlags): boolean {
    // AltGr (reported as Ctrl + Alt on Windows) composes characters.
    if (event.getModifierState("AltGraph")) {
      return true;
    }
    if (modifiers.ctrl || modifiers.meta) {
      return false;
    }
    // macOS Option types characters (@, €, [, ] on many layouts).
    return !modifiers.alt || this.#macLike;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    this.#keydownHandled = false;
    // App shortcuts win over everything, including the paste and ⌘ logic.
    if (this.#hooks.onShortcut?.(event)) {
      event.preventDefault();
      this.#keydownHandled = true;
      this.#swallowedKeyups.add(event.code);
      return;
    }
    this.#swallowedKeyups.delete(event.code);
    // IME composition and dead keys: the result arrives via compositionend /
    // beforeinput instead.
    if (event.isComposing || this.#composing || event.keyCode === IME_PROCESS_KEY_CODE || event.key === "Dead") {
      return;
    }
    if (LOCK_KEY_CODES.has(event.code)) {
      return;
    }
    // Normally let the browser run its paste shortcut so it fires a `paste`
    // event with this device's clipboard (forwarding it would paste the
    // phone's). With `preferPhonePaste` it is forwarded as ordinary keys.
    if (isPasteShortcut(event, this.#macLike) && !this.#hooks.preferPhonePaste?.()) {
      return;
    }

    const modifiers = this.#modifiers(event);
    if (isPrintableKey(event.key) && this.#typesText(event, modifiers)) {
      event.preventDefault();
      this.#keydownHandled = true;
      this.#sendText(event.key);
      return;
    }

    const keyCode = resolveAndroidKeyCode(event.code, this.#settings.commandAsCtrl);
    if (keyCode === undefined) {
      return;
    }
    event.preventDefault();
    this.#keydownHandled = true;
    if (!this.#live) {
      // Blocked: the phone gets nothing, so nothing is held.
      return;
    }

    // macOS never fires keyup for keys released while ⌘ is held, so send
    // a complete tap instead of leaving the key stuck down on the phone.
    if (this.#macLike && event.metaKey && !MODIFIER_KEY_CODES.has(event.code)) {
      const metaState = computeMetaState(modifiers, this.#heldKeyCodes());
      this.#injectKey(AndroidKeyEventAction.Down, keyCode, 0, metaState);
      this.#injectKey(AndroidKeyEventAction.Up, keyCode, 0, metaState);
      return;
    }

    const previous = this.#heldKeys.get(event.code);
    const repeat = event.repeat && previous ? previous.repeat + 1 : 0;
    this.#heldKeys.set(event.code, { keyCode, repeat });
    // Recomputed now that this key is held: tells left from right ⌘.
    const metaState = computeMetaState(this.#modifiers(event), this.#heldKeyCodes());
    this.#injectKey(AndroidKeyEventAction.Down, keyCode, repeat, metaState);
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    this.#keydownHandled = false;
    if (this.#swallowedKeyups.delete(event.code)) {
      event.preventDefault();
    }
    // Still released if it was held before a shortcut claimed it: a key
    // must never stay down on the phone.
    const held = this.#heldKeys.get(event.code);
    if (held) {
      event.preventDefault();
      if (this.#live) {
        this.#heldKeys.delete(event.code);
        const metaState = computeMetaState(this.#modifiers(event), this.#heldKeyCodes());
        this.#injectKey(AndroidKeyEventAction.Up, held.keyCode, 0, metaState);
      }
    }
    // Same macOS quirk: keys pressed before ⌘ and released while it was
    // down never got a keyup, so release them together with ⌘.
    if (this.#macLike && this.#live && (event.code === "MetaLeft" || event.code === "MetaRight")) {
      for (const [code, other] of [...this.#heldKeys]) {
        if (!MODIFIER_KEY_CODES.has(code)) {
          this.#heldKeys.delete(code);
          this.#injectKey(AndroidKeyEventAction.Up, other.keyCode, 0, 0);
        }
      }
    }
  };

  /**
   * Release every held key, newest first (e.g. on blur, so no modifier stays
   * stuck). Kept for later while input is blocked.
   */
  #releaseKeys(): void {
    this.#swallowedKeyups.clear();
    if (!this.#live) {
      return;
    }
    const held = [...this.#heldKeys.values()].reverse();
    this.#heldKeys.clear();
    for (const key of held) {
      this.#injectKey(AndroidKeyEventAction.Up, key.keyCode, 0, 0);
    }
  }

  /**
   * Soft keyboards (iPad, Android Chrome) often send keydown with key
   * "Unidentified" / keyCode 229 and describe the edit only here.
   */
  #onBeforeInput = (event: InputEvent): void => {
    if (this.#keydownHandled) {
      // Already handled at keydown.
      event.preventDefault();
      return;
    }
    if (event.isComposing || this.#composing) {
      return;
    }
    switch (event.inputType) {
      case "insertText":
      case "insertReplacementText": {
        event.preventDefault();
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        if (text) {
          this.#sendText(text);
        }
        break;
      }
      case "deleteContentBackward":
        event.preventDefault();
        this.pressKey(AndroidKeyCode.Backspace);
        break;
      case "deleteContentForward":
        event.preventDefault();
        this.pressKey(AndroidKeyCode.Delete);
        break;
      case "insertLineBreak":
      case "insertParagraph":
        event.preventDefault();
        this.pressKey(AndroidKeyCode.Enter);
        break;
    }
  };

  /** Anything that still landed in the textarea (outside a composition) is discarded. */
  #onInput = (): void => {
    if (!this.#composing) {
      this.#clearKeyboardTarget();
    }
  };

  #onCompositionStart = (): void => {
    this.#composing = true;
  };

  #onCompositionEnd = (event: CompositionEvent): void => {
    this.#composing = false;
    if (event.data) {
      this.#sendText(event.data);
    }
    this.#clearKeyboardTarget();
  };

  #onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      this.#pasteText(text);
    }
  };

  #clearKeyboardTarget(): void {
    if (this.#keyboard.value !== "") {
      this.#keyboard.value = "";
    }
  }

  // -- focus / visibility ---------------------------------------------------

  #onKeyboardBlur = (): void => {
    // Keyups now go elsewhere.
    this.#releaseKeys();
  };

  #onWindowBlur = (): void => {
    this.releaseAll();
  };

  #onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.releaseAll();
    }
  };
}

function preventDefault(event: Event): void {
  event.preventDefault();
}

function positionOf(position: ClientPosition): ClientPosition {
  return { clientX: position.clientX, clientY: position.clientY };
}
