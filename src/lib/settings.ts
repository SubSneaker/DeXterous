import { isMacLike } from "./keymap";
import type { DexSettings } from "./types";

const STORAGE_KEY = "dexterous:settings";

export function defaultSettings(): DexSettings {
  return {
    resolutionScale: Math.min(2, Math.max(1, Math.round((window.devicePixelRatio || 1) * 2) / 2)),
    uiZoom: 1,
    videoCodec: "h264",
    videoBitRate: 16,
    maxFps: 60,
    audio: true,
    audioDup: false,
    clipboardSync: true,
    showAndroidKeyboard: false,
    commandAsCtrl: isMacLike(),
    keepAppsOnDisconnect: true,
    allowWhileLocked: false,
  };
}

export function loadSettings(): DexSettings {
  const defaults = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<DexSettings>;
    const merged = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof DexSettings)[]) {
      if (typeof saved[key] === typeof defaults[key]) {
        (merged as Record<keyof DexSettings, unknown>)[key] = saved[key];
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: DexSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted (private mode / blocked storage); the session still uses them.
  }
}

/** Writes settings into the form controls (matched by `name`). */
export function fillForm(form: HTMLFormElement, settings: DexSettings): void {
  for (const [key, value] of Object.entries(settings)) {
    const control = form.elements.namedItem(key);
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      control.checked = Boolean(value);
    } else if (control instanceof HTMLSelectElement) {
      control.value = String(value);
      // Fall back to the first option if a saved value isn't offered anymore.
      if (control.selectedIndex === -1) {
        control.selectedIndex = 0;
      }
    }
  }
}

/** Reads the form controls back into a settings object. */
export function readForm(form: HTMLFormElement, previous: DexSettings): DexSettings {
  const next = { ...previous } as Record<keyof DexSettings, unknown>;
  for (const key of Object.keys(previous) as (keyof DexSettings)[]) {
    const control = form.elements.namedItem(key);
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      next[key] = control.checked;
    } else if (control instanceof HTMLSelectElement) {
      next[key] = typeof previous[key] === "number" ? Number(control.value) : control.value;
    }
  }
  return next as unknown as DexSettings;
}
