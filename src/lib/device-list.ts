import { formatOneUi, MIN_ONE_UI, type PhoneDetails } from "./phone-info";
import type { DeviceChoice } from "./types";

/** What the page knows about a phone's details: still loading, read, or not readable. */
export type DetailsState = PhoneDetails | "loading" | "failed" | undefined;

export interface DeviceListOptions {
  /** The radio group element (`role="radiogroup"`). */
  root: HTMLElement;
  /** Fires when the selected phone changes, by click or keyboard. */
  onChange: () => void;
  /** Enter on a phone card. */
  onActivate: () => void;
}

/**
 * Phone cards as an ARIA radio group: one tab stop, arrow keys move and select,
 * Space selects and Enter starts. Shared by the relay and WebUSB panels.
 */
export class DeviceList {
  readonly #root: HTMLElement;
  readonly #onChange: () => void;
  readonly #onActivate: () => void;
  readonly #cards = new Map<string, HTMLElement>();
  #devices: DeviceChoice[] = [];
  #selectedId: string | undefined;
  #connectingId: string | undefined;

  constructor(options: DeviceListOptions) {
    this.#root = options.root;
    this.#onChange = options.onChange;
    this.#onActivate = options.onActivate;
    this.#root.addEventListener("click", (event) => {
      const card = (event.target as Element).closest<HTMLElement>("[role=radio]");
      if (card?.dataset.id) {
        this.select(card.dataset.id, true);
      }
    });
    this.#root.addEventListener("keydown", (event) => this.#onKeyDown(event));
  }

  get devices(): readonly DeviceChoice[] {
    return this.#devices;
  }

  get selected(): DeviceChoice | undefined {
    return this.#devices.find((device) => device.id === this.#selectedId);
  }

  /** Marks one phone as "Connecting…" while a session starts. */
  setConnecting(id: string | undefined, details: ReadonlyMap<string, DetailsState>) {
    this.#connectingId = id;
    this.render(this.#devices, details);
  }

  /**
   * Shows the phones. A selection that still exists is kept; otherwise `prefer`
   * picks one (the last-used phone), then the first phone that's ready.
   */
  render(
    devices: DeviceChoice[],
    details: ReadonlyMap<string, DetailsState>,
    prefer?: (device: DeviceChoice) => boolean,
  ) {
    this.#devices = devices;
    if (!devices.some((device) => device.id === this.#selectedId)) {
      this.#selectedId = (
        devices.find((device) => device.ready && prefer?.(device)) ??
        devices.find((device) => prefer?.(device)) ??
        devices.find((device) => device.ready) ??
        devices[0]
      )?.id;
    }

    const refocus = this.#root.contains(document.activeElement);
    const live = new Set(devices.map((device) => device.id));
    for (const [id, card] of this.#cards) {
      if (!live.has(id)) {
        card.remove();
        this.#cards.delete(id);
      }
    }
    devices.forEach((device, index) => {
      let card = this.#cards.get(device.id);
      if (!card) {
        card = createCard(device.id);
        this.#cards.set(device.id, card);
      }
      this.#fillCard(card, device, details.get(device.serial));
      if (this.#root.children[index] !== card) {
        this.#root.insertBefore(card, this.#root.children[index] ?? null);
      }
    });
    this.#root.hidden = devices.length === 0;
    this.#syncSelection();
    if (refocus && this.#root.contains(document.activeElement) === false) {
      this.#focusCard(this.#selectedId);
    }
  }

  select(id: string, focus = false) {
    if (!this.#devices.some((device) => device.id === id)) {
      return;
    }
    const changed = this.#selectedId !== id;
    this.#selectedId = id;
    this.#syncSelection();
    if (focus) {
      this.#focusCard(id);
    }
    if (changed) {
      this.#onChange();
    }
  }

  #fillCard(card: HTMLElement, device: DeviceChoice, state: DetailsState) {
    const details = typeof state === "object" ? state : undefined;
    const name = details?.name ?? device.model;
    const connecting = this.#connectingId === device.id;
    const oneUiTooOld = details?.oneUi !== undefined && details.oneUi < MIN_ONE_UI;

    card.dataset.state = connecting ? "connecting" : device.ready ? "ready" : "waiting";
    setText(card, ".phone-name", name);

    const badge = card.querySelector<HTMLElement>(".badge")!;
    badge.textContent = device.kind === "webusb" ? "USB" : device.wireless ? "Wi‑Fi" : "USB";
    badge.dataset.kind = device.wireless ? "wifi" : "usb";

    // The second line: model code (only when the name is something nicer), One UI, battery.
    const meta = card.querySelector<HTMLElement>(".phone-meta")!;
    const parts: { text: string; tone?: "warning" }[] = [];
    if (details && details.model && details.model !== name) {
      parts.push({ text: details.model });
    }
    if (details?.oneUi !== undefined) {
      parts.push({ text: formatOneUi(details.oneUi), ...(oneUiTooOld ? { tone: "warning" as const } : {}) });
      if (oneUiTooOld) {
        parts.push({ text: "needs One UI 8+", tone: "warning" });
      }
    } else if (details && /samsung/i.test(details.manufacturer)) {
      // A Galaxy without the property is older than One UI 8.
      parts.push({ text: "needs One UI 8+", tone: "warning" });
    } else if (details?.manufacturer) {
      parts.push({ text: "not a Galaxy", tone: "warning" });
    }
    if (details?.battery !== undefined) {
      parts.push({ text: `${details.battery}%${details.charging ? " charging" : ""}` });
    }
    if (parts.length === 0 && state === "loading" && device.ready) {
      parts.push({ text: "Reading details…" });
    }
    meta.replaceChildren(
      ...parts.map((part) => {
        const span = document.createElement("span");
        span.textContent = part.text;
        if (part.tone) {
          span.dataset.tone = part.tone;
        }
        return span;
      }),
    );
    meta.hidden = parts.length === 0;

    setText(
      card,
      ".phone-status",
      connecting ? "Connecting…" : device.ready ? "Ready" : "Tap Allow on your phone",
    );
  }

  #syncSelection() {
    for (const [id, card] of this.#cards) {
      const selected = id === this.#selectedId;
      card.setAttribute("aria-checked", String(selected));
      // Roving tab stop: only the selected card is reachable with Tab.
      card.tabIndex = selected ? 0 : -1;
    }
  }

  #focusCard(id: string | undefined) {
    if (id !== undefined) {
      this.#cards.get(id)?.focus();
    }
  }

  #onKeyDown(event: KeyboardEvent) {
    const card = (event.target as Element).closest<HTMLElement>("[role=radio]");
    if (!card || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const index = this.#devices.findIndex((device) => device.id === card.dataset.id);
    let target = -1;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        target = (index + 1) % this.#devices.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        target = (index - 1 + this.#devices.length) % this.#devices.length;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = this.#devices.length - 1;
        break;
      case " ":
        this.select(card.dataset.id!, true);
        event.preventDefault();
        return;
      case "Enter":
        this.select(card.dataset.id!);
        this.#onActivate();
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    const next = this.#devices[target];
    if (next) {
      this.select(next.id, true);
    }
  }
}

function setText(card: HTMLElement, selector: string, text: string) {
  const element = card.querySelector(selector);
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
}

function createCard(id: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "phone";
  card.setAttribute("role", "radio");
  card.setAttribute("aria-checked", "false");
  card.tabIndex = -1;
  card.dataset.id = id;
  card.innerHTML = `
    <svg class="phone-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>
    <span class="phone-main">
      <span class="phone-name"></span>
      <span class="phone-meta"></span>
    </span>
    <span class="phone-side">
      <span class="badge"></span>
      <span class="phone-status"></span>
    </span>`;
  return card;
}
