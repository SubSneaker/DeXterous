// Helpers for the relay's private state directory (see paths.ts), which holds
// the access token and the self-signed TLS key. Both are secrets, so the
// directory is owner-only (0700) and files are owner read/write (0600).
// On Windows the mode bits are ignored by Node; the files then inherit the
// ACL of the folder (%APPDATA% is private to the user by default; a
// DEXTEROUS_HOME override keeps whatever ACL that folder has).
import fs from "node:fs";

const isWindows = process.platform === "win32";

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);
}

export function writePrivateFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten pre-existing files.
  restrictMode(file, 0o600);
}

/** Reads a UTF-8 file, returning undefined if it does not exist. */
export function readOptionalFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Best-effort chmod so a secret created with a loose umask gets tightened. */
export function restrictMode(target: string, mode: number): void {
  if (isWindows) return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Not fatal: e.g. the directory is owned by another user.
  }
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
