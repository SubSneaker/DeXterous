import { Adb, AdbServerClient, adbDaemonAuthenticate } from "@yume-chan/adb";
import { AdbWebCryptoCredentialManager, TangoIndexedDbStorage } from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";

import type { DeviceChoice } from "./types";
import { WebSocketServerConnector } from "./ws-connector";

// #region Relay

export interface RelayInfo {
  relay: true;
  version: string;
  adbReachable: boolean;
  tokenRequired: boolean;
}

const TOKEN_KEY = "dexterous:relay-token";

/** Reads `#token=…` from the URL (LAN mode) and remembers it for next time. */
export function readRelayToken(): string | undefined {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get("token");
  if (fromHash) {
    try {
      localStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      // Storage may be unavailable (private mode); the token still works for this visit.
    }
    // Keep the secret out of screenshots and the history list.
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Returns relay details when this page is served by the DeXterous relay. */
export async function probeRelay(): Promise<RelayInfo | undefined> {
  try {
    const response = await fetch("/api/info", { cache: "no-store" });
    if (!response.ok) {
      return undefined;
    }
    const info = (await response.json()) as Partial<RelayInfo>;
    return info.relay === true ? (info as RelayInfo) : undefined;
  } catch {
    return undefined;
  }
}

export class RelayTransport {
  readonly client: AdbServerClient;

  constructor(token: string | undefined) {
    const url = new URL("/adb", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.hash = "";
    if (token) {
      url.searchParams.set("token", token);
    }
    this.client = new AdbServerClient(new WebSocketServerConnector(url.href));
  }

  async listDevices(): Promise<DeviceChoice[]> {
    const devices = await this.client.getDevices(["device", "unauthorized", "authorizing"]);
    return devices
      .map((device): DeviceChoice => {
        const wireless = isWirelessSerial(device.serial);
        const model = (device.model ?? device.product ?? device.serial).replaceAll("_", "-");
        const state =
          device.state === "device" ? "" : " · tap “Allow” on your phone";
        return {
          kind: "relay",
          id: `relay:${device.transportId}`,
          label: `${model} · ${wireless ? "Wi‑Fi" : "USB"}${state}`,
          serial: device.serial,
          transportId: device.transportId,
          handle: device.state,
        };
      })
      .sort((a, b) => Number(isWirelessSerial(a.serial)) - Number(isWirelessSerial(b.serial)));
  }

  async connect(choice: DeviceChoice): Promise<Adb> {
    if (choice.handle !== "device") {
      throw new Error("Unlock your phone and allow USB debugging for this computer, then refresh.");
    }
    if (choice.transportId === undefined) {
      throw new Error("Pick a phone first.");
    }
    return this.client.createAdb({ transportId: choice.transportId });
  }
}

function isWirelessSerial(serial: string): boolean {
  return serial.includes(":") || serial.includes("._adb-tls-");
}

// #endregion

// #region WebUSB

export function webUsbSupport(): { supported: true } | { supported: false; reason: string } {
  if (!window.isSecureContext) {
    return { supported: false, reason: "USB needs a secure (https or localhost) page." };
  }
  if (!AdbDaemonWebUsbDeviceManager.BROWSER) {
    return { supported: false, reason: "This browser has no WebUSB. Use Chrome, Edge or another Chromium browser." };
  }
  return { supported: true };
}

function toChoice(device: AdbDaemonWebUsbDevice): DeviceChoice {
  return {
    kind: "webusb",
    id: `webusb:${device.serial}`,
    label: `${device.name || device.serial} · USB (browser)`,
    serial: device.serial,
    handle: device,
  };
}

/** Phones this site was already allowed to use. */
export async function listWebUsbDevices(): Promise<DeviceChoice[]> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    return [];
  }
  return (await manager.getDevices()).map(toChoice);
}

/** Shows the browser's USB device picker. */
export async function requestWebUsbDevice(): Promise<DeviceChoice | undefined> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    return undefined;
  }
  const device = await manager.requestDevice();
  return device ? toChoice(device) : undefined;
}

let credentialManager: AdbWebCryptoCredentialManager | undefined;

export async function connectWebUsb(
  choice: DeviceChoice,
  onWaitingForApproval: () => void,
): Promise<Adb> {
  const device = choice.handle;
  if (!(device instanceof AdbDaemonWebUsbDevice)) {
    throw new Error("Pick a phone first.");
  }

  let connection;
  try {
    connection = await device.connect();
  } catch (error) {
    if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
      throw new Error(
        "Another program on this computer is using the phone (usually the adb server). " +
          "Stop it (`adb kill-server`) or use relay mode instead.",
      );
    }
    throw error;
  }

  credentialManager ??= new AdbWebCryptoCredentialManager(new TangoIndexedDbStorage(), "DeXterous");
  const transport = await adbDaemonAuthenticate({
    serial: device.serial,
    connection,
    credentialManager,
    onPublicKeyAuthentication: onWaitingForApproval,
  });
  return new Adb(transport);
}

// #endregion
