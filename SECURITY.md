# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| Older | No |

Security fixes are released as new patch versions. DeXterous tells you when one is out; update with `dexterous update`, or as the [guide](docs/GUIDE.md#updating) explains for npx and source installs.

## Reporting a vulnerability

Please report vulnerabilities **privately**:

- Use GitHub's private vulnerability reporting: **[Report a vulnerability](https://github.com/SubSneaker/DeXterous/security/advisories/new)** (the *Security* tab of the repository, then *Report a vulnerability*).
- If that doesn't work for you, contact the maintainer, [@SubSneaker](https://github.com/SubSneaker), on GitHub and ask for a private channel before sharing any details.

Don't open a public issue, discussion or pull request for a vulnerability. Please include:

- the DeXterous version (`dexterous --version`) or commit,
- the connection mode (relay over USB or Wi‑Fi, `--lan`, browser-only USB) and any command-line options,
- the steps to reproduce it, and what an attacker gains,
- your operating system and browser, if relevant.

We aim to acknowledge reports within a week, and to agree on a disclosure date with you once a fix is ready. If you'd like to be credited in the advisory, say so.

Problems in scrcpy, Tango or adb themselves belong with those projects, but we're happy to hear about them if they affect DeXterous.

## Threat model

### What the relay can do

DeXterous's relay connects the browser to the computer's adb server. **Whoever can open a tunnel through the relay has full adb access to the phone**: they can run shell commands, install and remove apps, read and write shared storage, and see and control the screen. Everything below exists to make sure only you can open that tunnel.

### Defaults

- **Loopback only.** By default the relay binds to `127.0.0.1`, so only programs on the computer running DeXterous can reach it.
- **Host check (DNS rebinding).** In loopback mode, every request must name a loopback host (`localhost`, `127.0.0.1`, `[::1]`) or an explicitly allowed origin. This stops a hostile website from pointing its own domain at `127.0.0.1` and talking to the relay as if it were same-origin.
- **Origin check (cross-site WebSocket hijacking).** Browsers always send an `Origin` header on WebSocket upgrades, and pages can't forge it. The tunnel only accepts upgrades whose origin matches the relay's own address, or one passed with `--allow-origin`. Other websites open in your browser can't connect.
- **Framing blocked.** Responses carry `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`, so other sites can't embed the app to trick you into clicking.
- **No token on loopback.** On `localhost`, the relay trusts same-origin pages without a token. Any program running as any user on that computer could reach the adb server directly anyway, since adb's own server has no authentication. On a shared computer, use `--require-token`.

### LAN mode

`--lan` (or any non-loopback `--host`) makes the relay reachable from your network. It then always:

- **serves HTTPS**, with a self-signed certificate unless you supply one with `--cert`/`--key`. The startup banner prints the certificate's SHA-256 fingerprint so you can check it in the browser;
- **requires the access token** on every tunnel connection. The token is 24 random bytes (32 characters), compared in constant time. A missing or wrong token is refused before any adb connection is made.

About the token:

- It's stored in the `token` file of DeXterous's per-user state directory (`~/Library/Application Support/DeXterous` on macOS, `%APPDATA%\DeXterous` on Windows, `~/.config/dexterous` on Linux), next to the certificate's private key. On macOS and Linux the directory is owner-only (`0700`) and the files owner read/write (`0600`). Keep them private.
- It's handed to the browser in the URL fragment (`#token=…`), which browsers never send to servers. The page saves it in the site's local storage and removes it from the address bar. It then travels in the query string of the `/adb` WebSocket URL, over HTTPS.
- **Rotate it** by deleting the `token` file and restarting DeXterous. If you set your own with `DEXTEROUS_TOKEN`, use at least 16 random characters.
- Anyone with the link can control your phone. Only open it on your own devices, and don't paste it into chats or tickets.

The relay also caps open tunnels and connections, and logs rejected tunnel attempts (once per origin and reason, so a hostile page can't flood the terminal).

### The lock guard is not a security boundary

When the phone locks, DeXterous covers DeX, blocks input, mutes audio and holds back clipboard copies, and it fails closed when it can't read the lock state. The *Keep DeX usable while the phone is locked* switch can only be turned on while the phone is unlocked.

This protects against casual use of an unattended browser tab. It does **not** protect the phone from anyone who can use the adb on the computer running DeXterous, or who has your DeXterous link and token: they can control the phone directly. Lock your computer when you leave it.

### Browser-only USB mode

In WebUSB mode there's no relay. The browser generates its own adb key, stores it in the site's storage (IndexedDB), and the phone asks you to authorize it. Whoever controls the page you load controls what it does with your phone after you approve it, so only use a copy of the app you host yourself or trust. You can revoke all authorized keys on the phone with *Developer options › Revoke USB debugging authorizations*.

### Update checks and self-updates

**The check.** About once a day (when it starts, if the last check is more than a day old, and again while it runs), DeXterous sends one HTTPS request to the npm registry (`https://registry.npmjs.org/-/package/@subsneaker%2fdexterous/dist-tags`) to learn the latest version number. The request carries no version, ID, token or cookie, and nothing about your computer or phone. The registry sees your IP address, as with any request. The answer is saved in `update-check.json` in the state directory. After a failed attempt (for example, offline), the next start tries again an hour later at the earliest. Only a well-formed version number is accepted from the answer. Turn the check off with `--no-update-check` or `DEXTEROUS_NO_UPDATE_CHECK=1`. It's also off when `$CI` is set and when DeXterous runs from a clone. `DEXTEROUS_UPDATE_REGISTRY` points it at another registry, such as a company mirror; use an `https://` address there.

**Installing an update** runs `npm install -g @subsneaker/dexterous@latest` on your computer, with your own npm and its settings, into the folder the running copy was installed in. npm is told to refuse a version that needs a newer Node.js (`--engine-strict`). From the page, npm runs in the background with its output in `update.log`, and stopping DeXterous waits for it to finish. That's the same as running it yourself, but it can be started from the DeXterous page (`POST /api/update`), so the relay only accepts that request when all of these hold:

- it comes from the computer running DeXterous (a loopback address). Other devices are refused, even in `--lan` mode;
- it comes from the DeXterous page itself, opened on `localhost`, `127.0.0.1` or `[::1]`: the `Origin` header must match the relay's own address. Other websites, pages behind a reverse proxy (`--allow-origin`) and DNS-rebinding tricks are refused;
- if the relay requires the access token, the request carries it (`Authorization: Bearer …`);
- no DeX session is open, since the relay restarts afterwards.

The request takes no parameters. It can't choose a version, a package or a command: it can only install the latest `@subsneaker/dexterous`, and only when the last check found a version newer than the running one. When DeXterous can tell that npm would need administrator rights, it doesn't try, and tells you the command to run yourself. While an update installs, new connections to the phone are refused. Other devices are never offered the option.

One way around the loopback rule remains: a port forward from another machine (for example `ssh -L`) arrives from loopback. Setting one up already takes a shell on the computer running DeXterous.

**Where the package comes from.** Releases are published to npm by a GitHub Actions workflow in this repository, using npm trusted publishing: no npm token is stored anywhere, and each version it publishes carries a provenance statement that links it to the commit and the workflow run that built it. The package page on [npmjs.com](https://www.npmjs.com/package/@subsneaker/dexterous) shows the provenance of each version. `npm audit signatures` checks signatures and provenance too, but only for packages installed in a project, not global ones.

### On the phone

The build downloads the official scrcpy server v5.0.1 release from GitHub and refuses it unless its SHA-256 matches the expected value. Each connection pushes that unmodified server to `/data/local/tmp/dexterous-server.jar` and runs it with adb's shell permissions. It stops when the session ends. DeXterous doesn't need root and doesn't change system settings, except keeping the screen awake while connected, which scrcpy restores when the session ends.

## Hardening advice

- **Never expose DeXterous to the internet.** No port forwarding, no public reverse proxy. For remote access, use a private network such as Tailscale or WireGuard.
- Use LAN mode only on networks you trust, and stop it when you're done.
- Prefer a trusted certificate (`--cert`/`--key`, e.g. from mkcert or `tailscale cert`) over the self-signed one, so a certificate warning is never something you've learned to click through.
- Be careful with browser extensions that can read or change pages on `localhost` or your DeXterous address: they can use the session too.
- Turn off USB debugging when you don't use it, and revoke old authorizations now and then.

## Running behind a reverse proxy

If you put DeXterous behind a reverse proxy (`tailscale serve`, Caddy, nginx…):

- Keep DeXterous bound to `127.0.0.1` (the default) and let only the proxy reach it.
- Start it with `--allow-origin https://<your-proxy-hostname>`. This allows pages served from that origin and **turns on the token requirement**, because every proxied request comes from loopback and would otherwise be trusted.
- Terminate TLS at the proxy with a trusted certificate.
- Pass WebSocket upgrades on `/adb` through, and keep the browser's `Origin` header.
- The token travels in the `/adb` query string. Make sure the proxy doesn't log full request URLs, or rotate the token if it has.
- Don't make the proxy reachable from the internet.
