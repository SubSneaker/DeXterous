// Small address helpers shared by the CLI parser, the security checks, the
// certificate generator and the startup banner.
import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";

export interface HostPort {
  host: string;
  port: number;
}

/** Parses a TCP port number (1-65535). */
export function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Parses `host:port`, `[ipv6]:port` or a bare `port` (which uses
 * `defaultHost`). Returns undefined for anything else.
 */
export function parseHostPort(value: string, defaultHost: string): HostPort | undefined {
  const text = value.trim();

  const bracketed = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(text);
  if (bracketed) {
    const port = parsePort(bracketed[2]);
    return port && net.isIPv6(bracketed[1]) ? { host: bracketed[1], port } : undefined;
  }

  if (/^\d+$/.test(text)) {
    const port = parsePort(text);
    return port ? { host: defaultHost, port } : undefined;
  }

  const colon = text.lastIndexOf(":");
  // Exactly one colon; unbracketed IPv6 literals are ambiguous and rejected.
  if (colon <= 0 || text.indexOf(":") !== colon) return undefined;
  const host = text.slice(0, colon);
  const port = parsePort(text.slice(colon + 1));
  if (!port || !/^[A-Za-z0-9.-]+$/.test(host)) return undefined;
  return { host, port };
}

/** Formats a host for use in a URL authority (brackets IPv6 literals). */
export function formatHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** True for addresses that are only reachable from this machine. */
export function isLoopbackAddress(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (value === "localhost") return true;
  if (net.isIPv4(value)) return value.startsWith("127.");
  if (net.isIPv6(value)) {
    if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
    // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped !== null && mapped[1].startsWith("127.");
  }
  return false;
}

/** True for wildcard bind addresses (all interfaces). */
export function isWildcardAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * Non-internal IPv4 addresses of this machine (Wi-Fi, Ethernet, VPNs such as
 * Tailscale...). With `includeLinkLocal: false`, 169.254.x.x self-assigned
 * addresses are skipped since they are rarely what the user wants to open.
 */
export function listLanIPv4Addresses(options: { includeLinkLocal: boolean }): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!options.includeLinkLocal && entry.address.startsWith("169.254.")) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses];
}

/**
 * On macOS, detects the application firewall's "Block all incoming
 * connections" mode, which silently drops LAN clients. Resolves false on
 * other platforms or if the state cannot be read. Read-only.
 */
export function isMacFirewallBlockingAll(): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "/usr/libexec/ApplicationFirewall/socketfilterfw",
      ["--getglobalstate"],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => resolve(!error && /State = 2\b/.test(stdout)),
    );
  });
}
