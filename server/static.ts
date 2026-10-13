// Static file server for the Vite build in `dist/`, with SPA fallback.
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { sendText } from "./http-utils.ts";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".jar": "application/java-archive",
};

/** Vite emits content-hashed files here, so they can be cached forever. */
const IMMUTABLE_PREFIX = "assets";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_REVALIDATE = "no-cache";

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;

export function createStaticHandler(distDir: string): StaticHandler {
  return async (req, res, pathname) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed.", { Allow: "GET, HEAD" });
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, "Malformed URL.");
      return;
    }
    // Backslashes and NUL never appear in Vite output; rejecting them avoids
    // Windows path separator tricks. Dot-segments cover traversal and hidden
    // files; ":" covers drive letters and NTFS alternate data streams.
    const segments = decoded.split("/").filter((segment) => segment !== "");
    if (
      decoded.includes("\0") ||
      decoded.includes("\\") ||
      segments.some((segment) => segment.startsWith(".") || segment.includes(":"))
    ) {
      sendText(res, 404, "Not found.");
      return;
    }

    // Checked on every request so a build made while the relay runs is
    // picked up without a restart.
    const root = await realpathOrUndefined(distDir);
    const indexFile = root === undefined ? undefined : path.join(root, "index.html");
    const indexStat = indexFile === undefined ? undefined : await statOrUndefined(indexFile);
    if (root === undefined || indexFile === undefined || !indexStat?.isFile()) {
      sendBuildMissing(req, res);
      return;
    }

    const found = await resolveFile(root, segments);
    if (found) {
      const cacheControl =
        segments[0] === IMMUTABLE_PREFIX && segments.length > 1 ? CACHE_IMMUTABLE : CACHE_REVALIDATE;
      await sendFile(req, res, found.file, found.stat, cacheControl);
      return;
    }

    // Unknown asset-looking paths are real 404s; anything else is a client
    // side route and gets the app shell.
    const last = segments.at(-1) ?? "";
    if (segments[0] === IMMUTABLE_PREFIX || path.extname(last) !== "") {
      sendText(res, 404, "Not found.");
      return;
    }
    await sendFile(req, res, indexFile, indexStat, CACHE_REVALIDATE);
  };
}

/** Maps URL segments to a regular file inside `root` (directories → index.html). */
async function resolveFile(
  root: string,
  segments: string[],
): Promise<{ file: string; stat: fs.Stats } | undefined> {
  let file = path.join(root, ...segments);
  if (!isInside(root, file)) return undefined;

  let stat = await statOrUndefined(file);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await statOrUndefined(file);
  }
  if (!stat?.isFile()) return undefined;

  // Refuse symlinks that point outside the build directory.
  const real = await realpathOrUndefined(file);
  if (!real || !isInside(root, real)) return undefined;
  return { file: real, stat };
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  stat: fs.Stats,
  cacheControl: string,
): Promise<void> {
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader("Content-Type", MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", stat.mtime.toUTCString());

  if (req.headers["if-none-match"]?.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304).end();
    return;
  }

  res.setHeader("Content-Length", stat.size);
  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return;
  }

  res.writeHead(200);
  try {
    await pipeline(fs.createReadStream(file), res);
  } catch {
    // Client went away mid-download, or the file vanished during a rebuild.
    res.destroy();
  }
}

function sendBuildMissing(req: IncomingMessage, res: ServerResponse): void {
  const wantsHtml = req.headers.accept?.includes("text/html") ?? false;
  if (!wantsHtml) {
    sendText(res, 503, "DeXterous has not been built yet. Run `npm run build`, then reload.", {
      "Retry-After": "5",
    });
    return;
  }
  // Deliberately unstyled: the relay ships no CSS of its own.
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeXterous: build required</title>
</head>
<body>
<main>
<h1>DeXterous has not been built yet</h1>
<p>The relay is running, but there is no web app in the <code>dist/</code> folder to serve.</p>
<p>In the DeXterous project folder, run:</p>
<pre><code>npm run build</code></pre>
<p>and then reload this page.</p>
</main>
</body>
</html>
`;
  res.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Retry-After": "5",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function statOrUndefined(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(file);
  } catch {
    return undefined;
  }
}

async function realpathOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(file);
  } catch {
    return undefined;
  }
}
