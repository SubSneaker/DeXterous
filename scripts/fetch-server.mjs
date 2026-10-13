// First step of `npm run build`: makes sure public/scrcpy-server.jar is the
// scrcpy server the app is written for, so Vite copies it into dist/ (the
// browser pushes it to the phone, in both relay and WebUSB mode).
//
// The jar is identified by its SHA-256, so the network is only used when it is
// missing or wrong. Downloads go through Tango's `fetch-scrcpy-server` (a
// devDependency), which saves the official release from GitHub as
// node_modules/@yume-chan/fetch-scrcpy-server/server.bin; the result is
// checked against the same SHA-256 before it is used. scrcpy's license, which
// must ship with the jar, is the upstream v5.0.1 LICENSE kept in licenses/.
//
// It also empties build/server/ so the relay compile that follows can't leave
// stale JavaScript behind from a deleted source file.
//
// To move to another scrcpy release, update VERSION and SHA256 here and
// SCRCPY_SERVER_VERSION in src/lib/dex-session.ts together.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "5.0.1";
const SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
const RELEASE_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jar = path.join(root, "public", "scrcpy-server.jar");
const license = path.join(root, "public", "scrcpy-server.LICENSE.txt");
const upstreamLicense = path.join(root, "licenses", "scrcpy-server-LICENSE.txt");
const relative = (file) => path.relative(root, file).split(path.sep).join("/");

const downloaderDir = findDownloader();
const downloaded = downloaderDir && path.join(downloaderDir, "server.bin");

mkdirSync(path.dirname(jar), { recursive: true });
rmSync(path.join(root, "build", "server"), { recursive: true, force: true });

if (sha256(jar) === SHA256) {
  console.log(`scrcpy server v${VERSION} is already in ${relative(jar)} (SHA-256 verified); not downloading it.`);
} else {
  if (!downloaderDir) {
    fail(
      "The @yume-chan/fetch-scrcpy-server package is missing, so the scrcpy server cannot be downloaded.",
      "Run `npm install` (with devDependencies) in the DeXterous folder first.",
    );
  }
  if (sha256(downloaded) !== SHA256) {
    // Run the downloader's own CLI with this Node, no shell needed.
    const result = spawnSync(process.execPath, [path.join(downloaderDir, "bin", "fetch-server.js"), VERSION], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0 || !existsSync(downloaded)) {
      fail(
        `Could not download scrcpy server v${VERSION} from GitHub (are you offline?).`,
        "Connect to the internet and run `npm run build` again, or download",
        `  ${RELEASE_URL}`,
        `yourself, save it as ${relative(jar)} and run \`npm run build\` again.`,
      );
    }
    if (sha256(downloaded) !== SHA256) {
      fail(
        `The downloaded scrcpy server does not match the expected SHA-256 for v${VERSION}`,
        `(${SHA256}). Not using it. Try again later, or download`,
        `  ${RELEASE_URL}`,
        `yourself, check its SHA-256 and save it as ${relative(jar)}.`,
      );
    }
  }
  copyFileSync(downloaded, jar);
  console.log(`Saved scrcpy server v${VERSION} as ${relative(jar)}.`);
}

if (!existsSync(upstreamLicense)) {
  fail(`${relative(upstreamLicense)} is missing (scrcpy's license must ship with the server).`);
}
if (!sameContents(upstreamLicense, license)) {
  copyFileSync(upstreamLicense, license);
  console.log(`Saved scrcpy's license as ${relative(license)}.`);
}

function findDownloader() {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@yume-chan/fetch-scrcpy-server/package.json"));
  } catch {
    return undefined;
  }
}

function sha256(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

function sameContents(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function fail(...lines) {
  console.error(`\nerror: ${lines.join("\n")}\n`);
  process.exit(1);
}
