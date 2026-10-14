# Changelog

All notable changes to DeXterous are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-10-14

### Fixed

- *Update now* no longer says a DeX session is open when none is. The relay counted the connect screen's own short adb commands, such as reading a phone's details, as a session. Now only a DeX session that is starting or running blocks an update. If the page still gets that answer, it asks once more after a moment before showing it.
- A wrong Wi‑Fi pairing code is reported as a wrong code. adb's "Failed: Wrong password" answer was taken for success, so the form went on to connect and said the phone hadn't accepted the connection.
- Other pairing errors are no longer reported as a wrong code just because adb's message contains the word "code". A bad pairing address gets its own hint, and anything else shows adb's own message.

### Changed

- Phone cards show the name the phone has in *Settings › About phone*. Many Samsung phones have no marketing name, so their cards showed a model code like `SM-S938B`. The model code is still shown on the second line.
- *Start DeX* is greyed out, with a short note, while an update installs and while DeXterous restarts afterwards.
- The README and the user guide no longer say what has and hasn't been tested. The guide's *Using it from an iPad or another computer* section is now *Use it from another device*.
- The project site serves its own fonts instead of loading them from Google Fonts.

## [0.2.0] - 2026-10-14

### Added

- DeXterous is on npm as `@subsneaker/dexterous`. Install it with `npm install -g @subsneaker/dexterous`, or run it with `npx @subsneaker/dexterous@latest`.
- Update checks. DeXterous asks npm's registry for the latest version about once a day, and prints a line in the terminal when there's a new one. The check sends nothing about you; turn it off with `--no-update-check` or `DEXTEROUS_NO_UPDATE_CHECK=1`. It's off when `$CI` is set and when running from a clone.
- `dexterous update` installs the latest version, and `dexterous update --check` only checks. Copies run through npx or from a clone get told what to run instead.
- The relay's `/api/info` reports update details, and `POST /api/update` lets the DeXterous page install an update and restart the relay. It only works from the computer DeXterous runs on, while DeX isn't running. npm runs in the background, so stopping DeXterous mid-update waits for it to finish, and a version that needs a newer Node.js is refused.
- `dexterous` restarts the relay in the same terminal after an update.
- Release workflows: pushing a version tag publishes the package to npm with trusted publishing and provenance, and creates the GitHub release with the notes from this changelog.
- The connect screen shows an update banner when a new version is out, with a *What's new* link and either *Update now* or the command to run, with a *Copy* button.
- Phone cards on the connect screen: each phone shows its name, model code, One UI version, battery, a *USB* or *Wi‑Fi* badge and whether it's ready. Phones on One UI 7 or older, or that aren't Galaxy phones, get a warning. DeXterous remembers the phone you used last. The arrow keys move between phones and Enter starts DeX.
- *Before you start*, a live setup checklist: DeXterous running, adb reachable, phone found, USB debugging allowed, One UI 8 or newer. The first missing step says how to fix it, and the list folds up to *All set* when everything is ready.
- Picture quality presets in *Display & input*: *Best (USB)*, *Balanced (Wi‑Fi)*, *Light* and *Custom*. *Best* is the default on a first visit. On a Wi‑Fi phone, DeXterous suggests *Balanced*.
- *Add a phone over Wi‑Fi* on the connect screen: enter the phone's address, and the first time, its pairing address and 6-digit code. No need for `adb pair` and `adb connect` in a terminal (they still work).
- A footer on the connect screen with the version and links to the guide and the project site.
- A project site at https://subsneaker.github.io/DeXterous/, published from `site/` with GitHub Pages, with a copy of the browser-only app at https://subsneaker.github.io/DeXterous/app/.

### Changed

- The connect screen's phone drop-down is now a list of phone cards, and *Sharpness*, *Video codec*, *Bitrate* and *Frame rate* moved under *Picture quality › Custom*.
- CI also packs the npm package, installs it globally into a temporary folder and smoke-tests that copy.

### Removed

- Installing from the GitHub release tarball and running `npx github:SubSneaker/DeXterous` are no longer the documented ways to install. Use npm.

## [0.1.0] - 2026-10-14

First release.

### Added

- Samsung DeX in any browser, running on a scrcpy 5.0.1 virtual display that resizes with the window. Works on One UI 8 and newer, without root.
- An installable `dexterous` command. It starts the relay and opens your browser (`--no-open` to skip that), and `--version` prints the version. Install it from the release tarball, run it from GitHub with `npx`, or link a clone with `npm install -g .`.
- Relay mode (`dexterous`): a local Node server that tunnels the browser to the adb server on the computer running it. It accepts only same-origin pages on localhost and blocks DNS rebinding. It starts the adb server if none is running.
- LAN mode (`dexterous --lan`): HTTPS with a self-signed certificate plus a required access token, for using DeX from other devices. Bring your own certificate with `--cert`/`--key`, and put DeXterous behind a reverse proxy with `--allow-origin`.
- A per-user state directory for the access token and certificate (`~/Library/Application Support/DeXterous`, `%APPDATA%\DeXterous` or `~/.config/dexterous`), overridable with `DEXTEROUS_HOME`. `DEXTEROUS_TOKEN` sets a fixed token.
- Browser-only USB mode (WebUSB) for Chrome and Edge. The built app also works from any HTTPS static host, even under a sub-path.
- Hardware video decoding with WebCodecs (H.264, H.265, AV1), drawn with WebGL.
- Phone audio played in the browser, with a mute control.
- Input: mouse with hover and right-click, multi-touch, scrolling, keyboard with IME and non-ASCII text, and ⌘-as-Ctrl on Mac with right ⌘ as DeX's ⊞ key.
- Shared clipboard in both directions, or two separate clipboards.
- A lock guard: DeX is covered, input is blocked, audio is muted and clipboard copies are held back while the phone is locked, failing closed when the lock state is unknown. *Keep DeX usable while the phone is locked* turns this off (opt-in, and only while the phone is unlocked).
- The phone stays awake while connected, over USB and Wi‑Fi.
- A shortcuts and commands panel (Ctrl+Alt+/ or ⌃⌥/): lock or wake the phone, turn the phone's screen off, Back/Home/Recents, mute, full screen, stats and disconnect.
- Settings: sharpness, DeX text size, codec, bitrate, frame rate, and audio, clipboard, keyboard and disconnect options.
- Documentation: README, user guide (`docs/GUIDE.md`), contributing guide, security policy, third-party notices, and issue and pull request templates.
- Continuous integration on GitHub Actions: type-check, build and smoke test on Linux (Node 22 and 24), macOS and Windows (Node 22).

### Known limitations

- scrcpy sends left clicks as touches, so dragging across text may scroll instead of selecting.
- Shift+click and Ctrl+click arrive without the modifier.
- Typing non-ASCII text goes through the phone's clipboard.
- Browser-reserved shortcuts (⌘W, ⌘T, ⌘Q, Alt+Tab) only reach DeX in full screen in Chrome or Edge.

[Unreleased]: https://github.com/SubSneaker/DeXterous/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/SubSneaker/DeXterous/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SubSneaker/DeXterous/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SubSneaker/DeXterous/releases/tag/v0.1.0
