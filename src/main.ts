import type { Adb } from "@yume-chan/adb";
import { AndroidKeyCode } from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";

import {
  createAudioPlayer,
  DexSession,
  isCodecSupported,
  type DisplayRequest,
  type PhoneState,
} from "./lib/dex-session";
import { InputController } from "./lib/input";
import { appChordLabel, isAppChord, isMacLike, metaKeyLabel } from "./lib/keymap";
import { fillForm, loadSettings, readForm, saveSettings } from "./lib/settings";
import {
  connectWebUsb,
  listWebUsbDevices,
  probeRelay,
  readRelayToken,
  RelayTransport,
  requestWebUsbDevice,
  webUsbSupport,
  type RelayInfo,
} from "./lib/transports";
import type { DeviceChoice, DexSettings, TransportKind } from "./lib/types";

// #region DOM

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

const ui = {
  connectView: $("connect-view"),
  sessionView: $("session-view"),
  tabList: $("methods"),
  tabs: { relay: $<HTMLButtonElement>("tab-relay"), webusb: $<HTMLButtonElement>("tab-webusb") },
  panels: { relay: $("panel-relay"), webusb: $("panel-webusb") },
  relayDevice: $<HTMLSelectElement>("relay-device"),
  relayRefresh: $<HTMLButtonElement>("relay-refresh"),
  relayHint: $("relay-hint"),
  webUsbDevice: $<HTMLSelectElement>("webusb-device"),
  webUsbPick: $<HTMLButtonElement>("webusb-pick"),
  webUsbHint: $("webusb-hint"),
  start: $<HTMLButtonElement>("start"),
  status: $("status"),
  settingsForm: $<HTMLFormElement>("settings-form"),
  stage: $("stage"),
  screen: $<HTMLCanvasElement>("screen"),
  keyboardSink: $<HTMLTextAreaElement>("keyboard-sink"),
  loadingText: $("loading-text"),
  cancelStart: $<HTMLButtonElement>("cancel-start"),
  lockScreen: $("lock-screen"),
  lockScreenTitle: $("lock-screen-title"),
  lockScreenText: $("lock-screen-text"),
  wakePhone: $<HTMLButtonElement>("wake-phone"),
  dock: $("dock"),
  dockHandle: $<HTMLButtonElement>("dock-handle"),
  guide: $("guide"),
  guideSettingsForm: $<HTMLFormElement>("guide-settings-form"),
  phoneScreenLabel: $("phone-screen-label"),
  stats: $<HTMLOutputElement>("stats"),
  toast: $("toast"),
};

// #endregion

// #region State

let settings = loadSettings();
let method: TransportKind = "relay";
let relayInfo: RelayInfo | undefined;
let relay: RelayTransport | undefined;
let relayDevices: DeviceChoice[] = [];
let webUsbDevices: DeviceChoice[] = [];
let starting: AbortController | undefined;

interface ActiveSession {
  adb: Adb;
  session: DexSession;
  input: InputController;
  /** Virtual display pixels per CSS pixel, chosen when the session started. */
  scale: number;
  /** Latest lock/screen state reported by the phone; undefined while unknown. */
  phoneState: PhoneState | undefined;
  /**
   * Whether DeX is hidden behind the lock screen. A latch: once hidden, only
   * seeing the phone awake and unlocked uncovers it, whatever the settings say.
   */
  locked: boolean;
  /** Whether the user muted phone audio (separately from muting while locked). */
  muted: boolean;
  phoneScreenOn: boolean;
  dispose: () => void;
}
let active: ActiveSession | undefined;

// #endregion

// #region Connect screen

function setStatus(message: string, tone: "info" | "error" = "info") {
  ui.status.textContent = message;
  ui.status.dataset.tone = tone;
}

function selectMethod(next: TransportKind) {
  method = next;
  for (const kind of ["relay", "webusb"] as const) {
    ui.tabs[kind].setAttribute("aria-selected", String(kind === next));
    ui.tabs[kind].tabIndex = kind === next ? 0 : -1;
    ui.panels[kind].hidden = kind !== next;
  }
  updateStartButton();
}

function currentChoice(): DeviceChoice | undefined {
  const [select, list] =
    method === "relay" ? [ui.relayDevice, relayDevices] : [ui.webUsbDevice, webUsbDevices];
  return list.find((device) => device.id === select.value);
}

function updateStartButton() {
  ui.start.disabled = starting !== undefined || !currentChoice() || !WebCodecsVideoDecoder.isSupported;
}

function renderDevices(select: HTMLSelectElement, devices: DeviceChoice[], emptyLabel: string) {
  const previous = select.value;
  select.replaceChildren(
    ...(devices.length
      ? devices.map((device) => new Option(device.label, device.id))
      : [new Option(emptyLabel, "")]),
  );
  select.disabled = devices.length === 0;
  if (devices.some((device) => device.id === previous)) {
    select.value = previous;
  }
  updateStartButton();
}

async function refreshRelayDevices() {
  if (!relay) {
    return;
  }
  ui.relayRefresh.dataset.busy = "true";
  try {
    relayDevices = await relay.listDevices();
    renderDevices(ui.relayDevice, relayDevices, "No phone found");
    const ready = relayDevices.some((device) => device.handle === "device");
    ui.relayHint.dataset.tone = "info";
    ui.relayHint.textContent = relayDevices.length
      ? ready
        ? "USB is the smoothest; Wi‑Fi works too."
        : "Unlock your phone and tap “Allow” on the USB debugging prompt."
      : "Plug in your phone with USB debugging on. It will show up here.";
  } catch (error) {
    relayDevices = [];
    renderDevices(ui.relayDevice, relayDevices, "Couldn’t load phones");
    ui.relayHint.dataset.tone = "warning";
    ui.relayHint.textContent = errorMessage(error);
  } finally {
    delete ui.relayRefresh.dataset.busy;
  }
}

async function watchRelayDevices() {
  if (!relay) {
    return;
  }
  try {
    const observer = await relay.client.trackDevices();
    observer.onListChange(() => void refreshRelayDevices());
  } catch {
    // Manual refresh still works.
  }
}

async function refreshWebUsbDevices() {
  webUsbDevices = await listWebUsbDevices();
  renderDevices(ui.webUsbDevice, webUsbDevices, "No phone added yet");
}

/** Marks codecs this browser can't decode, so they can't be picked by accident. */
async function markUnsupportedCodecs() {
  const select = ui.settingsForm.elements.namedItem("videoCodec");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  for (const option of select.options) {
    const codec = option.value as DexSettings["videoCodec"];
    if (codec !== "h264" && !(await isCodecSupported(codec))) {
      option.disabled = true;
      option.textContent += " (not supported here)";
      if (select.value === codec) {
        select.value = "h264";
        settings = readForm(ui.settingsForm, settings);
        saveSettings(settings);
      }
    }
  }
}

function initTabs() {
  for (const kind of ["relay", "webusb"] as const) {
    ui.tabs[kind].addEventListener("click", () => {
      if (ui.tabs[kind].getAttribute("aria-disabled") !== "true") {
        selectMethod(kind);
      }
    });
  }
  // Arrow keys move between tabs, as expected of a tablist.
  ui.tabList.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const next = method === "relay" ? "webusb" : "relay";
    if (ui.tabs[next].getAttribute("aria-disabled") !== "true") {
      selectMethod(next);
      ui.tabs[next].focus();
    }
    event.preventDefault();
  });
}

async function initConnectScreen() {
  fillForm(ui.settingsForm, settings);
  ui.settingsForm.addEventListener("change", () => {
    settings = readForm(ui.settingsForm, settings);
    saveSettings(settings);
  });
  if (!isMacLike()) {
    $("setting-command-as-ctrl").hidden = true;
    $("guide-command-as-ctrl").hidden = true;
  }
  fillShortcutLabels();
  void markUnsupportedCodecs();

  initTabs();
  ui.relayDevice.addEventListener("change", updateStartButton);
  ui.webUsbDevice.addEventListener("change", updateStartButton);
  ui.relayRefresh.addEventListener("click", () => void refreshRelayDevices());
  ui.start.addEventListener("click", () => void startDex());

  // WebUSB
  const usb = webUsbSupport();
  if (usb.supported) {
    ui.webUsbHint.textContent =
      "Talks to the phone straight from this tab. Quit other adb tools on this computer first.";
    ui.webUsbPick.addEventListener("click", async () => {
      try {
        const choice = await requestWebUsbDevice();
        await refreshWebUsbDevices();
        if (choice) {
          ui.webUsbDevice.value = choice.id;
          updateStartButton();
        }
      } catch (error) {
        // The user closed the picker without choosing.
        if (!(error instanceof DOMException && error.name === "NotFoundError")) {
          setStatus(errorMessage(error), "error");
        }
      }
    });
    navigator.usb.addEventListener("connect", () => void refreshWebUsbDevices());
    navigator.usb.addEventListener("disconnect", () => void refreshWebUsbDevices());
    await refreshWebUsbDevices();
  } else {
    ui.tabs.webusb.setAttribute("aria-disabled", "true");
    ui.webUsbPick.disabled = true;
    ui.webUsbHint.textContent = usb.reason;
    renderDevices(ui.webUsbDevice, [], "Not available in this browser");
  }

  // Relay
  relayInfo = await probeRelay();
  if (relayInfo) {
    const token = readRelayToken();
    relay = new RelayTransport(token);
    selectMethod("relay");
    if (relayInfo.tokenRequired && !token) {
      ui.relayHint.dataset.tone = "warning";
      ui.relayHint.textContent =
        "This relay needs an access token. Open the link with #token=… that it printed when it started.";
      renderDevices(ui.relayDevice, [], "Access token needed");
    } else {
      await refreshRelayDevices();
      void watchRelayDevices();
      if (!relayInfo.adbReachable) {
        ui.relayHint.dataset.tone = "warning";
        ui.relayHint.textContent =
          "The relay can't reach adb. Install Android platform-tools and restart the relay.";
      }
    }
  } else {
    ui.tabs.relay.setAttribute("aria-disabled", "true");
    ui.relayRefresh.disabled = true;
    renderDevices(ui.relayDevice, [], "Relay not running");
    ui.relayHint.textContent =
      "Run `dexterous` on the computer the phone is plugged into, then open the address it prints.";
    selectMethod(usb.supported ? "webusb" : "relay");
  }

  if (!WebCodecsVideoDecoder.isSupported) {
    setStatus("This browser can't decode video (WebCodecs). Use a current Chrome, Edge, Safari or Firefox.", "error");
  }
  updateStartButton();
}

// #endregion

// #region Session lifecycle

function setView(view: "connect" | "session") {
  document.body.dataset.view = view;
  ui.connectView.hidden = view !== "connect";
  ui.sessionView.hidden = view !== "session";
}

/** Largest virtual display we ask for; phone video encoders top out around 4K. */
const MAX_LONG_SIDE = 3840;
const MAX_SHORT_SIDE = 2160;

function align8(value: number): number {
  return Math.max(320, Math.floor(value / 8) * 8);
}

/** The scale to use for the stage's current size: at most `preferred`, and within 4K. */
function fitScale(preferred: number): number {
  const { width, height } = ui.stage.getBoundingClientRect();
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  return Math.min(preferred, MAX_LONG_SIDE / longSide, MAX_SHORT_SIDE / shortSide);
}

function measureStage(scale: number): { width: number; height: number } {
  const { width, height } = ui.stage.getBoundingClientRect();
  return { width: align8(width * scale), height: align8(height * scale) };
}

function initialDisplay(): { request: DisplayRequest; scale: number } {
  const scale = fitScale(settings.resolutionScale);
  // 160 dpi = Android's baseline, where 1 dp equals 1 CSS pixel at scale 1.
  const dpi = Math.round(160 * scale * settings.uiZoom);
  return { request: { ...measureStage(scale), dpi }, scale };
}

async function startDex() {
  const choice = currentChoice();
  if (!choice || starting) {
    return;
  }
  settings = readForm(ui.settingsForm, settings);
  saveSettings(settings);

  // Must be created inside the click: browsers only allow audio started by a gesture.
  const audioPlayer = settings.audio ? createAudioPlayer() : undefined;

  const abort = new AbortController();
  starting = abort;
  updateStartButton();
  setStatus("");
  replaceCanvas();
  setView("session");
  ui.sessionView.dataset.ready = "false";
  ui.loadingText.textContent = "Connecting to your phone…";

  let adb: Adb | undefined;
  const cancel = () => {
    abort.abort();
    void adb?.close().catch(() => {});
  };
  ui.cancelStart.addEventListener("click", cancel);
  const cancelled = new Promise<never>((_, reject) => {
    abort.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
  });
  // Swallow the rejection when nothing is racing against it anymore.
  cancelled.catch(() => {});

  try {
    // Race each slow step against Cancel, so Cancel works even while waiting
    // on the phone (e.g. the WebUSB "Allow" prompt). Late results are cleaned up.
    const connecting =
      choice.kind === "relay"
        ? relay!.connect(choice)
        : connectWebUsb(choice, () => {
            ui.loadingText.textContent = "Tap “Allow” on your phone to trust this browser.";
          });
    connecting.then(
      (late) => {
        if (abort.signal.aborted) {
          void late.close().catch(() => {});
        }
      },
      () => {},
    );
    adb = await Promise.race([connecting, cancelled]);

    const { request, scale } = initialDisplay();
    const sessionStart = DexSession.start({
      adb,
      canvas: ui.screen,
      display: request,
      settings,
      audioPlayer,
      onStatus: (message) => {
        ui.loadingText.textContent = message;
      },
      onClipboard: copyToComputer,
    });
    sessionStart.then(
      (late) => {
        if (abort.signal.aborted) {
          void late.close();
        }
      },
      () => {},
    );
    const session = await Promise.race([sessionStart, cancelled]);

    const input = new InputController({
      canvas: ui.screen,
      keyboardTarget: ui.keyboardSink,
      sink: session,
      settings: { commandAsCtrl: settings.commandAsCtrl },
      onShortcut: handleShortcut,
      // With clipboard sharing off, the two clipboards are separate and paste
      // uses the phone's own. With it on, paste the phone's copy if it hasn't
      // reached the computer yet (e.g. Safari blocked the write).
      preferPhonePaste: () => pendingClipboard !== undefined || !settings.clipboardSync,
    });

    active = {
      adb,
      session,
      input,
      scale,
      phoneState: undefined,
      locked: false,
      muted: false,
      phoneScreenOn: true,
      dispose: () => {},
    };
    // Secure mode starts hidden until the phone is seen unlocked.
    active.locked = !settings.allowWhileLocked;
    session.setInputBlocked(active.locked);
    active.dispose = attachSessionUi(active, request);
    input.focusKeyboard();
    warnAboutDevice(session);

    void session.ended.then(endSession, (error: unknown) => endSession(errorMessage(error)));
  } catch (error) {
    void audioPlayer?.stop().catch(() => {});
    await adb?.close().catch(() => {});
    setView("connect");
    if (abort.signal.aborted) {
      setStatus("Cancelled.");
    } else {
      console.error("Couldn't start DeX", error);
      setStatus(errorMessage(error), "error");
    }
  } finally {
    ui.cancelStart.removeEventListener("click", cancel);
    starting = undefined;
    updateStartButton();
  }
}

/**
 * Each session gets a new <canvas>: the previous renderer releases its WebGL
 * context on dispose, and a canvas can't hand out a fresh one afterwards.
 */
function replaceCanvas() {
  const canvas = document.createElement("canvas");
  canvas.className = ui.screen.className;
  canvas.id = ui.screen.id;
  canvas.setAttribute("aria-label", ui.screen.getAttribute("aria-label") ?? "DeX desktop");
  ui.screen.replaceWith(canvas);
  ui.screen = canvas;
}

function warnAboutDevice(session: DexSession) {
  const { manufacturer, oneUiVersion } = session.device;
  if (!/samsung/i.test(manufacturer)) {
    showToast("Not a Galaxy phone: you'll get Android's own desktop, if it has one.", 6000);
  } else if (oneUiVersion !== undefined && oneUiVersion < 80000) {
    showToast("DeX on a virtual display needs One UI 8 or newer. You may only see a basic launcher.", 8000);
  }
}

async function endSession(reason: string | undefined) {
  const current = active;
  if (!current) {
    return;
  }
  active = undefined;
  current.input.dispose();
  current.dispose();
  await current.adb.close().catch(() => {});
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
  keyboardApi()?.unlock();
  resetSessionUi();
  setView("connect");
  setStatus(
    reason ??
      (settings.keepAppsOnDisconnect ? "Disconnected. Your apps moved back to the phone." : "Disconnected."),
    reason ? "error" : "info",
  );
  if (method === "relay") {
    void refreshRelayDevices();
  }
}

function resetSessionUi() {
  ui.stats.hidden = true;
  ui.toast.hidden = true;
  ui.lockScreen.hidden = true;
  setGuideOpen(false);
  setDockOpen(false);
  for (const button of ui.sessionView.querySelectorAll("[aria-pressed]")) {
    button.setAttribute("aria-pressed", "false");
  }
  ui.phoneScreenLabel.textContent = "Turn phone screen off (DeX keeps running)";
  pendingClipboard = undefined;
  setAllowToggleEnabled(true);
}

// #endregion

// #region Session UI

/** Wires the dock, guide, lock screen, resizing and stats. Returns a cleanup function. */
function attachSessionUi(current: ActiveSession, request: DisplayRequest): () => void {
  const { session } = current;
  const disposers: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Document | Window,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ) => {
    target.addEventListener(type, handler as EventListener);
    disposers.push(() => target.removeEventListener(type, handler as EventListener));
  };

  // Hide the loading screen once the first frame is on screen.
  let frameWatch = requestAnimationFrame(function waitForFrame() {
    if (session.decoder.framesRendered > 0) {
      ui.sessionView.dataset.ready = "true";
      flashDock();
      showToast(`Press ${appChordLabel()}${isMacLike() ? " " : "+"}/ for shortcuts and commands.`, 4500);
      return;
    }
    frameWatch = requestAnimationFrame(waitForFrame);
  });
  const slowHint = window.setTimeout(() => {
    ui.loadingText.textContent = "Waiting for the picture… unlock your phone if it's locked.";
  }, 8000);
  disposers.push(() => {
    cancelAnimationFrame(frameWatch);
    clearTimeout(slowHint);
  });

  // Follow the window size (flex display), staying within what the encoder handles.
  let resizeTimer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const { width, height } = measureStage(fitScale(current.scale));
      session.resize(width, height);
    }, 250);
  });
  observer.observe(ui.stage);
  disposers.push(() => {
    observer.disconnect();
    clearTimeout(resizeTimer);
  });

  // Commands from the dock, the guide and the lock screen.
  listen(ui.sessionView, "click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-command]");
    if (!button) {
      return;
    }
    const pointerType = (event as PointerEvent).pointerType;
    runCommand(button.dataset.command as Command, pointerType === "touch" || pointerType === "pen");
  });

  listen(ui.dockHandle, "click", () => {
    setDockOpen(ui.sessionView.dataset.dock !== "open");
  });

  // Live settings from the guide.
  fillForm(ui.guideSettingsForm, settings);
  listen(ui.guideSettingsForm, "change", () => {
    settings = readForm(ui.guideSettingsForm, settings);
    saveSettings(settings);
    fillForm(ui.settingsForm, settings);
    current.input.updateSettings({ commandAsCtrl: settings.commandAsCtrl });
    fillShortcutLabels();
    applyLockState(current);
    flushPendingClipboard();
  });

  // Shortcuts and Escape also work while focus is on the dock, the guide or
  // the lock screen (the hidden text field handles them the rest of the time).
  listen(ui.sessionView, "keydown", (event) => {
    if (event.target !== ui.keyboardSink && handleShortcut(event)) {
      event.preventDefault();
    }
  });

  listen(document, "fullscreenchange", () => {
    const fullscreen = document.fullscreenElement !== null;
    ui.dock.querySelector('[data-command="fullscreen"]')?.setAttribute("aria-pressed", String(fullscreen));
    if (!fullscreen) {
      keyboardApi()?.unlock();
    }
  });

  // Safari only allows clipboard writes during a user gesture.
  listen(ui.sessionView, "pointerdown", flushPendingClipboard);
  listen(ui.sessionView, "keydown", flushPendingClipboard);
  listen(window, "focus", flushPendingClipboard);

  // DeX keeps running while the phone is locked; hide it unless the user allowed that.
  applyLockState(current);
  disposers.push(
    session.watchPhoneState((state) => {
      current.phoneState = state;
      applyLockState(current);
    }),
  );
  listen(ui.wakePhone, "click", () => {
    void session.wakePhone().catch(() => {});
  });

  // Live stats.
  let lastFrames = session.decoder.framesRendered;
  let lastTime = performance.now();
  const statsTimer = window.setInterval(() => {
    const now = performance.now();
    const frames = session.decoder.framesRendered;
    const fps = ((frames - lastFrames) * 1000) / (now - lastTime);
    lastFrames = frames;
    lastTime = now;
    const { width, height } = session.videoSize;
    const lines = [
      `${width} × ${height} @ ${request.dpi} dpi`,
      `${fps.toFixed(0)} fps · ${session.decoder.type} decoding`,
      `${session.decoder.framesSkippedRendering} frames skipped`,
    ];
    if (session.hasAudio) {
      lines.push(`audio ${current.muted || current.locked ? "muted" : "on"}`);
    }
    ui.stats.textContent = lines.join("\n");
  }, 1000);
  disposers.push(() => clearInterval(statsTimer));

  return () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
  };
}

/**
 * Shows or hides the lock screen. While shown, DeX gets no input, phone audio
 * is muted and nothing is copied to this computer.
 *
 * Hiding is a latch: in secure mode DeX hides whenever the phone is locked,
 * asleep or its state is unknown, and only uncovers once the phone is seen
 * awake and unlocked. Changing the setting can't uncover a locked phone.
 */
function applyLockState(current: ActiveSession) {
  const state = current.phoneState;
  const unlocked = state !== undefined && state.awake && !state.locked;
  const wasHidden = current.locked;
  if (unlocked) {
    current.locked = false;
  } else if (!settings.allowWhileLocked) {
    current.locked = true;
  }
  const hide = current.locked;

  current.session.setInputBlocked(hide);
  current.session.setAudioMuted(current.muted || hide);
  setAllowToggleEnabled(!hide);
  if (wasHidden && !hide) {
    // Nothing pressed before the lock may stay held afterwards.
    current.input.releaseAll();
    flushPendingClipboard();
  }

  if (ui.lockScreen.hidden !== !hide) {
    ui.lockScreen.hidden = !hide;
  }
  if (hide) {
    const [title, text] =
      state === undefined
        ? ["Checking your phone…", "DeX appears once your phone is unlocked."]
        : !state.awake
          ? ["Your phone is asleep", "Wake your phone and unlock it to keep using DeX."]
          : ["Your phone is locked", "Unlock your phone to keep using DeX."];
    // Only touch the live region when the message actually changes.
    if (ui.lockScreenTitle.textContent !== title) {
      ui.lockScreenTitle.textContent = title;
      ui.lockScreenText.textContent = text;
    }
    ui.wakePhone.hidden = state === undefined || state.awake;
  }
}

/** The "usable while locked" switch can't be flipped while DeX is hidden. */
function setAllowToggleEnabled(enabled: boolean) {
  for (const form of [ui.guideSettingsForm, ui.settingsForm]) {
    const toggle = form.elements.namedItem("allowWhileLocked");
    if (toggle instanceof HTMLInputElement) {
      toggle.disabled = !enabled;
      toggle.title = enabled ? "" : "Unlock your phone first";
    }
  }
}

// #endregion

// #region Commands & shortcuts

type Command =
  | "back"
  | "home"
  | "recents"
  | "keyboard"
  | "mute"
  | "lock"
  | "wake"
  | "phone-screen"
  | "fullscreen"
  | "stats"
  | "guide"
  | "disconnect";

/** Ctrl+Alt (⌃⌥ on Mac) + key → command. Everything else is typed into DeX. */
const SHORTCUTS: Record<string, Command> = {
  KeyB: "back",
  KeyH: "home",
  KeyR: "recents",
  KeyM: "mute",
  KeyL: "lock",
  KeyW: "wake",
  KeyP: "phone-screen",
  KeyF: "fullscreen",
  KeyS: "stats",
  Slash: "guide",
  KeyQ: "disconnect",
};

/** Called by the input layer before a key is sent to DeX; true means "handled here". */
function handleShortcut(event: KeyboardEvent): boolean {
  if (event.code === "Escape" && !ui.guide.hidden && !event.ctrlKey && !event.altKey && !event.metaKey) {
    setGuideOpen(false);
    return true;
  }
  if (!isAppChord(event)) {
    return false;
  }
  const command = SHORTCUTS[event.code];
  if (!command) {
    return false;
  }
  // Holding the keys shouldn't toggle full screen (etc.) on and off.
  if (!event.repeat) {
    runCommand(command, false);
  }
  return true;
}

function runCommand(command: Command, fromTouch: boolean) {
  const current = active;
  if (!current) {
    return;
  }
  const { session, input } = current;
  switch (command) {
    case "back":
      input.pressKey(AndroidKeyCode.AndroidBack);
      break;
    case "home":
      input.pressKey(AndroidKeyCode.AndroidHome);
      break;
    case "recents":
      input.pressKey(AndroidKeyCode.AndroidAppSwitch);
      break;
    case "keyboard":
      // Explicitly asked for, so open the soft keyboard on touch devices too.
      input.focusKeyboard();
      return;
    case "mute":
      current.muted = !current.muted;
      session.setAudioMuted(current.muted || current.locked);
      setPressed("mute", current.muted);
      showToast(current.muted ? "Phone audio muted" : "Phone audio on");
      break;
    case "lock":
      void session.lockPhone().catch(() => {});
      if (settings.allowWhileLocked) {
        showToast("Phone locked. DeX stays usable.");
      } else {
        // Cover DeX now rather than on the next state report.
        current.phoneState = { awake: false, locked: true };
        applyLockState(current);
      }
      break;
    case "wake":
      void session.wakePhone().catch(() => {});
      break;
    case "phone-screen":
      current.phoneScreenOn = !current.phoneScreenOn;
      session.setPhoneScreenPower(current.phoneScreenOn);
      setPressed("phone-screen", !current.phoneScreenOn);
      ui.phoneScreenLabel.textContent = current.phoneScreenOn
        ? "Turn phone screen off (DeX keeps running)"
        : "Turn phone screen back on";
      showToast(current.phoneScreenOn ? "Phone screen on" : "Phone screen off. DeX keeps running.");
      break;
    case "fullscreen":
      void toggleFullscreen();
      break;
    case "stats":
      ui.stats.hidden = !ui.stats.hidden;
      setPressed("stats", !ui.stats.hidden);
      break;
    case "guide":
      setGuideOpen(ui.guide.hidden !== false);
      break;
    case "disconnect":
      void session.close();
      return;
  }
  // Keep typing going to DeX, but don't pop up soft keyboards after a tap.
  if (!fromTouch) {
    input.focusKeyboard();
  }
}

function setPressed(command: Command, pressed: boolean) {
  for (const button of ui.sessionView.querySelectorAll(`.dock-button[data-command="${command}"]`)) {
    button.setAttribute("aria-pressed", String(pressed));
  }
}

function setGuideOpen(open: boolean) {
  ui.guide.hidden = !open;
  ui.dock.querySelector('[data-command="guide"]')?.setAttribute("aria-expanded", String(open));
  if (!open && active) {
    active.input.focusKeyboard();
  }
}

/** Fills in shortcut labels for this platform (⌃⌥ vs Ctrl+Alt, ⌘ vs ⊞). */
function fillShortcutLabels() {
  const chord = appChordLabel();
  const join = isMacLike() ? " " : "+";
  for (const element of document.querySelectorAll<HTMLElement>(".chord")) {
    const key = element.dataset.key ?? "";
    element.textContent = key ? `${chord}${join}${key}` : chord;
  }
  const meta = metaKeyLabel(settings.commandAsCtrl);
  for (const element of document.querySelectorAll(".meta-key")) {
    element.textContent = meta;
  }
  const paste = isMacLike() ? "⌘ V" : "Ctrl V";
  for (const element of document.querySelectorAll(".paste-key")) {
    element.textContent = paste;
  }
}

// #endregion

// #region Helpers

let dockTimer = 0;
function setDockOpen(open: boolean) {
  clearTimeout(dockTimer);
  if (open) {
    ui.sessionView.dataset.dock = "open";
  } else {
    delete ui.sessionView.dataset.dock;
  }
  ui.dockHandle.setAttribute("aria-expanded", String(open));
}

/** Briefly show the dock so people know where it lives. */
function flashDock() {
  setDockOpen(true);
  dockTimer = window.setTimeout(() => setDockOpen(false), 2500);
}

let toastTimer = 0;
function showToast(message: string, duration = 3000) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, duration);
}

interface KeyboardLockApi {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | undefined {
  return (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
    return;
  }
  try {
    await ui.sessionView.requestFullscreen({ navigationUI: "hide" });
  } catch {
    showToast("Full screen isn't available here.");
    return;
  }
  // In full screen, Chromium lets the page receive Esc, ⌘/Win and browser
  // shortcuts, so they reach DeX instead of the browser.
  const keyboard = keyboardApi();
  if (keyboard) {
    await keyboard.lock().catch(() => {});
    showToast("Hold Esc to leave full screen.");
  }
}

let pendingClipboard: string | undefined;

function copyToComputer(text: string) {
  if (!settings.clipboardSync) {
    return;
  }
  pendingClipboard = text;
  flushPendingClipboard();
}

function flushPendingClipboard() {
  const text = pendingClipboard;
  // Nothing leaves the phone while DeX is hidden behind the lock screen.
  if (text === undefined || !navigator.clipboard || !settings.clipboardSync || active?.locked) {
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      if (pendingClipboard === text) {
        pendingClipboard = undefined;
      }
    },
    () => {
      // Not focused or no permission yet; retried on the next click or key press.
    },
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null || error === undefined) {
    return "Something went wrong. Check the browser console for details.";
  }
  return String(error);
}

// #endregion

window.addEventListener("pagehide", () => {
  void active?.session.close();
});

// `?debug` exposes the live session as `window.dex` for troubleshooting in DevTools.
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "dex", { get: () => active });
}

void initConnectScreen();
