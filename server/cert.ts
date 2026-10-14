// TLS certificate handling for --lan / --https.
//
// Browsers only enable WebCodecs, WebUSB and the async clipboard API in a
// secure context, and plain http:// on a LAN IP is not one. So LAN mode serves
// HTTPS with a self-signed certificate (generated in pure JS, no openssl),
// cached in the per-user state directory (see paths.ts) and regenerated when
// it expires or when the computer gains an address the certificate does not
// cover.
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir, readOptionalFile, writePrivateFile } from "./storage.ts";

const VALIDITY_DAYS = 397; // stays under the lifetime limits Apple/Chrome enforce
const RENEW_BEFORE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  cert: string;
  key: string;
  source: "custom" | "cached" | "generated";
  /** SHA-256 fingerprint, as shown by browsers' certificate viewers. */
  fingerprint256: string;
  validTo: Date;
  /** DNS names and IP addresses in the certificate's subjectAltName. */
  dnsNames: string[];
  ipAddresses: string[];
}

export interface CertificateNames {
  dnsNames: string[];
  ipAddresses: string[];
}

/**
 * Names the self-signed certificate must cover: localhost, the computer's
 * hostname (plus its mDNS `.local` form) and every non-internal IPv4 address.
 */
export function collectCertificateNames(extraHosts: readonly string[] = []): CertificateNames {
  const dnsNames = new Set(["localhost"]);
  const ipAddresses = new Set(["127.0.0.1", "::1"]);

  const hostname = os.hostname().trim().toLowerCase();
  if (isDnsName(hostname)) {
    dnsNames.add(hostname);
    if (!hostname.includes(".")) dnsNames.add(`${hostname}.local`);
  }
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) ipAddresses.add(entry.address);
    }
  }
  for (const host of extraHosts) {
    if (net.isIP(host)) ipAddresses.add(host);
    else if (isDnsName(host.toLowerCase())) dnsNames.add(host.toLowerCase());
  }
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] };
}

/** Loads a user-provided certificate/key pair (e.g. from mkcert or Tailscale). */
export function loadCustomCertificate(certFile: string, keyFile: string): TlsMaterial {
  const cert = readRequired(certFile, "certificate");
  const key = readRequired(keyFile, "private key");
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch (error) {
    throw new Error(`${certFile} is not a valid PEM certificate: ${errorMessage(error)}`);
  }
  try {
    if (!x509.checkPrivateKey(createPrivateKey(key))) {
      throw new Error("the key does not match the certificate");
    }
  } catch (error) {
    throw new Error(`Cannot use ${keyFile} with ${certFile}: ${errorMessage(error)}`);
  }
  return describe(cert, key, x509, "custom");
}

/**
 * Returns the cached self-signed certificate from `dataDir` if it is still
 * valid and covers `names`, otherwise generates (and caches) a new one.
 */
export async function ensureSelfSignedCertificate(
  dataDir: string,
  names: CertificateNames,
): Promise<TlsMaterial> {
  const certFile = path.join(dataDir, "cert.pem");
  const keyFile = path.join(dataDir, "key.pem");

  const cached = loadCached(certFile, keyFile);
  if (cached && coversAll(cached.x509, names) && !expiresSoon(cached.x509)) {
    return describe(cached.cert, cached.key, cached.x509, "cached");
  }

  // Keep IPv4 addresses from the previous certificate (if still valid) so
  // moving between networks does not force a new certificate warning every
  // time. Bounded in case the machine roams across many networks.
  const merged = { dnsNames: [...names.dnsNames], ipAddresses: [...names.ipAddresses] };
  if (cached && cached.x509.validToDate.getTime() > Date.now()) {
    const previous = parseSubjectAltNames(cached.x509.subjectAltName);
    mergeInto(merged.ipAddresses, previous.ipAddresses.filter((ip) => net.isIPv4(ip)));
  }
  merged.ipAddresses = merged.ipAddresses.slice(0, 32);

  const { cert, key } = await generateSelfSigned(merged);
  ensurePrivateDir(dataDir);
  writePrivateFile(keyFile, key);
  writePrivateFile(certFile, cert);
  return describe(cert, key, new X509Certificate(cert), "generated");
}

async function generateSelfSigned(names: CertificateNames): Promise<{ cert: string; key: string }> {
  // Loaded lazily: only needed the first time HTTPS is used.
  const { generate } = await import("selfsigned");
  const now = Date.now();
  const commonName = `DeXterous relay on ${os.hostname()}`.slice(0, 64);
  const pems = await generate(
    [
      { name: "commonName", value: commonName },
      { name: "organizationName", value: "DeXterous (self-signed)" },
    ],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      // Backdated a day to tolerate clock skew on the client device.
      notBeforeDate: new Date(now - DAY_MS),
      notAfterDate: new Date(now + VALIDITY_DAYS * DAY_MS),
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            ...names.dnsNames.map((value) => ({ type: 2 as const, value })),
            ...names.ipAddresses.map((ip) => ({ type: 7 as const, ip })),
          ],
        },
      ],
    },
  );
  return { cert: pems.cert, key: pems.private };
}

function loadCached(
  certFile: string,
  keyFile: string,
): { cert: string; key: string; x509: X509Certificate } | undefined {
  try {
    const cert = readOptionalFile(certFile);
    const key = readOptionalFile(keyFile);
    if (!cert || !key) return undefined;
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(createPrivateKey(key))) return undefined;
    return { cert, key, x509 };
  } catch {
    // Corrupt or unreadable files: regenerate.
    return undefined;
  }
}

function coversAll(x509: X509Certificate, names: CertificateNames): boolean {
  return (
    names.dnsNames.every((name) => x509.checkHost(name, { subject: "never" }) !== undefined) &&
    names.ipAddresses.every((ip) => x509.checkIP(ip) !== undefined)
  );
}

function expiresSoon(x509: X509Certificate): boolean {
  const now = Date.now();
  return (
    x509.validFromDate.getTime() > now || x509.validToDate.getTime() - now < RENEW_BEFORE_DAYS * DAY_MS
  );
}

function describe(
  cert: string,
  key: string,
  x509: X509Certificate,
  source: TlsMaterial["source"],
): TlsMaterial {
  const names = parseSubjectAltNames(x509.subjectAltName);
  return {
    cert,
    key,
    source,
    fingerprint256: x509.fingerprint256,
    validTo: x509.validToDate,
    dnsNames: names.dnsNames,
    ipAddresses: names.ipAddresses,
  };
}

/** Parses Node's subjectAltName string, e.g. "DNS:localhost, IP Address:127.0.0.1". */
function parseSubjectAltNames(value: string | undefined): CertificateNames {
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  for (const entry of (value ?? "").split(/,\s*/)) {
    if (entry.startsWith("DNS:")) dnsNames.push(entry.slice("DNS:".length).toLowerCase());
    else if (entry.startsWith("IP Address:")) ipAddresses.push(entry.slice("IP Address:".length));
  }
  return { dnsNames, ipAddresses };
}

function mergeInto(target: string[], extra: readonly string[]): void {
  for (const value of extra) if (!target.includes(value)) target.push(value);
}

function isDnsName(value: string): boolean {
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value);
}

function readRequired(file: string, what: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the TLS ${what} at ${file}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
