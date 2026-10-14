/** What the page currently knows about the setup, relay method. */
export interface RelayFacts {
  method: "relay";
  relayRunning: boolean;
  /** The relay wants an access token and this page has none. */
  tokenMissing: boolean;
  adbReachable: boolean;
  /** Phones adb lists (any state). */
  phones: number;
  /** Phones that allowed the computer running DeXterous. */
  allowed: number;
  /** The selected phone's One UI, once its details are read. */
  oneUi: "checking" | "ok" | "old" | "not-galaxy" | "unknown" | undefined;
}

/** The same for the browser-only USB method, where the page can't see debugging or One UI. */
export interface WebUsbFacts {
  method: "webusb";
  supported: boolean;
  phones: number;
}

export type StepStatus = "done" | "current" | "pending" | "checking" | "skipped";

export interface Step {
  label: string;
  status: StepStatus;
  /** Plain-words fix, only on the first step that isn't done. */
  fix?: string;
}

interface Check {
  label: string;
  /** true = done, false = not yet, "checking"/"skipped" = neither passed nor failed. */
  result: boolean | "checking" | "skipped";
  fix: string;
}

const ENABLE_DEBUGGING =
  "Settings › About phone › Software information, tap Build number 7 times, then Developer options › USB debugging.";

export function buildSteps(facts: RelayFacts | WebUsbFacts): Step[] {
  const checks: Check[] =
    facts.method === "relay"
      ? [
          {
            label: "DeXterous is running",
            result: facts.relayRunning && !facts.tokenMissing,
            fix: facts.tokenMissing
              ? "This relay needs an access token. Open the link with #token=… that it printed when it started."
              : "Run `dexterous` on the computer the phone is plugged into, then open the address it prints.",
          },
          {
            label: "DeXterous can talk to adb",
            result: facts.adbReachable,
            fix: "Install Android platform-tools so `adb` works in a terminal, then restart `dexterous`.",
          },
          {
            label: "Phone found",
            result: facts.phones > 0,
            fix: `Plug in your phone with a USB cable and unlock it. Not showing up? Turn on USB debugging: ${ENABLE_DEBUGGING} Or add it over Wi‑Fi above.`,
          },
          {
            label: "USB debugging allowed",
            result: facts.allowed > 0,
            fix: "Unlock your phone and tap Allow on the “Allow USB debugging?” prompt. Tick “Always allow” so it only asks once.",
          },
          {
            label: "One UI 8 or newer",
            result:
              facts.oneUi === "ok"
                ? true
                : facts.oneUi === "old" || facts.oneUi === "not-galaxy"
                  ? false
                  : facts.oneUi === "unknown"
                    ? "skipped"
                    : "checking",
            fix:
              facts.oneUi === "not-galaxy"
                ? "This isn't a Galaxy phone, so you'll get Android's own desktop (if it has one). Samsung DeX needs a Galaxy phone."
                : "DeX in a browser needs One UI 8 or newer. Update your phone in Settings › Software update.",
          },
        ]
      : [
          {
            label: "This browser can use USB",
            result: facts.supported,
            fix: "Use Chrome, Edge or another Chromium browser on a secure (https or localhost) page.",
          },
          {
            label: "Phone added",
            result: facts.phones > 0,
            fix: `Plug in your phone and turn on USB debugging: ${ENABLE_DEBUGGING} Then choose Add phone…. You'll need One UI 8 or newer.`,
          },
        ];

  let failedYet = false;
  return checks.map((check): Step => {
    if (check.result === true) {
      return { label: check.label, status: "done" };
    }
    if (check.result === "skipped") {
      return { label: check.label, status: "skipped" };
    }
    if (failedYet) {
      return { label: check.label, status: "pending" };
    }
    failedYet = true;
    // Still reading the phone: neither a tick nor a fix yet.
    return check.result === "checking"
      ? { label: check.label, status: "checking" }
      : { label: check.label, status: "current", fix: check.fix };
  });
}

/** Everything is done (a step we couldn't check doesn't hold things up). */
export function isReady(steps: readonly Step[]): boolean {
  return steps.every((step) => step.status === "done" || step.status === "skipped");
}

export interface ChecklistElements {
  root: HTMLDetailsElement;
  count: HTMLElement;
  list: HTMLElement;
}

/** The live "Before you start" list. Folds away once the phone is ready. */
export class Checklist {
  readonly #el: ChecklistElements;
  #ready: boolean | undefined;

  constructor(elements: ChecklistElements) {
    this.#el = elements;
  }

  render(steps: Step[]) {
    const ready = isReady(steps);
    const done = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
    this.#el.count.textContent = ready ? "All set" : `${done} of ${steps.length} done`;
    this.#el.root.dataset.ready = String(ready);
    // Only fold or unfold when readiness changes, so a manual toggle isn't undone.
    if (ready !== this.#ready) {
      this.#el.root.open = !ready;
      this.#ready = ready;
    }
    // Update the items in place, so a tick only animates when its step gets done.
    const items = steps.map((step, index) => {
      const item = this.#el.list.children[index];
      return item instanceof HTMLLIElement ? fillStep(item, step) : fillStep(createStep(), step);
    });
    if (items.some((item, index) => this.#el.list.children[index] !== item) || this.#el.list.children.length !== items.length) {
      this.#el.list.replaceChildren(...items);
    }
  }
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: "Done: ",
  skipped: "Not checked: ",
  current: "To do: ",
  checking: "Checking: ",
  pending: "Later: ",
};

function createStep(): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "step";

  const mark = document.createElement("span");
  mark.className = "step-mark";
  mark.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "step-body";
  const hidden = document.createElement("span");
  hidden.className = "visually-hidden";
  const label = document.createElement("span");
  label.className = "step-label";
  body.append(hidden, label);

  item.append(mark, body);
  return item;
}

function fillStep(item: HTMLLIElement, step: Step): HTMLLIElement {
  if (item.dataset.status !== step.status) {
    item.dataset.status = step.status;
  }
  const [hidden, label] = item.querySelectorAll<HTMLElement>(".step-body > span");
  setText(hidden!, STATUS_TEXT[step.status]);
  setText(label!, step.label);

  const body = item.querySelector(".step-body")!;
  let fix = body.querySelector<HTMLElement>(".step-fix");
  if (!step.fix) {
    fix?.remove();
    return item;
  }
  if (fix?.dataset.text === step.fix) {
    return item;
  }
  fix ??= body.appendChild(document.createElement("p"));
  fix.className = "step-fix";
  fix.dataset.text = step.fix;
  // `like this` becomes <code>.
  fix.replaceChildren(
    ...step.fix.split("`").map((part, index) => {
      if (index % 2 === 0) {
        return part;
      }
      const code = document.createElement("code");
      code.textContent = part;
      return code;
    }),
  );
  return item;
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}
