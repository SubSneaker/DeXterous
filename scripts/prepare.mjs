// `npm run prepare`: builds DeXterous after `npm install` in a clone, and when
// npm installs it straight from GitHub.
//
// `npm install -g github:SubSneaker/DeXterous` prepares the cloned repository
// with the *global* flag still set, so npm skips devDependencies, which hold
// every build tool (Vite, TypeScript, the scrcpy server downloader). When they
// are missing, install them into the clone first, then build.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BUILD_TOOLS = ["vite", "typescript", "@yume-chan/fetch-scrcpy-server"];

if (!BUILD_TOOLS.every(isInstalled)) {
  console.log("Installing DeXterous's build tools…");
  npm(["install", "--global=false", "--include=dev", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts"], {
    ...process.env,
    npm_config_global: "false",
  });
}
npm(["run", "build"], process.env);

function isInstalled(name) {
  try {
    require.resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function npm(args, env) {
  // Prefer the npm that is running this script; it is always set by `npm run`.
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", env })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        stdio: "inherit",
        env,
        shell: process.platform === "win32",
      });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
