export interface WirelessFormElements {
  form: HTMLFormElement;
  address: HTMLInputElement;
  /** The "first time" section holding the next two fields. */
  pairSection: HTMLDetailsElement;
  pairAddress: HTMLInputElement;
  pairCode: HTMLInputElement;
  submit: HTMLButtonElement;
  status: HTMLElement;
}

export interface WirelessActions {
  /** `adb pair`: the pairing address and the 6-digit code. */
  pair(address: string, code: string): Promise<void>;
  /** `adb connect`. */
  connect(address: string): Promise<void>;
  /** Called once the phone is connected, with the address that was used. */
  onConnected(address: string): void;
}

/** "192.168.1.20:37215", "phone.local:5555" or "[fe80::1]:5555". The port is optional only when `needPort` is false. */
export function parseAddress(value: string, needPort: boolean): string | undefined {
  const text = value.trim();
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const port = match[2];
  if (port === undefined) {
    return needPort ? undefined : text;
  }
  const number = Number(port);
  return number >= 1 && number <= 65535 ? text : undefined;
}

/** Android's pairing code: exactly six digits. */
export function parseCode(value: string): string | undefined {
  const text = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(text) ? text : undefined;
}

/**
 * Turns what adb said into something a person can act on. adb's own answers
 * to `host:pair` (from `adb_wifi_pair_device`) are:
 *
 * - "Failed: Wrong password or connection was dropped." when the code is wrong,
 *   the pairing window closed, or nothing answered at the pairing address,
 * - "Failed to parse address for pairing: …" and "Invalid port while parsing
 *   address […]" for a bad address,
 * - "Failed: Unable to start pairing client." and "Failed: unable to create
 *   pairing client." when adb couldn't start pairing at all.
 */
export function describePairError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Failed: Wrong password or connection was dropped/i.test(message)) {
    return "That pairing code didn't work. Check the 6-digit code and the pairing address, and keep the pairing window open on the phone.";
  }
  if (/^(Failed to parse address for pairing|Invalid port while parsing address)/i.test(message)) {
    return "Check the pairing address. It's in the pairing window on the phone, like 192.168.1.20:41555.";
  }
  // The relay's and DeXterous's own messages are already readable.
  if (/relay|adb|DeXterous/i.test(message) && !/^Failed/i.test(message)) {
    return message;
  }
  return `Couldn't pair. Check the pairing address, and that the pairing window is still open on the phone. (${message})`;
}

export function describeConnectError(error: unknown, address: string): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "UnauthorizedError") {
    return "The phone hasn't accepted this connection. Pair it first (open “First time pairing this phone?” above), and check that Wireless debugging is on.";
  }
  if (name === "NetworkError") {
    return `Couldn't reach ${address}. Check the address, and that the phone and the computer running DeXterous are on the same Wi‑Fi. (${message})`;
  }
  return message;
}

/**
 * The "Add a phone over Wi‑Fi" form: an address, and optionally Android's
 * Wireless debugging pairing address and code. Pairs first when asked, then connects.
 */
export class WirelessForm {
  readonly #el: WirelessFormElements;
  readonly #actions: WirelessActions;
  #busy = false;
  #disabled = false;

  constructor(elements: WirelessFormElements, actions: WirelessActions) {
    this.#el = elements;
    this.#actions = actions;
    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#submit();
    });
    elements.pairSection.addEventListener("input", () => this.#updateLabel());
    elements.pairSection.addEventListener("toggle", () => this.#updateLabel());
    // Digits only, up to six, so a pasted "123 456" still works.
    elements.pairCode.addEventListener("input", () => {
      elements.pairCode.value = elements.pairCode.value.replace(/\D/g, "").slice(0, 6);
    });
    this.#updateLabel();
  }

  setDisabled(disabled: boolean) {
    this.#disabled = disabled;
    this.#el.submit.disabled = disabled || this.#busy;
  }

  #pairing(): boolean {
    const { pairSection, pairAddress, pairCode } = this.#el;
    return pairSection.open && (pairAddress.value.trim() !== "" || pairCode.value !== "");
  }

  #updateLabel() {
    this.#el.submit.textContent = this.#pairing() ? "Pair and connect" : "Connect";
  }

  #setStatus(message: string, tone: "info" | "error" | "success" = "info") {
    this.#el.status.textContent = message;
    this.#el.status.dataset.tone = tone;
  }

  #setBusy(busy: boolean) {
    this.#busy = busy;
    this.#el.submit.disabled = busy || this.#disabled;
    this.#el.form.setAttribute("aria-busy", String(busy));
  }

  async #submit() {
    if (this.#busy) {
      return;
    }
    const { address: addressInput, pairAddress: pairInput, pairCode: codeInput } = this.#el;
    const pairing = this.#pairing();

    const address = parseAddress(addressInput.value, pairing);
    if (!address) {
      this.#setStatus(
        "Enter the phone's address with its port, like 192.168.1.20:37215. It's on the Wireless debugging screen.",
        "error",
      );
      addressInput.focus();
      return;
    }
    let pair: { address: string; code: string } | undefined;
    if (pairing) {
      const pairAddress = parseAddress(pairInput.value, true);
      const code = parseCode(codeInput.value);
      if (!pairAddress) {
        this.#setStatus("Enter the pairing address from the pairing window, like 192.168.1.20:41555.", "error");
        pairInput.focus();
        return;
      }
      if (!code) {
        this.#setStatus("Enter the 6-digit pairing code from the pairing window.", "error");
        codeInput.focus();
        return;
      }
      pair = { address: pairAddress, code };
    }

    this.#setBusy(true);
    try {
      if (pair) {
        this.#setStatus("Pairing…");
        try {
          await this.#actions.pair(pair.address, pair.code);
        } catch (error) {
          this.#setStatus(describePairError(error), "error");
          return;
        }
      }
      this.#setStatus("Connecting…");
      try {
        await this.#actions.connect(address);
      } catch (error) {
        this.#setStatus(
          pair
            ? `Paired, but couldn't connect. ${describeConnectError(error, address)}`
            : describeConnectError(error, address),
          "error",
        );
        return;
      }
      this.#setStatus("Connected. Your phone is in the list above.", "success");
      // The pairing code is single-use; don't leave it behind.
      codeInput.value = "";
      this.#actions.onConnected(address);
    } finally {
      this.#setBusy(false);
    }
  }
}
