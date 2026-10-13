# Changelog

All notable changes to DeXterous are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

First release.

### Added

- Samsung DeX in any browser, running on a scrcpy 5.0.1 virtual display that resizes with the window. Works on One UI 8 and newer, without root.
- An installable `dexterous` command. It starts the relay and opens your browser (`--no-open` to skip that), and `--version` prints the version. Install it from the release tarball, run it from GitHub with `npx`, or link a clone with `npm install -g .`.
- Relay mode (`dexterous`): a local Node server that tunnels the browser to the computer's adb server. It accepts only same-origin pages on localhost and blocks DNS rebinding. It starts the adb server if none is running.
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

[0.1.0]: https://github.com/SubSneaker/DeXterous/releases/tag/v0.1.0
