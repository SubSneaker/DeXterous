#!/usr/bin/env node
// The `dexterous` command: starts the DeXterous relay (see `dexterous --help`).
//
// Runs the relay compiled by `npm run build` (build/server/relay.js), not the
// TypeScript sources: Node refuses to strip types from files inside
// node_modules, which is where an installed copy lives. Plain JavaScript only,
// and nothing here may depend on the current working directory.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`DeXterous needs Node.js 22.18 or newer (this is ${process.version}).`);
  process.exit(1);
}

const relay = new URL("../build/server/relay.js", import.meta.url);
if (!existsSync(fileURLToPath(relay))) {
  console.error("DeXterous isn't built yet. Reinstall it, or run `npm run build` in a clone of the repository.");
  process.exit(1);
}

await import(relay.href);
