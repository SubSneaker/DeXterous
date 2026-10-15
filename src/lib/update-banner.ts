import { readStored, writeStored } from "./storage";
import type { RelayInfo, UpdateInfo } from "./transports";

const DISMISSED_KEY = "dexterous:update-dismissed";
const POLL_MS = 1500;
/** If the relay doesn't come back this long after "Update now", say so. */
const GIVE_UP_MS = 3 * 60 * 1000;
/** Polls that report "idle" after we started, before we decide nothing happened. */
const IDLE_POLLS_BEFORE_GIVING_UP = 4;
/** After a "DeX session is open" answer, ask once more after this long. */
const CONFLICT_RETRY_MS = 1500;

export interface UpdateBannerElements {
  root: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  notes: HTMLAnchorElement;
  install: HTMLButtonElement;
  command: HTMLElement;
  commandText: HTMLElement;
  copy: HTMLButtonElement;
  dismiss: HTMLButtonElement;
}

type View = "hidden" | "available" | "manual" | "busy" | "failed";

/** The JSON body of `POST /api/update`'s answer. */
interface UpdateResponse {
  state?: unknown;
  error?: unknown;
}

function isShuttingDown(body: UpdateResponse | undefined): boolean {
  return typeof body?.error === "string" && /shutting down/i.test(body.error);
}

/**
 * The "a new version is out" banner on the connect screen. It follows the
 * relay's `update` field and, when the relay can update itself, drives
 * `POST /api/update` and waits for the relay to come back on the new version.
 */
export class UpdateBanner {
  readonly #el: UpdateBannerElements;
  readonly #token: string | undefined;
  #info: UpdateInfo | undefined;
  /** The relay version this page was loaded from. A different one means it restarted. */
  #version = "";
  #pollTimer = 0;
  #pollingSince = 0;
  #polling = false;
  #idlePolls = 0;
  /** Set after a failed or impossible self-update, so the banner offers the command instead. */
  #forceManual = false;
  #message = "";
  readonly #onUpdatingChange: () => void;
  #wasUpdating = false;

  /** `onUpdatingChange` runs whenever `updating` turns true or false. */
  constructor(elements: UpdateBannerElements, token: string | undefined, onUpdatingChange: () => void = () => {}) {
    this.#el = elements;
    this.#token = token;
    this.#onUpdatingChange = onUpdatingChange;
    elements.install.addEventListener("click", () => void this.#install());
    elements.dismiss.addEventListener("click", () => this.#dismiss());
    elements.copy.addEventListener("click", () => this.#copy());
  }

  /** Call with each fresh `/api/info`. */
  apply(info: RelayInfo | undefined) {
    this.#version = info?.version ?? this.#version;
    this.#info = info?.update;
    const state = this.#info?.state;
    if (state === "installing" || state === "restarting") {
      // The page was opened (or reloaded) while an update is running.
      this.#startPolling();
    }
    this.#render();
  }

  /** An update is installing, or DeXterous is restarting after one. */
  get updating(): boolean {
    const state = this.#info?.state;
    return state === "installing" || state === "restarting";
  }

  #view(): View {
    const info = this.#info;
    if (!info) {
      return "hidden";
    }
    if (info.state === "installing" || info.state === "restarting") {
      return "busy";
    }
    if (info.state === "failed" || this.#message !== "") {
      return "failed";
    }
    if (!info.available) {
      return "hidden";
    }
    if (info.latest !== null && readStored(DISMISSED_KEY) === info.latest) {
      return "hidden";
    }
    return info.canSelfUpdate && !this.#forceManual ? "available" : "manual";
  }

  #render() {
    if (this.updating !== this.#wasUpdating) {
      this.#wasUpdating = this.updating;
      this.#onUpdatingChange();
    }
    const info = this.#info;
    const view = this.#view();
    const el = this.#el;
    el.root.hidden = view === "hidden";
    if (!info || view === "hidden") {
      return;
    }
    el.root.dataset.view = view;
    el.title.textContent =
      info.latest !== null ? `DeXterous ${info.latest} is available` : "A new version of DeXterous is available";
    el.notes.href = info.notesUrl;

    const failed = view === "failed";
    const manual = view === "manual" || (failed && !info.canSelfUpdate) || this.#forceManual;
    el.install.hidden = !(view === "available" || (failed && info.canSelfUpdate && !this.#forceManual));
    el.install.textContent = failed ? "Try again" : "Update now";
    el.command.hidden = !manual;
    el.commandText.textContent = info.command;
    el.dismiss.hidden = view === "busy";

    let detail = "";
    if (view === "busy") {
      detail = info.state === "restarting" ? "Restarting…" : "Installing…";
      if (this.#message) {
        detail = this.#message;
      }
    } else if (failed) {
      detail = this.#message || info.error || "The update didn't work.";
    } else if (view === "manual") {
      detail = "To update, run this in a terminal, then start DeXterous again:";
    }
    if (el.detail.textContent !== detail) {
      el.detail.textContent = detail;
    }
    el.detail.hidden = detail === "";
  }

  async #install() {
    const info = this.#info;
    if (!info) {
      return;
    }
    this.#message = "";
    this.#forceManual = false;
    this.#el.install.disabled = true;
    try {
      let response = await this.#requestUpdate();
      if (response.status === 409 && !isShuttingDown(response.body)) {
        // A session that is just ending can still hold its connections for a
        // moment, so ask once more before saying one is open.
        await new Promise((resolve) => window.setTimeout(resolve, CONFLICT_RETRY_MS));
        response = await this.#requestUpdate();
      }
      if (response.status === 202) {
        // "installing", or "restarting" when an update started elsewhere is already done.
        this.#info = { ...info, state: response.body?.state === "restarting" ? "restarting" : "installing" };
        this.#startPolling();
      } else if (response.status === 409) {
        // A DeX session is open (or DeXterous is shutting down); the relay says which.
        this.#message = isShuttingDown(response.body)
          ? String(response.body?.error)
          : "A DeX session is open, maybe in another tab. Disconnect it, then try again.";
      } else if (response.status === 400) {
        this.#message = "DeXterous can't update itself right now.";
        this.#forceManual = true;
      } else if (response.status === 401 || response.status === 403) {
        this.#message = "This page isn't allowed to update DeXterous. Run the command on the computer instead.";
        this.#forceManual = true;
      } else {
        this.#message = `Couldn't start the update (error ${response.status}).`;
      }
    } catch {
      this.#message = "Couldn't reach DeXterous. Is it still running?";
    } finally {
      this.#el.install.disabled = false;
    }
    this.#render();
  }

  async #requestUpdate(): Promise<{ status: number; body: UpdateResponse | undefined }> {
    const response = await fetch("/api/update", {
      method: "POST",
      cache: "no-store",
      headers: this.#token ? { Authorization: `Bearer ${this.#token}` } : {},
    });
    const body = (await response.json().catch(() => undefined)) as UpdateResponse | undefined;
    return { status: response.status, body };
  }

  #startPolling() {
    if (this.#pollTimer) {
      return;
    }
    this.#pollingSince = Date.now();
    this.#idlePolls = 0;
    this.#pollTimer = window.setInterval(() => void this.#poll(), POLL_MS);
  }

  #stopPolling() {
    clearInterval(this.#pollTimer);
    this.#pollTimer = 0;
  }

  async #poll() {
    // A slow answer must not overlap the next tick.
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      await this.#pollOnce();
    } finally {
      this.#polling = false;
    }
  }

  async #pollOnce() {
    let info: RelayInfo | undefined;
    try {
      const response = await fetch("/api/info", { cache: "no-store", signal: AbortSignal.timeout(4000) });
      if (response.ok) {
        info = (await response.json()) as RelayInfo;
      }
    } catch {
      // The relay is down while it restarts. Keep waiting.
    }

    if (info?.relay === true) {
      if (this.#version && info.version !== this.#version) {
        location.reload();
        return;
      }
      this.#info = info.update ?? this.#info;
      const state = this.#info?.state;
      if (state === "failed") {
        this.#stopPolling();
        this.#render();
        return;
      }
      this.#idlePolls = state === "idle" ? this.#idlePolls + 1 : 0;
      if (this.#idlePolls >= IDLE_POLLS_BEFORE_GIVING_UP) {
        this.#stopPolling();
        this.#message = "The update didn't change anything.";
        this.#forceManual = true;
        this.#render();
        return;
      }
    } else if (this.#info && this.#info.state === "installing") {
      // Went away without saying "restarting": that's what restarting looks like from here.
      this.#info = { ...this.#info, state: "restarting" };
    }

    if (Date.now() - this.#pollingSince > GIVE_UP_MS) {
      this.#stopPolling();
      this.#message = "DeXterous didn't come back. Start it again, then reload this page.";
      this.#forceManual = true;
      if (this.#info) {
        this.#info = { ...this.#info, state: "failed" };
      }
    }
    this.#render();
  }

  #dismiss() {
    if (this.#info?.latest) {
      writeStored(DISMISSED_KEY, this.#info.latest);
    }
    this.#message = "";
    this.#forceManual = false;
    this.#el.root.hidden = true;
  }

  #copy() {
    const command = this.#info?.command;
    if (command) {
      void copyCommand(this.#el.copy, command, this.#el.commandText);
    }
  }
}

const copyTimers = new WeakMap<HTMLButtonElement, number>();

/**
 * Copies a command for the terminal, and says on the button whether it did. Without clipboard
 * access (plain http, or blocked), it selects `shown` instead, so Ctrl+C works.
 */
export async function copyCommand(button: HTMLButtonElement, text: string, shown: HTMLElement) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(shown);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  button.textContent = copied ? "Copied" : "Selected";
  clearTimeout(copyTimers.get(button));
  copyTimers.set(
    button,
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 2000),
  );
}
