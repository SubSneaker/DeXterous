# Contributing to DeXterous

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

- **Bugs and ideas:** open an issue with one of the [templates](https://github.com/SubSneaker/DeXterous/issues/new/choose).
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first, so we can agree on the approach before you spend time on it.

## Development setup

You need:

- **Node.js 22.18 or newer** (`.nvmrc` pins the major version).
- **Android platform-tools** (`adb`).
- **A Galaxy phone or tablet on One UI 8 or newer** with USB debugging on, to test anything beyond the build. See the [user guide](docs/GUIDE.md#prepare-the-phone).

```bash
git clone https://github.com/SubSneaker/DeXterous.git
cd DeXterous
npm install        # installs dependencies and builds everything
npm start          # starts DeXterous and opens http://localhost:8686
```

The first build downloads the scrcpy server (v5.0.1) from GitHub into `public/` and checks its SHA-256.

There are two ways the relay runs. `npm run relay` runs it straight from the TypeScript in `server/`, using Node's built-in type stripping. The `dexterous` command and `npm start` run the compiled copy in `build/server/`, because Node won't strip types from files inside `node_modules`, where an installed copy lives. So after changing `src/` or `server/`, run `npm run build` before `npm start`.

### The development loop

Run the relay and the Vite dev server side by side:

```bash
npm run relay      # terminal 1: the relay on :8686, from the TypeScript source
npm run dev        # terminal 2: Vite with hot reload
```

Open the address Vite prints (usually http://localhost:5173). Vite proxies `/adb` and `/api` to the relay on port 8686; set `DEXTEROUS_RELAY_URL` if your relay runs elsewhere. Keep the dev server on `localhost` (no `vite --host`): the relay trusts same-origin loopback pages without a token.

Changes to `server/` need a relay restart. Pass relay options after `--`, e.g. `npm run relay -- -v --port 8787`. `npm run relay` never opens a browser.

### Scripts

| Script | What it does |
|---|---|
| `npm start` | Start DeXterous from the last build (same as the `dexterous` command). Options go after `--`. |
| `npm run start:lan` | Same, with `--lan`. |
| `npm run build` | Download the scrcpy server if it's missing (SHA-256 checked), type-check and build the web app into `dist/`, and compile the relay into `build/server/`. `npm install` runs it through `prepare`. |
| `npm run dev` | Vite dev server with hot reload, proxying to a relay on 8686. |
| `npm run relay` | Run the relay from the TypeScript source, without opening a browser. |
| `node scripts/smoke-test.mjs` | Start the built relay, check that it serves the app and the scrcpy server, and stop it. |
| `npm run typecheck` | Type-check the web app (`tsconfig.json`) and the relay (`tsconfig.server.json`). |

CI runs on GitHub Actions (Linux with Node 22 and 24, macOS and Windows with Node 22): install and build, type-check, `dexterous --version` and `--help`, the smoke test, a dry run of `npm pack`, and the smoke test again on the packed package installed globally into a temporary folder. Run at least `npm run typecheck`, `npm run build` and the smoke test before you push.

## Architecture

```text
browser tab ──WebSocket──▶ relay (server/) ──TCP──▶ adb server ──USB/Wi-Fi──▶ phone: scrcpy server + DeX
     └──────────────────────────── WebUSB (browser-only mode) ────────────────────────────▶ phone
```

All ADB and scrcpy logic runs in the browser, using [Tango](https://github.com/yume-chan/ya-webadb). The relay only serves the app and copies bytes between WebSockets and the adb server. It never parses adb traffic.

### Web app (`src/`, `index.html`)

| File | Role |
|---|---|
| `index.html` | All markup: the connect screen, the session view, the dock, the lock screen and the shortcuts panel. |
| `src/main.ts` | The UI controller: connect screen, session lifecycle, dock and panel commands, the `SHORTCUTS` map, the lock guard, clipboard hand-off, full screen and stats. |
| `src/lib/device-list.ts` | The phone cards on the connect screen, as a keyboard-friendly radio group. |
| `src/lib/phone-info.ts` | Reads a phone's name, model, One UI version and battery with one adb shell command. |
| `src/lib/checklist.ts` | The *Before you start* checklist: which setup step is done, and the fix for the first one that isn't. |
| `src/lib/presets.ts` | The picture quality presets (*Best*, *Balanced*, *Light*) and matching saved settings to them. |
| `src/lib/wireless-form.ts` | *Add a phone over Wi‑Fi*: address checks, pairing and connecting, and readable errors. |
| `src/lib/update-banner.ts` | The update banner: follows `/api/info`, calls `POST /api/update` and waits for the relay to come back. |
| `src/lib/storage.ts` | `localStorage` helpers that never throw. |
| `src/lib/dex-session.ts` | One DeX session: pushes the scrcpy server, starts it with the virtual display options (`new_display`, `flex_display`, `vd_destroy_content`), runs the video decoder, audio and clipboard streams, watches the phone's lock state and sends phone commands (wake, lock, screen power). |
| `src/lib/input.ts` | Turns DOM pointer, wheel, keyboard, IME and paste events into scrcpy control messages. Tracks held keys, buttons and touches so nothing stays stuck on the phone. |
| `src/lib/keymap.ts` | Pure keyboard helpers: DOM codes to Android key codes, meta state, ⌘-as-Ctrl, the Ctrl+Alt app chord, paste detection and platform detection. |
| `src/lib/transports.ts` | The relay transport (adb server through the relay) and the WebUSB transport, plus device lists and the access token. |
| `src/lib/ws-connector.ts` | Tango's server connector over the relay's WebSocket, with flow control and readable messages for the relay's close codes. |
| `src/lib/settings.ts` | Setting defaults, persistence in `localStorage` and binding to the settings forms. |
| `src/lib/types.ts` | Shared types. |
| `src/styles.css` | All styling. |

### Relay (`server/`, `bin/`)

| File | Role |
|---|---|
| `bin/dexterous.js` | The `dexterous` command: checks the Node version and runs the compiled relay as a child process. When the relay exits with code 75 after an update, it starts it again in the same terminal. Passes Ctrl+C on over an IPC channel. Plain JavaScript. |
| `server/relay.ts` | Entry point: HTTP(S) server, routes (`/api/info`, `/api/update`, `/adb`, static files), startup banner and shutdown. |
| `server/options.ts` | Command-line parsing and the `--help` text. |
| `server/paths.ts` | Finds the package's own files and the per-user state directory. |
| `server/open.ts` | Opens the app in the default browser, unless `--no-open` or there's no display. |
| `server/security.ts` | Host, Origin and token checks (including the stricter ones for `/api/update`), and token storage. |
| `server/update.ts` | Update checks against the npm registry, how this copy was installed, `dexterous update`, and installing an update for `/api/update`. |
| `server/tunnel.ts` | The WebSocket-to-TCP byte tunnel to the adb server, with backpressure and heartbeats. |
| `server/adb.ts` | Finds the adb executable and starts the adb server if nothing is listening. |
| `server/cert.ts` | Self-signed and user-supplied TLS certificates. |
| `server/static.ts` | Serves the built app. |
| `server/network.ts`, `storage.ts`, `http-utils.ts`, `log.ts` | Address helpers, private state files, security headers and logging. |

### Other folders

| Folder | Contents |
|---|---|
| `public/` | Static files copied into the build as they are: the favicon, plus the scrcpy server and its license, downloaded at build time. |
| `scripts/` | `fetch-server.mjs` (downloads and verifies the scrcpy server) and `smoke-test.mjs`. |
| `build/` | The compiled relay. Generated by `npm run build`; don't edit it. |
| `docs/` | The user guide, and the connect screen screenshot used by the README. |
| `site/` | The project site (plain HTML, CSS and JavaScript), published to GitHub Pages by `.github/workflows/pages.yml` together with a build of the web app under `/app/`. Not part of the npm package. |

## Coding rules

- **TypeScript, strict.** Both `tsconfig` files use `strict`, `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax`: use `import type` for types. Avoid `any`; if a cast is unavoidable, say why in a comment.
- **No CSS-in-JS and no inline styles. Ever.** No `style="…"` attributes in HTML, no `element.style.…`, no `setAttribute("style", …)`, no style objects in TypeScript. Change state with classes, `data-*` attributes (`data-view`, `data-ready`, `data-dock`, `data-tone`…), `hidden` and ARIA attributes, and style those in `src/styles.css`. Pull requests that set styles from code won't be merged.
- **Keep the relay dependency-light.** Server code uses Node's built-ins plus `ws` and `selfsigned`. Adding a runtime dependency needs a good reason in the pull request.
- **Erasable TypeScript only in `server/`.** `npm run relay` runs it on Node's type stripping, so `erasableSyntaxOnly` is on: no `enum`, `namespace` or constructor parameter properties, and relative imports keep their `.ts` extension. `bin/` and `scripts/` are plain JavaScript.
- **Fail closed.** Anything to do with the lock guard, the token or the Host and Origin checks must deny when in doubt. Never weaken those checks; explain any change to them in the pull request.
- **Accessible UI.** Use real buttons and labels, keep focus on the keyboard input during a session, and use live regions for status text.
- **Plain, friendly copy.** Sentence case, short sentences, no jargon in the UI. "DeXterous" is this app; "DeX" is Samsung's desktop.
- **Formatting** follows `.editorconfig`: two spaces, LF line endings, a final newline.

## Testing on a device

There's no substitute for a real phone. Before you open a pull request that touches the session, input or relay:

1. Run `npm start` (or the dev loop) and connect a Galaxy phone on One UI 8+.
2. Add `?debug` to the address (e.g. `http://localhost:8686/?debug`). This exposes the live session as `window.dex` in the console: `dex.session`, `dex.input`, `dex.adb`, `dex.phoneState`, `dex.locked` and so on. The scrcpy server's log appears in the console at the *Verbose* / *Debug* level, prefixed with `[scrcpy]`.
3. Run the relay with `-v` to log every tunnel.
4. Exercise what you changed, plus the basics: start, resize the window, type, click, scroll, copy and paste both ways, lock and unlock the phone (side key and Ctrl+Alt+L), disconnect and reconnect.
5. After disconnecting, check that the phone cleaned up: `adb shell ps -A -o PID,ARGS | grep -i scrcpy` (macOS and Linux) should show no scrcpy server, and your apps should be back on the phone (or closed, depending on the setting).

If you can, also try Wi‑Fi adb, `--lan` from another device, browser-only USB mode, and Safari or Firefox. Say in the pull request what you tested, on which phone and One UI version.

## Pull requests

Before you open one:

- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] Tested on a device (model and One UI version in the description), or explained why not.
- [ ] No inline styles or CSS-in-JS.
- [ ] Docs updated if behaviour, options or UI copy changed: `README.md`, `docs/GUIDE.md`, the shortcuts panel in `index.html`.
- [ ] A line added to `CHANGELOG.md` under `## [Unreleased]` (create the heading if it's missing).
- [ ] One topic per pull request.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are suggested:

```text
feat(input): forward mouse side buttons as Back and Forward
fix(relay): refuse tunnels while shutting down
docs: explain mkcert setup for iPad
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Useful scopes: `session`, `input`, `ui`, `relay`, `cli`, `docs`.

## Releasing

DeXterous is published to npm as [`@subsneaker/dexterous`](https://www.npmjs.com/package/@subsneaker/dexterous) by the [publish workflow](.github/workflows/publish.yml), which runs when a version tag is pushed. It uses npm trusted publishing, so there's no npm token to keep anywhere, and npm adds a provenance statement to each version. The same tag also starts the [release workflow](.github/workflows/release.yml), which creates the GitHub release with that version's section of `CHANGELOG.md` as the notes. The two run independently, so one failing doesn't stop the other.

To release version `X.Y.Z`:

1. Set the version in `package.json` and `package-lock.json`: `npm version X.Y.Z --no-git-tag-version`.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - <date>`, start a new empty `## [Unreleased]` above it, and update the links at the bottom.
3. Commit, and push to `main`. Wait for CI to pass.
4. Tag that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Watch *Actions › Publish to npm*. It checks that the tag matches `package.json`, builds, type-checks, smoke-tests the build and the packed package, and publishes. A version that's already on npm is tested but not published again.
6. Watch *Actions › GitHub release*. It checks the tag the same way and creates the release, marked as a prerelease for versions like `1.2.0-rc.1`. It fails if `CHANGELOG.md` has no section for the version, and leaves a release that already exists alone.

A prerelease version such as `1.2.0-rc.1` is published under npm's `next` tag, so `npm install -g @subsneaker/dexterous` and the update check keep offering the last full release. You can also start either workflow by hand: open it under *Actions* (*Publish to npm* or *GitHub release*), click *Run workflow* and choose the tag under *Use workflow from*. They refuse to run from a branch.

### The first publish

npm only lets you add a trusted publisher to a package that already exists, so the very first version is published by hand:

1. Sign in to npm as the owner of the `@subsneaker` scope, with two-factor authentication on: `npm login`.
2. In a clean checkout of the release commit: `npm ci`, then `npm publish --access public`. `prepare` builds everything first.
3. Push the release tag as usual. The workflow sees that this version is already on npm and doesn't publish it again.

The README and the guide tell people to install from npm, so publish before (or together with) pushing docs that say so.

### The trusted publisher

The trusted publisher is set up once on npmjs.com, in the package's *Settings › Trusted publishing*: GitHub Actions, user `SubSneaker`, repository `DeXterous`, workflow `publish.yml`, no environment, with *npm publish* allowed. npm drops a new trusted publisher setting that isn't used within two days, so add it shortly before a release. With npm 11.15 or newer you can also add it from a terminal: `npm trust github @subsneaker/dexterous --file publish.yml --repo SubSneaker/DeXterous --allow-publish`. Afterwards, in the package's *Settings › Publishing access*, choose *Require two-factor authentication and disallow tokens*.

### Trying out updates locally

The relay doesn't check for updates when it runs from a clone. To try the update flow, pack the package (`npm pack`), install it into a temporary folder (`npm install -g --prefix /tmp/dx ./subsneaker-dexterous-X.Y.Z.tgz`) and run `/tmp/dx/bin/dexterous -v`. To make an update appear, serve a fake registry and point both npm and DeXterous at it with `npm_config_registry`, `npm_config_prefix` and `DEXTEROUS_UPDATE_REGISTRY`. Never test against your real global install.

## License

DeXterous is MIT-licensed. By contributing, you agree that your contributions are released under the same [license](LICENSE).
