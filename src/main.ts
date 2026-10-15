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
import { Checklist, buildSteps, type RelayFacts } from "./lib/checklist";
import { DeviceList, findPhoneBySerial, type DetailsState } from "./lib/device-list";
import { InputController } from "./lib/input";
import { appChordLabel, isAppChord, isMacLike, metaKeyLabel } from "./lib/keymap";
import { readPhoneDetails, MIN_ONE_UI } from "./lib/phone-info";
import {
  CUSTOM_SUMMARY,
  PRESETS,
  describeQuality,
  matchPreset,
  presetValues,
  type PresetId,
  type QualityChoice,
} from "./lib/presets";
import { initPreferences, motionEnabled } from "./lib/preferences";
import { fillForm, hasSavedSettings, loadSettings, readForm, saveSettings } from "./lib/settings";
import { readStored, writeStored } from "./lib/storage";
import {
  connectWebUsb,
  listWebUsbDevices,
  probeRelay,
  readRelayToken,
  RelayTransport,
  requestWebUsbDevice,
  UsbBusyError,
  webUsbSupport,
  type RelayInfo,
} from "./lib/transports";
import type { DeviceChoice, DexSettings, TransportKind } from "./lib/types";
import { copyCommand, UpdateBanner } from "./lib/update-banner";
import { WirelessForm } from "./lib/wireless-form";

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
  relayDevices: $("relay-devices"),
  relayEmpty: $("relay-empty"),
  relayRefresh: $<HTMLButtonElement>("relay-refresh"),
  relayHint: $("relay-hint"),
  relayTabDetail: $("tab-relay-detail"),
  relayConnect: $("relay-connect"),
  relaySetup: $("relay-setup"),
  relaySetupCommands: $("relay-setup-commands"),
  relaySetupCopy: $<HTMLButtonElement>("relay-setup-copy"),
  relaySetupWebUsb: $<HTMLButtonElement>("relay-setup-webusb"),
  relaySetupWebUsbName: $("relay-setup-webusb-name"),
  webUsbDevices: $("webusb-devices"),
  webUsbEmpty: $("webusb-empty"),
  webUsbPick: $<HTMLButtonElement>("webusb-pick"),
  webUsbHint: $("webusb-hint"),
  suggestion: $("suggestion"),
  suggestionText: $("suggestion-text"),
  suggestionAccept: $<HTMLButtonElement>("suggestion-accept"),
  suggestionDismiss: $<HTMLButtonElement>("suggestion-dismiss"),
  start: $<HTMLButtonElement>("start"),
  startHint: $("start-hint"),
  status: $("status"),
  busySwitch: $<HTMLButtonElement>("busy-switch"),
  settingsForm: $<HTMLFormElement>("settings-form"),
  presets: $("presets"),
  presetSummary: $("preset-summary"),
  customSettings: $<HTMLDetailsElement>("custom-settings"),
  footerVersion: $("footer-version"),
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

const LAST_PHONE_KEY = "dexterous:last-phone";
/** Phone details (name, One UI, battery) are read once, then again after this long. */
const DETAILS_MAX_AGE_MS = 60_000;
/** A failed read (say, right after tapping Allow) is tried again after this long. */
const DETAILS_RETRY_MS = 8_000;

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
/** The last session's background clean-up (see endSession). Never rejects. */
let closingSession: Promise<void> = Promise.resolve();

// #endregion

// #region Connect screen

const phoneDetails = new Map<string, DetailsState>();
const detailsReadAt = new Map<string, number>();
const unsupportedCodecs = new Set<DexSettings["videoCodec"]>();
/** Phones whose "try Balanced" suggestion was waved away (or already answered). */
const suggestionDismissed = new Set<string>();
const QUALITY_FIELDS = ["resolutionScale", "videoCodec", "videoBitRate", "maxFps"];

let quality: QualityChoice = "custom";
let relayToken: string | undefined;
/** Whether the last phone list loaded; undefined until the first try. */
let relayListed: boolean | undefined;
let relayEmptyText = "";
/** A just-connected Wi‑Fi phone to select once adb lists it. */
let pendingPick: string | undefined;
/** The phone whose USB start was refused as busy, so the relay tab can pick it. */
let busySerial: string | undefined;
let detailsRunning = false;
let checklist: Checklist;
let updateBanner: UpdateBanner | undefined;

const relayList = new DeviceList({
  root: ui.relayDevices,
  onChange: onSelectionChange,
  onActivate: startFromKeyboard,
});
const webUsbList = new DeviceList({
  root: ui.webUsbDevices,
  onChange: onSelectionChange,
  onActivate: startFromKeyboard,
});

function setStatus(message: string, tone: "info" | "error" = "info") {
  ui.status.textContent = message;
  ui.status.dataset.tone = tone;
}

/** Whether the page can use the relay: it's running, and the page has its token if it needs one. */
function relayUsable(): boolean {
  return relay !== undefined && !(relayInfo?.tokenRequired === true && !relayToken);
}

function setHint(element: HTMLElement, message: string, tone: "info" | "warning" = "info") {
  element.textContent = message;
  element.dataset.tone = tone;
}

function supportsCodec(codec: DexSettings["videoCodec"]): boolean {
  return !unsupportedCodecs.has(codec);
}

function activeList(): DeviceList {
  return method === "relay" ? relayList : webUsbList;
}

function currentChoice(): DeviceChoice | undefined {
  return activeList().selected;
}

function selectMethod(next: TransportKind) {
  method = next;
  ui.busySwitch.hidden = true;
  for (const kind of ["relay", "webusb"] as const) {
    ui.tabs[kind].setAttribute("aria-selected", String(kind === next));
    ui.tabs[kind].tabIndex = kind === next ? 0 : -1;
    ui.panels[kind].hidden = kind !== next;
  }
  refreshDerived();
}

function updateStartButton() {
  // The relay refuses new sessions while it updates, and restarts afterwards.
  const updating = updateBanner?.updating === true;
  ui.start.disabled =
    starting !== undefined || updating || !currentChoice()?.ready || !WebCodecsVideoDecoder.isSupported;
  const hint = updating ? "DeXterous is updating. You can start DeX when it's done." : "";
  if (ui.startHint.textContent !== hint) {
    ui.startHint.textContent = hint;
  }
}

function startFromKeyboard() {
  if (!ui.start.disabled) {
    void startDex();
  }
}

/** Everything that depends on which phone is selected or what the phone list says. */
function refreshDerived() {
  updateStartButton();
  updateSuggestion();
  renderChecklist();
}

function onSelectionChange() {
  refreshDerived();
}

function renderRelayPhones() {
  relayList.render(relayDevices, phoneDetails, (device) => device.serial === readStored(LAST_PHONE_KEY));
  ui.relayEmpty.textContent = relayEmptyText;
  ui.relayEmpty.hidden = relayDevices.length > 0;
}

function renderWebUsbPhones(emptyText: string) {
  webUsbList.render(webUsbDevices, phoneDetails);
  ui.webUsbEmpty.textContent = emptyText;
  ui.webUsbEmpty.hidden = webUsbDevices.length > 0;
}

async function refreshRelayDevices() {
  if (!relay) {
    return;
  }
  ui.relayRefresh.dataset.busy = "true";
  try {
    relayDevices = await relay.listDevices();
    relayListed = true;
    relayEmptyText = "No phone found yet. Plug one in and unlock it, and it will show up here.";
    renderRelayPhones();
    setHint(ui.relayHint, relayDevices.some((device) => device.ready) ? "USB is the smoothest; Wi‑Fi works too." : "");
    if (pendingPick) {
      // adb adds its default port when the address had none.
      const added = relayDevices.find(
        (device) => device.serial === pendingPick || device.serial.startsWith(`${pendingPick}:`),
      );
      if (added) {
        pendingPick = undefined;
        relayList.select(added.id);
      }
    }
    void loadPhoneDetails();
  } catch (error) {
    relayDevices = [];
    relayListed = false;
    relayEmptyText = "Couldn’t load phones.";
    renderRelayPhones();
    setHint(ui.relayHint, errorMessage(error), "warning");
  } finally {
    delete ui.relayRefresh.dataset.busy;
    refreshDerived();
  }
}

/**
 * Reads each ready phone's name, One UI version and battery through the relay,
 * one phone at a time. Failures are quietly ignored: the card just shows less.
 */
async function loadPhoneDetails() {
  if (!relay || detailsRunning || active || starting) {
    return;
  }
  detailsRunning = true;
  try {
    for (const device of [...relayDevices]) {
      if (!device.ready || device.transportId === undefined) {
        continue;
      }
      if (!needsDetails(device)) {
        continue;
      }
      detailsReadAt.set(device.serial, Date.now());
      if (!phoneDetails.has(device.serial)) {
        phoneDetails.set(device.serial, "loading");
        renderRelayPhones();
        refreshDerived();
      }
      try {
        phoneDetails.set(device.serial, await readPhoneDetails(relay.client, device.transportId));
      } catch {
        // Keep older details if there are any; otherwise show the phone without them.
        if (typeof phoneDetails.get(device.serial) !== "object") {
          phoneDetails.set(device.serial, "failed");
        }
        detailsReadAt.set(device.serial, Date.now() - DETAILS_MAX_AGE_MS + DETAILS_RETRY_MS);
        window.setTimeout(() => void loadPhoneDetails(), DETAILS_RETRY_MS + 100);
      }
      renderRelayPhones();
      refreshDerived();
      if (active || starting) {
        break;
      }
    }
  } finally {
    detailsRunning = false;
  }
  // Phones that showed up while we were reading.
  if (relayDevices.some(needsDetails)) {
    void loadPhoneDetails();
  }
}

function needsDetails(device: DeviceChoice): boolean {
  if (!device.ready || device.transportId === undefined) {
    return false;
  }
  const readAt = detailsReadAt.get(device.serial);
  return readAt === undefined || Date.now() - readAt >= DETAILS_MAX_AGE_MS;
}

function watchRelayDevices() {
  if (!relay) {
    return;
  }
  relay.client.trackDevices().then(
    (observer) => {
      observer.onListChange(() => void refreshRelayDevices());
    },
    () => {
      // Manual refresh still works.
    },
  );
}

/** After a busy USB start: moves to the relay tab with the same phone selected, if the relay lists it. */
async function switchToRelay() {
  const serial = busySerial;
  selectMethod("relay");
  setStatus("");
  await refreshRelayDevices();
  const phone = serial ? findPhoneBySerial(relayDevices, serial) : undefined;
  if (phone) {
    relayList.select(phone.id, true);
  } else {
    ui.tabs.relay.focus();
  }
}

async function refreshWebUsbDevices() {
  webUsbDevices = await listWebUsbDevices();
  renderWebUsbPhones("No phone added yet. Use the Add phone button.");
  refreshDerived();
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
      unsupportedCodecs.add(codec);
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

// ---- Picture quality presets

function initQuality() {
  const chips: { id: QualityChoice; label: string }[] = [
    ...PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
    { id: "custom", label: "Custom" },
  ];
  ui.presets.replaceChildren(
    ...chips.map(({ id, label }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "preset";
      chip.dataset.preset = id;
      chip.setAttribute("role", "radio");
      chip.textContent = label;
      return chip;
    }),
  );
  ui.presets.addEventListener("click", (event) => {
    const chip = (event.target as Element).closest<HTMLElement>("[data-preset]");
    if (chip) {
      choosePreset(chip.dataset.preset as QualityChoice);
    }
  });
  // A radio group: arrow keys move and select.
  ui.presets.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) {
      return;
    }
    const all = [...ui.presets.querySelectorAll<HTMLElement>("[data-preset]")];
    const index = all.findIndex((chip) => chip.dataset.preset === quality);
    const next = all[(index + step + all.length) % all.length]!;
    // Arrowing away from Custom would replace the user's own mix, so only move focus then.
    if (quality !== "custom") {
      choosePreset(next.dataset.preset as QualityChoice);
    }
    next.focus();
    event.preventDefault();
  });

  // Any change to a raw control means "Custom".
  ui.settingsForm.addEventListener("change", (event) => {
    settings = readForm(ui.settingsForm, settings);
    saveSettings(settings);
    if (QUALITY_FIELDS.includes((event.target as HTMLInputElement).name)) {
      quality = "custom";
      renderQuality();
      updateSuggestion();
    }
  });

  quality = hasSavedSettings() ? matchPreset(settings, supportsCodec) : "best";
  if (quality === "best") {
    applyPreset("best");
  }
  renderQuality();
}

function applyPreset(id: PresetId) {
  settings = { ...readForm(ui.settingsForm, settings), ...presetValues(id, supportsCodec) };
  saveSettings(settings);
  fillForm(ui.settingsForm, settings);
}

function choosePreset(choice: QualityChoice) {
  if (choice === "custom") {
    ui.customSettings.open = true;
  } else {
    applyPreset(choice);
  }
  quality = choice;
  // The person picked for themselves, so don't suggest anything else for this phone.
  const phone = currentChoice();
  if (phone?.wireless) {
    suggestionDismissed.add(phone.id);
  }
  renderQuality();
  updateSuggestion();
}

function renderQuality() {
  const chips = [...ui.presets.querySelectorAll<HTMLElement>("[data-preset]")];
  chips.forEach((chip, index) => {
    const selected = chip.dataset.preset === quality;
    chip.setAttribute("aria-checked", String(selected));
    chip.tabIndex = selected ? 0 : -1;
    if (selected) {
      // Where the highlight slides to (styled in src/styles.css).
      ui.presets.dataset.index = String(index);
    }
  });
  const preset = PRESETS.find((candidate) => candidate.id === quality);
  const values = preset ? presetValues(preset.id, supportsCodec) : settings;
  const detail = document.createElement("span");
  detail.className = "preset-values";
  detail.textContent = describeQuality(values);
  ui.presetSummary.replaceChildren(`${preset?.summary ?? CUSTOM_SUMMARY} `, detail);
}

/** On Wi‑Fi, suggest Balanced rather than changing anything silently. */
function updateSuggestion() {
  const phone = currentChoice();
  const heavy = quality === "best" || (quality === "custom" && settings.videoBitRate > 8);
  const show = method === "relay" && phone?.wireless === true && phone.ready && heavy && !suggestionDismissed.has(phone.id);
  ui.suggestion.hidden = !show;
}

// ---- Setup checklist

function renderChecklist() {
  if (method === "webusb") {
    checklist.render(buildSteps({ method: "webusb", supported: webUsbSupport().supported, phones: webUsbDevices.length }));
    return;
  }
  const phone = relayList.selected;
  const details = phone ? phoneDetails.get(phone.serial) : undefined;
  let oneUi: RelayFacts["oneUi"];
  if (typeof details === "object") {
    oneUi =
      details.oneUi !== undefined
        ? details.oneUi >= MIN_ONE_UI
          ? "ok"
          : "old"
        : /samsung/i.test(details.manufacturer)
          ? "old"
          : "not-galaxy";
  } else {
    oneUi = details === "failed" ? "unknown" : "checking";
  }
  checklist.render(
    buildSteps({
      method: "relay",
      relayRunning: relayInfo !== undefined,
      tokenMissing: relayInfo?.tokenRequired === true && !relayToken,
      adbReachable: relayListed ?? relayInfo?.adbReachable ?? false,
      phones: relayDevices.length,
      allowed: phone?.ready ? 1 : 0,
      oneUi,
    }),
  );
}

// ---- Setup

/**
 * Without a relay (the hosted copy of the app, or DeXterous isn't running), the Through
 * DeXterous tab stays selectable and explains how to get DeXterous instead of listing phones.
 */
function showRelaySetup(webUsbSupported: boolean) {
  ui.relayConnect.hidden = true;
  ui.relaySetup.hidden = false;
  ui.relayTabDetail.textContent = "Needs DeXterous on your computer";
  const commands = [...ui.relaySetupCommands.querySelectorAll("code")].map((line) => line.textContent).join("\n");
  ui.relaySetupCopy.addEventListener("click", () => void copyCommand(ui.relaySetupCopy, commands, ui.relaySetupCommands));
  // In Chrome and Edge, the browser-only tab is one click away; elsewhere it's only named.
  ui.relaySetupWebUsb.hidden = !webUsbSupported;
  ui.relaySetupWebUsbName.hidden = webUsbSupported;
  ui.relaySetupWebUsb.addEventListener("click", () => {
    selectMethod("webusb");
    ui.tabs.webusb.focus();
  });
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

/** Fetches `/api/info` again and passes it to the update banner (used after a session). */
async function refreshRelayInfo() {
  const info = await probeRelay();
  if (info) {
    relayInfo = info;
    updateBanner?.apply(info);
  }
}

async function initConnectScreen() {
  fillForm(ui.settingsForm, settings);
  if (!isMacLike()) {
    $("setting-command-as-ctrl").hidden = true;
    $("guide-command-as-ctrl").hidden = true;
  }
  fillShortcutLabels();
  checklist = new Checklist({
    root: $<HTMLDetailsElement>("checklist"),
    count: $("checklist-count"),
    list: $("checklist-steps"),
  });
  await markUnsupportedCodecs();
  initQuality();

  initTabs();
  ui.relayRefresh.addEventListener("click", () => void refreshRelayDevices());
  ui.start.addEventListener("click", () => void startDex());
  ui.suggestionAccept.addEventListener("click", () => {
    choosePreset("balanced");
    ui.suggestion.hidden = true;
  });
  ui.suggestionDismiss.addEventListener("click", () => {
    const phone = currentChoice();
    if (phone) {
      suggestionDismissed.add(phone.id);
    }
    updateSuggestion();
  });

  // WebUSB
  const usb = webUsbSupport();
  if (usb.supported) {
    ui.webUsbPick.addEventListener("click", async () => {
      try {
        const choice = await requestWebUsbDevice();
        await refreshWebUsbDevices();
        if (choice) {
          webUsbList.select(choice.id);
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
    setHint(ui.webUsbHint, usb.reason);
    renderWebUsbPhones("Not available in this browser.");
  }

  // Relay
  relayInfo = await probeRelay();
  ui.busySwitch.addEventListener("click", () => void switchToRelay());
  const wireless = new WirelessForm(
    {
      form: $<HTMLFormElement>("wifi-form"),
      address: $<HTMLInputElement>("wifi-address"),
      pairSection: $<HTMLDetailsElement>("wifi-pair"),
      pairAddress: $<HTMLInputElement>("wifi-pair-address"),
      pairCode: $<HTMLInputElement>("wifi-pair-code"),
      submit: $<HTMLButtonElement>("wifi-submit"),
      status: $("wifi-status"),
    },
    {
      pair: (address, code) => relay!.pair(address, code),
      connect: (address) => relay!.connectWireless(address),
      onConnected: (address) => {
        pendingPick = address;
        window.setTimeout(() => {
          if (pendingPick === address) {
            pendingPick = undefined;
          }
        }, 20_000);
        void refreshRelayDevices();
      },
    },
  );
  if (relayInfo) {
    relayToken = readRelayToken();
    relay = new RelayTransport(relayToken);
    ui.footerVersion.textContent = `DeXterous ${relayInfo.version}`;
    updateBanner = new UpdateBanner(
      {
        root: $("update-banner"),
        title: $("update-title"),
        detail: $("update-detail"),
        notes: $<HTMLAnchorElement>("update-notes"),
        install: $<HTMLButtonElement>("update-install"),
        command: $("update-command"),
        commandText: $("update-command-text"),
        copy: $<HTMLButtonElement>("update-copy"),
        dismiss: $<HTMLButtonElement>("update-dismiss"),
      },
      relayToken,
      updateStartButton,
    );
    updateBanner.apply(relayInfo);
    selectMethod("relay");
    if (relayInfo.tokenRequired && !relayToken) {
      relayEmptyText = "Access token needed.";
      renderRelayPhones();
      wireless.setDisabled(true);
    } else {
      await refreshRelayDevices();
      watchRelayDevices();
    }
  } else {
    showRelaySetup(usb.supported);
    selectMethod(usb.supported ? "webusb" : "relay");
  }

  if (usb.supported) {
    setHint(
      ui.webUsbHint,
      relayUsable()
        ? "For computers without DeXterous. DeXterous is running here, so use Through DeXterous: it works over USB too."
        : "Talks to the phone straight from this tab. Close other adb tools on your computer first.",
    );
  }

  if (!WebCodecsVideoDecoder.isSupported) {
    setStatus("This browser can't decode video (WebCodecs). Use a current Chrome, Edge, Safari or Firefox.", "error");
  }
  refreshDerived();
}

// #endregion

// #region Session lifecycle

/** How long the connect screen fades out under the loading screen (matches `handoff` in styles.css). */
const HANDOFF_MS = 320;
let handoffTimer = 0;

function setView(view: "connect" | "session") {
  // A hand-off still running (say, a start that failed at once) ends here.
  clearTimeout(handoffTimer);
  delete document.body.dataset.handoff;
  const handOff = view === "session" && motionEnabled() && !ui.connectView.hidden;

  document.body.dataset.view = view;
  ui.sessionView.hidden = view !== "session";
  if (handOff) {
    // The loading screen fades in over the connect screen, which hides once it's covered.
    document.body.dataset.handoff = "true";
    ui.connectView.inert = true;
    handoffTimer = window.setTimeout(() => {
      delete document.body.dataset.handoff;
      ui.connectView.hidden = true;
      ui.connectView.inert = false;
    }, HANDOFF_MS);
  } else {
    ui.connectView.inert = false;
    ui.connectView.hidden = view !== "connect";
  }
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
  if (!choice || starting || updateBanner?.updating) {
    return;
  }
  settings = readForm(ui.settingsForm, settings);
  saveSettings(settings);
  writeStored(LAST_PHONE_KEY, choice.serial);

  // Must be created inside the click: browsers only allow audio started by a gesture.
  const audioPlayer = settings.audio ? createAudioPlayer() : undefined;

  const abort = new AbortController();
  starting = abort;
  activeList().setConnecting(choice.id, phoneDetails);
  updateStartButton();
  setStatus("");
  ui.busySwitch.hidden = true;
  replaceCanvas();
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
    // A session just disconnected may still be letting go of the phone (at most 8 s); over
    // WebUSB, a new connection can't claim the phone before that.
    await closingSession;

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
    // Show the loading screen only once the connection didn't fail at once (say, the phone is
    // busy), so a quick failure doesn't flash it.
    const failedAtOnce = await Promise.race([
      connecting.then(
        () => false,
        () => true,
      ),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 150)),
    ]);
    if (!failedAtOnce) {
      setView("session");
    }
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
      // reached this device's clipboard yet (e.g. Safari blocked the write).
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

    // After Disconnect, this session ends in the background, maybe once a new one has started:
    // only end the session that's still on screen.
    const started = active;
    const endIfCurrent = (reason: string | undefined) => (active === started ? endSession(reason) : undefined);
    void session.ended.then(endIfCurrent, (error: unknown) => endIfCurrent(errorMessage(error)));
  } catch (error) {
    void audioPlayer?.stop().catch(() => {});
    await adb?.close().catch(() => {});
    setView("connect");
    if (abort.signal.aborted) {
      setStatus("Cancelled.");
    } else {
      console.error("Couldn't start DeX", error);
      if (error instanceof UsbBusyError && relayUsable()) {
        // Browser-only mode needs the phone to itself; say so plainly and let the person choose.
        busySerial = choice.serial;
        setStatus(
          "Browser-only mode can't reach the phone: adb on your computer is using it. Close the programs that use adb, or start DeX through DeXterous instead.",
          "error",
        );
        ui.busySwitch.hidden = false;
      } else {
        setStatus(errorMessage(error), "error");
      }
    }
  } finally {
    ui.cancelStart.removeEventListener("click", cancel);
    starting = undefined;
    activeList().setConnecting(undefined, phoneDetails);
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
  // Close the session (which ends DeX's display on the phone), then the connection. Over
  // WebUSB either can hang, so the page doesn't wait for them, and each gets a time limit.
  closingSession = settleWithin(current.session.close(), 4000).then(() => settleWithin(current.adb.close(), 4000));
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
  void refreshRelayInfo();
}

/** Waits for `promise` to settle, but no longer than `ms`. Never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function resetSessionUi() {
  ui.stats.hidden = true;
  ui.toast.hidden = true;
  ui.lockScreen.hidden = true;
  setGuideOpen(false);
  setDockOpen(false);
  setDockPeek(false);
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
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, handler as EventListener, options);
    disposers.push(() => target.removeEventListener(type, handler as EventListener, options));
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

  // The guide's Help links open in a new tab; typing should still reach DeX afterwards.
  listen(ui.guide, "click", (event) => {
    if ((event.target as Element).closest("a")) {
      const pointerType = (event as PointerEvent).pointerType;
      if (pointerType !== "touch" && pointerType !== "pen") {
        current.input.focusKeyboard();
      }
    }
  });

  listen(ui.dockHandle, "click", () => {
    setDockOpen(ui.sessionView.dataset.dock !== "open");
  });

  // Show the dock when the mouse rests near the top of the screen, under the dock, or slides
  // off the top edge (easy to overshoot in a window). DeX still gets every event, so title bars
  // and dragging a window to the top keep working. Capture phase: input.ts may stop propagation.
  const stageEvent = { capture: true, passive: true };
  listen(ui.stage, "pointermove", (event) => dockPointer(event, false), stageEvent);
  listen(ui.stage, "pointerleave", (event) => dockPointer(event, true), stageEvent);
  // Leaving the dock (e.g. out of the window) hands the hiding back to the timer.
  listen(ui.dock, "pointerleave", (event) => {
    if (event.pointerType === "mouse" && "dockPeek" in ui.sessionView.dataset && !dockPeekPending) {
      armDockPeekTimer(false, 400);
    }
  }, { passive: true });

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
 * is muted and nothing is copied to this device's clipboard.
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
      // Back to the connect screen at once; the phone side is cleaned up in the background.
      void endSession(undefined);
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

/** How close to the top of the screen the mouse has to be to bring up the dock. */
const DOCK_REVEAL_PX = 36;
/** How far below the dock the mouse can wander before it hides again. */
const DOCK_KEEP_PX = 56;
let dockPeekTimer = 0;
/** What the timer is counting down to: showing the dock, hiding it, or nothing. */
let dockPeekPending: "show" | "hide" | undefined;

function setDockPeek(peek: boolean) {
  cancelDockPeekTimer();
  if (peek) {
    ui.sessionView.dataset.dockPeek = "";
  } else {
    delete ui.sessionView.dataset.dockPeek;
  }
}

function cancelDockPeekTimer() {
  clearTimeout(dockPeekTimer);
  dockPeekPending = undefined;
}

function armDockPeekTimer(show: boolean, delay: number) {
  dockPeekPending = show ? "show" : "hide";
  dockPeekTimer = window.setTimeout(() => setDockPeek(show), delay);
}

/** Handles the mouse over the DeX screen: opens the dock near the top, hides it further down. */
function dockPointer(event: PointerEvent, left: boolean) {
  // Mice only (touch has the ⌄ handle), and never while dragging, e.g. a window to the top edge.
  if (event.pointerType !== "mouse" || event.buttons !== 0) {
    if (dockPeekPending === "show") cancelDockPeekTimer();
    return;
  }
  const stage = ui.stage.getBoundingClientRect();
  const dock = ui.dock.getBoundingClientRect();
  const y = event.clientY - stage.top;
  // The dock's resting spot, not its animated one: it sits off-screen while hidden.
  const dockBottom = ui.dock.offsetTop + ui.dock.offsetHeight;
  const underDock = event.clientX >= dock.left - DOCK_KEEP_PX && event.clientX <= dock.right + DOCK_KEEP_PX;
  const peeking = "dockPeek" in ui.sessionView.dataset;

  if (left) {
    // Slid off the top edge: show it right away. Any other way out cancels a pending show.
    if (y <= 4 && underDock) setDockPeek(true);
    else if (dockPeekPending === "show") cancelDockPeekTimer();
    return;
  }
  if (y <= DOCK_REVEAL_PX && underDock) {
    if (dockPeekPending === "hide") cancelDockPeekTimer();
    if (!peeking && !dockPeekPending) armDockPeekTimer(true, 250);
  } else if (dockPeekPending === "show") {
    cancelDockPeekTimer();
  } else if (peeking) {
    if (y > dockBottom + DOCK_KEEP_PX || !underDock) {
      if (!dockPeekPending) armDockPeekTimer(false, 400);
    } else if (dockPeekPending === "hide") {
      cancelDockPeekTimer();
    }
  }
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

initPreferences({ theme: $("theme-switch"), motion: $("motion-switch") });
void initConnectScreen();
