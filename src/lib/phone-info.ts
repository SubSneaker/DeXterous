import type { AdbServerClient } from "@yume-chan/adb";
import { ConcatStringStream, TextDecoderStream } from "@yume-chan/stream-extra";

/** One UI 8.0 is the first version whose DeX can run on a virtual display. */
export const MIN_ONE_UI = 80000;

export interface PhoneDetails {
  /**
   * The name the owner gave the phone ("Dana's Fold"), else its marketing name
   * ("Galaxy S25 Ultra"), else the model code.
   */
  name: string;
  /** Model code, e.g. "SM-S938B". */
  model: string;
  manufacturer: string;
  /** e.g. 90000 for One UI 9; undefined when the phone has no One UI. */
  oneUi: number | undefined;
  /** 0 to 100; undefined when the phone didn't say. */
  battery: number | undefined;
  charging: boolean;
}

/**
 * One light shell command: the phone's name from *Settings › About phone*,
 * four properties and the battery state. Every line is `key=value`, except
 * the battery lines. Samsung phones often have no `ro.product.marketname`,
 * so the name the owner sees on the phone is the better label.
 */
const DETAILS_COMMAND =
  'echo "device_name=$(settings get global device_name 2>/dev/null)"; ' +
  "for p in ro.product.marketname ro.product.model ro.product.manufacturer ro.build.version.oneui; do " +
  'echo "$p=$(getprop $p)"; done; ' +
  "dumpsys battery | grep -E '^ *(level|status):'";

/** Reads a few facts about a phone through the relay's adb tunnel. Rejects on any failure. */
export async function readPhoneDetails(
  client: AdbServerClient,
  transportId: bigint,
  timeoutMs = 8000,
): Promise<PhoneDetails> {
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), timeoutMs);
  try {
    const socket = await client.createDeviceConnection({ transportId }, `shell:${DETAILS_COMMAND}`, {
      signal: abort.signal,
    });
    // The timeout above only covers opening the connection; closing the socket ends a stalled read.
    const onAbort = () => {
      try {
        void Promise.resolve(socket.close()).catch(() => {});
      } catch {
        // Already closed.
      }
    };
    abort.signal.addEventListener("abort", onAbort);
    try {
      const output = await socket.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new ConcatStringStream());
      if (abort.signal.aborted) {
        throw new Error("The phone took too long to answer.");
      }
      return parseDetails(output);
    } finally {
      try {
        await socket.close();
      } catch {
        // Already closed.
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

export function parseDetails(output: string): PhoneDetails {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([\w.]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match) {
      values.set(match[1]!, match[2]!);
    }
  }
  const model = values.get("ro.product.model") ?? "";
  // `settings get` prints "null" for a setting that was never set.
  const deviceName = values.get("device_name");
  const oneUi = Number.parseInt(values.get("ro.build.version.oneui") ?? "", 10);
  const battery = Number.parseInt(values.get("level") ?? "", 10);
  // `dumpsys battery` status: 2 = charging, 5 = full (still plugged in).
  const status = values.get("status");
  return {
    name: (deviceName !== "null" && deviceName) || values.get("ro.product.marketname") || model || "Phone",
    model,
    manufacturer: values.get("ro.product.manufacturer") ?? "",
    oneUi: Number.isFinite(oneUi) && oneUi > 0 ? oneUi : undefined,
    battery: Number.isFinite(battery) ? Math.min(100, Math.max(0, battery)) : undefined,
    charging: status === "2" || status === "5",
  };
}

/** 90000 -> "One UI 9", 80100 -> "One UI 8.1", 60101 -> "One UI 6.1.1". */
export function formatOneUi(version: number): string {
  const major = Math.floor(version / 10000);
  const minor = Math.floor((version % 10000) / 100);
  const patch = version % 100;
  return `One UI ${major}${minor || patch ? `.${minor}` : ""}${patch ? `.${patch}` : ""}`;
}
