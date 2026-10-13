import { defineConfig } from "vite";

// During `npm run dev`, Vite serves the UI while the relay (npm run relay)
// handles the ADB WebSocket tunnel. Proxy the relay endpoints through Vite so
// the page and the tunnel share one origin.
//
// Keep the dev server on localhost (no `vite --host`): the relay trusts
// same-origin loopback pages without a token.
const RELAY = process.env.DEXTEROUS_RELAY_URL ?? "http://127.0.0.1:8686";

export default defineConfig({
  // Relative URLs, so dist/ also works when hosted under a sub-path
  // (browser-only USB mode on any static HTTPS host).
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    // Tango ships an AudioWorklet referenced via `new URL(..., import.meta.url)`;
    // pre-bundling would break that URL.
    exclude: ["@yume-chan/pcm-player"],
  },
  server: {
    proxy: {
      // Anchored patterns, so unrelated paths like /adbx aren't proxied.
      "^/api/": { target: RELAY, secure: false },
      "^/adb$": { target: RELAY.replace(/^http/, "ws"), ws: true, secure: false },
    },
  },
});
