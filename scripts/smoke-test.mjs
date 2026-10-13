// Smoke test for the packaged relay, used by CI (and handy locally):
//
//   node scripts/smoke-test.mjs [--port 8686] [--bin path/to/dexterous.js]
//
// Starts `node bin/dexterous.js --no-open --port <port>`, waits for
// /api/info to answer, checks that the app and the scrcpy server are served,
// then stops the relay. No phone is needed: /api/info just reports whether
// an adb server is reachable. Exits non-zero on failure, including when the
// port is already taken (so another running relay can't make it pass).
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8686" },
    bin: { type: "string", default: path.join(root, "bin", "dexterous.js") },
    timeout: { type: "string", default: "60" },
  },
});
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + Number(values.timeout) * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

if (!(await isPortFree(port))) {
  console.error(`Smoke test failed: port ${port} is already in use. Stop whatever runs there or pass --port.`);
  process.exit(1);
}

const relay = spawn(process.execPath, [values.bin, "--no-open", "--port", String(port)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, CI: process.env.CI ?? "1" },
});
let exited = false;
let stopping = false;
relay.once("exit", (code, signal) => {
  exited = true;
  if (!stopping) void fail(`The relay exited early (code ${code}, signal ${signal}).`);
});

try {
  const info = await waitForInfo();
  console.log(`/api/info: ${JSON.stringify(info)}`);
  check(info.relay === true, "/api/info should report relay: true");
  check(typeof info.version === "string" && info.version !== "0.0.0", "/api/info should report the package version");
  check(typeof info.adbReachable === "boolean", "/api/info should report adbReachable");

  const page = await get("/");
  const html = Buffer.from(page.body).toString("utf8");
  check(page.response.ok, `GET / returned ${page.response.status}`);
  check(/<html/i.test(html), "GET / should return the app's index.html");
  console.log(`GET /: ${page.response.status}, ${page.body.byteLength} bytes`);

  const jar = await get("/scrcpy-server.jar");
  check(jar.response.ok, `GET /scrcpy-server.jar returned ${jar.response.status}`);
  check(
    jar.response.headers.get("content-type") === "application/java-archive",
    "scrcpy-server.jar has the wrong Content-Type",
  );
  check(jar.body.byteLength > 100_000, `scrcpy-server.jar is only ${jar.body.byteLength} bytes`);
  console.log(`GET /scrcpy-server.jar: ${jar.response.status}, ${jar.body.byteLength} bytes`);

  check(!exited, "the relay exited during the test");
  console.log("Smoke test passed.");
  await stop();
  process.exit(0);
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}

async function waitForInfo() {
  for (;;) {
    if (exited) throw new Error("the relay exited before answering");
    try {
      const response = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${base}/api/info did not answer within ${values.timeout}s.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { response, body: await response.arrayBuffer() };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Stops the relay (SIGTERM; on Windows this terminates it). */
async function stop() {
  stopping = true;
  if (exited) return;
  const gone = new Promise((resolve) => relay.once("exit", resolve));
  relay.kill("SIGTERM");
  const timer = setTimeout(() => relay.kill("SIGKILL"), 5000);
  await gone;
  clearTimeout(timer);
}

async function fail(message) {
  console.error(`Smoke test failed: ${message}`);
  await stop();
  process.exit(1);
}
