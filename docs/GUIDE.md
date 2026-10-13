# DeXterous user guide

DeXterous runs Samsung DeX from your Galaxy phone or tablet in a web browser. This guide covers setting up the phone and the computer, connecting for the first time, everyday use, every setting, and what to do when something goes wrong.

For a shorter overview, see the [README](../README.md).

## Contents

- [What you need](#what-you-need)
- [Prepare the phone](#prepare-the-phone)
- [Install DeXterous](#install-dexterous)
- [Your first connection](#your-first-connection)
- [Everyday use](#everyday-use)
- [Shortcuts and the commands panel](#shortcuts-and-the-commands-panel)
- [Settings explained](#settings-explained)
- [The lock guard](#the-lock-guard)
- [Using it from an iPad or another computer](#using-it-from-an-ipad-or-another-computer)
- [Browser-only USB mode](#browser-only-usb-mode)
- [Command-line reference](#command-line-reference)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## What you need

- **A Galaxy phone or tablet on One UI 8 or newer.** DeX can only run on a virtual display from One UI 8 on. DeXterous has been tested on a Galaxy Z Fold8 with One UI 9 (Android 17). To check your version, open *Settings › About phone › Software information*.
- **A USB cable** for the first connection. After that you can switch to Wi‑Fi if you like.
- **A computer** running macOS, Windows or Linux, with:
  - **Node.js 22.18 or newer**, to run DeXterous.
  - **Android platform-tools** (`adb`), which DeXterous uses to talk to the phone.
- **A browser with WebCodecs:** Chrome, Edge, Opera, Safari 17+ or Firefox 130+. Browser-only USB mode needs Chrome or Edge.

You don't need root, and you don't install anything on the phone.

## Prepare the phone

### Turn on USB debugging

1. Open *Settings › About phone › Software information*.
2. Tap *Build number* 7 times. Enter your PIN if asked. You'll see "Developer mode has been turned on".
3. Go back to *Settings*. Near the bottom there's a new *Developer options* entry. Open it.
4. Turn on *USB debugging*.

If USB debugging won't stay on, or the phone never asks to allow your computer, check *Settings › Security and privacy › Auto Blocker*. Auto Blocker can block commands over USB; turn it off while you use DeXterous.

### Connect over Wi-Fi (optional)

USB is the smoothest connection, but DeXterous also works over Wi‑Fi. The phone and the computer must be on the same network. Do this once on the computer, after installing platform-tools (see below).

**Option A: Wireless debugging (no cable needed)**

1. On the phone, open *Developer options › Wireless debugging* and turn it on. Allow it on this network.
2. Tap *Pair device with pairing code*. The phone shows an IP address, a port and a six-digit code.
3. On the computer, run `adb pair <ip>:<pairing-port>` with those values, and type the code.
4. Back on the *Wireless debugging* screen, note the *IP address & port* (a different port from the pairing one). Run `adb connect <ip>:<port>`.
5. `adb devices` now lists the phone.

**Option B: `adb tcpip` (needs USB once)**

1. Plug the phone in over USB and run `adb tcpip 5555`.
2. Unplug it and run `adb connect <phone-ip>:5555`.

You'll find the phone's IP address in *Settings › Connections › Wi‑Fi*: tap the gear next to your network. Option B lasts until the phone restarts.

In DeXterous, Wi‑Fi phones are listed with "· Wi‑Fi" after their name, below USB ones. Lower the *Bitrate* setting to 4–8 Mbps for a smoother picture over Wi‑Fi.

## Install DeXterous

### macOS

1. Install Node.js 22.18 or newer, either from [nodejs.org](https://nodejs.org) or with Homebrew: `brew install node`.
2. Install adb: `brew install --cask android-platform-tools`.
3. Install DeXterous from the latest release (see [Install the command](#install-the-command)).

### Windows

1. Install Node.js 22.18 or newer: `winget install OpenJS.NodeJS.LTS`, or the installer from [nodejs.org](https://nodejs.org).
2. Install adb: `winget install Google.PlatformTools`.
3. Open a **new** terminal, so it picks up the updated `PATH`.
4. Install DeXterous from the latest release (see [Install the command](#install-the-command)).

If `adb devices` doesn't list the phone when it's plugged in, install Samsung's Android USB driver for Windows, from Samsung's developer site.

### Linux

1. Install Node.js 22.18 or newer. Many distributions ship an older version, so check with `node --version`. A version manager such as [nvm](https://github.com/nvm-sh/nvm) is the easiest way to get a current one.
2. Install adb from your distribution, for example:
   - Debian and Ubuntu: `sudo apt install android-tools-adb`
   - Fedora: `sudo dnf install android-tools`
   - Arch: `sudo pacman -S android-tools`

   Or download Google's [platform-tools zip](https://developer.android.com/tools/releases/platform-tools) and put its folder on your `PATH`.
3. Install DeXterous from the latest release (see [Install the command](#install-the-command)).

If `adb devices` says "no permissions", your user can't open the USB device. Install your distribution's Android udev rules (for example `android-sdk-platform-tools-common` on Debian and Ubuntu, or `android-udev` on Arch), then unplug and replug the phone.

If `npm install -g` fails with `EACCES`, npm is trying to write to a system folder. Use Node from nvm, or point npm at a folder you own: `npm config set prefix ~/.local`, and make sure `~/.local/bin` is on your `PATH`.

### Install the command

The repository is private for now, so you need access to it. Either sign in with the GitHub CLI (`gh auth login`, and answer yes when it offers to authenticate Git), or add an SSH key to your GitHub account.

Install the latest release. It comes as a ready-built npm package:

```bash
gh release download v0.1.0 -R SubSneaker/DeXterous -p '*.tgz'
npm install -g ./subsneaker-dexterous-0.1.0.tgz
```

You can also download `subsneaker-dexterous-0.1.0.tgz` from the [Releases page](https://github.com/SubSneaker/DeXterous/releases) in your browser. npm 11 may warn that `prepare: npm run build` isn't covered by `allowScripts`. That's harmless: the tarball is already built, and no script runs.

`npm install -g github:SubSneaker/DeXterous` doesn't work. npm prepares GitHub packages for global installs without their build tools, so use the release or one of the options below.

### Other ways to install

- **Run it from GitHub without installing:** `npx github:SubSneaker/DeXterous`. The first run downloads and builds it (about half a minute); later runs use npm's cache. Options go at the end, e.g. `npx github:SubSneaker/DeXterous --lan`.
- **From source:**

  ```bash
  git clone https://github.com/SubSneaker/DeXterous.git
  cd DeXterous
  npm install
  npm start
  ```

  `npm install` builds everything. The first build downloads the scrcpy server (v5.0.1) from GitHub and checks its SHA-256. `npm start` takes the same options as `dexterous`, after a `--`: `npm start -- --lan`.

### Check the installation

```bash
dexterous --version
adb devices
```

The first prints DeXterous's version. The second should list your phone once it's plugged in and authorized.

## Your first connection

1. **Start DeXterous.** Run `dexterous` in a terminal. It prints something like this, then opens the address in your browser:

   ```text
     DeXterous v0.1.0

     Open DeXterous in your browser:
       http://localhost:8686/

     adb server:  127.0.0.1:5037  reachable

     Opening it in your default browser (--no-open to skip)...

     Keep this window open while using DeXterous. Ctrl+C to stop.
   ```

   If adb isn't running yet, DeXterous starts it for you. Use `dexterous --no-open` if you'd rather open the browser yourself. DeXterous doesn't open one when there's no graphical display, for example over SSH.
2. **Plug the phone in and unlock it.** The phone asks *Allow USB debugging?* and shows your computer's key fingerprint. Tick *Always allow from this computer* and tap *Allow*. Until you do, the phone is listed with "tap “Allow” on your phone".
3. **Pick the phone** under *Connect your phone › Through this computer*. The list updates by itself when phones come and go; the refresh button next to it forces an update.
4. **Check the settings** (optional). Open *Display & input* to change sharpness, text size, codec and more. See [Settings explained](#settings-explained).
5. **Click Start DeX.** DeXterous pushes the scrcpy server to the phone, starts it, and waits for the first frame. This takes a few seconds. *Cancel* stops it at any point.
6. **Unlock the phone** if DeXterous shows *Your phone is locked*. DeX appears as soon as the phone is unlocked.

The dock flashes briefly at the top of the window to show where it lives, and a tip reminds you of the shortcut for the commands panel.

If you connect something other than a Galaxy phone, or a Galaxy on One UI 7 or older, DeXterous tells you what to expect: Android's own desktop, if the phone has one, or a basic launcher.

## Everyday use

### The desktop

DeX runs on a virtual monitor that belongs to the browser tab. Open apps from the taskbar or the app drawer, drag windows by their title bars, resize them from the edges, and snap them with ⊞+← and ⊞+→. Your phone's own screen keeps working as usual, and apps can move between the two.

Resizing the browser window resizes the DeX desktop to match (after a short pause, so dragging the window edge stays smooth). The virtual display is capped at 3840 × 2160, which is about the limit of phone video encoders.

### Keyboard

Everything you type goes to DeX, except DeXterous's own Ctrl+Alt shortcuts.

- **On a Mac**, *Use ⌘ as Ctrl* is on by default: the left ⌘ acts as Ctrl, so ⌘C, ⌘V, ⌘A, ⌘Z and friends do what you expect. The right ⌘ stays DeX's ⊞ key, for ⊞+D, ⊞+arrows and ⊞+/. With the setting off, both ⌘ keys act as ⊞. Option types special characters (@, €, brackets) as it does on the Mac.
- **On Windows and Linux**, the Windows key is DeX's ⊞ key. Your operating system usually keeps it for itself (the Start menu), except in full screen in Chrome or Edge. AltGr types characters as usual and never triggers a DeXterous shortcut.
- **Non-English text** (Hebrew, Cyrillic, accented letters, emoji) and **IME input** (Chinese, Japanese, Korean) are pasted into DeX through the phone's clipboard. That replaces whatever you had copied on the phone. Plain English letters, digits and symbols are typed directly.
- **Media and volume keys** work. The power key is deliberately ignored, because it would put the phone to sleep.

### Mouse and trackpad

- The pointer is a real mouse pointer: hover effects, tooltips and right-click context menus all work. Middle-click works too, and the side buttons act as Back and Forward.
- The wheel scrolls. Hold Shift to scroll sideways. Ctrl+wheel and trackpad pinches don't zoom the browser page.
- **Known limitation:** scrcpy sends left clicks and drags as touches. Dragging across text in some apps scrolls instead of selecting; double-click or long-press to select instead. Shift+click and Ctrl+click arrive without the modifier.

### Touch screens

Multi-touch works, including pinch and two-finger gestures. Tapping doesn't pop up your device's on-screen keyboard; tap the ⌄ handle in the top-right corner to show the controls, then the keyboard button when you want to type. To use Android's own keyboard on the DeX screen instead, turn on *Show the Android on-screen keyboard*.

### Clipboard

*Share the clipboard with this computer* decides whether there is one clipboard or two.

- **On (default):** one shared clipboard. Anything you copy in DeX lands on your computer's clipboard, and ⌘V / Ctrl+V in DeX pastes your computer's clipboard.
- **Off:** two separate clipboards. Copies in DeX stay on the phone, and ⌘V / Ctrl+V pastes the phone's own clipboard.

You can switch it mid-session in the shortcuts panel. Some details:

- Safari only lets pages write to the clipboard right after you click or press a key, so a copy from DeX reaches your Mac on your next click or key press. Until it has, ⌘V pastes the phone's copy, so pasting inside DeX still works.
- While the lock screen covers DeX, nothing is copied to the computer. The most recent copy arrives once you unlock the phone.

### Audio

With *Play phone audio here* on, the phone's audio plays in the browser tab and the phone's speaker goes quiet. Turn on *Keep audio on the phone too* (Android 13+) to hear it on both.

- Mute and unmute with the dock's speaker button or Ctrl+Alt+M.
- Audio is also muted whenever the lock screen covers DeX, including the *Checking your phone…* screen at the start of a session.
- If a desktop `scrcpy` is running with audio at the same time, you'll hear everything twice, slightly out of sync. Start scrcpy with `--no-audio`, or turn off *Play phone audio here*.
- If the phone can't capture audio, DeXterous says so and carries on without it.

### Full screen

Ctrl+Alt+F, or the full-screen button in the dock. In Chrome and Edge, full screen also captures Esc, the ⌘ / Windows key and browser shortcuts such as Alt+Tab and ⌘W, so they reach DeX. **Hold Esc** to leave full screen. In other browsers, full screen works but those keys stay with the browser.

### The phone's own screen

Ctrl+Alt+P turns the phone's own screen off while DeX keeps running, to save power or keep the phone dark on your desk. Press it again to turn the screen back on. This is different from locking the phone (Ctrl+Alt+L).

### Connection stats

Ctrl+Alt+S shows the virtual display's resolution and DPI, frames per second, whether decoding is in hardware or software, skipped frames and the audio state.

### Disconnecting

Press Ctrl+Alt+Q, click the disconnect button at the right end of the dock, or close the tab. Your open apps move back to the phone, like unplugging a DeX monitor (unless you turned off *Move open apps to the phone on disconnect*). Stopping DeXterous in the terminal (Ctrl+C) also ends the session. When the session ends, the phone's normal screen timeout applies again.

## Shortcuts and the commands panel

Open the panel with **Ctrl+Alt+/** (⌃⌥/ on a Mac) or the **?** button in the dock. Close it with Esc. Every command in it is also a button, so you can click instead of typing.

### DeXterous commands

| Shortcut | Command |
|---|---|
| Ctrl+Alt+L | Lock phone |
| Ctrl+Alt+W | Wake phone screen |
| Ctrl+Alt+P | Turn phone screen off (DeX keeps running), or back on |
| Ctrl+Alt+B | Back |
| Ctrl+Alt+H | Home |
| Ctrl+Alt+R | Recent apps |
| Ctrl+Alt+M | Mute or unmute phone audio |
| Ctrl+Alt+F | Full screen |
| Ctrl+Alt+S | Connection stats |
| Ctrl+Alt+/ | Show or hide the panel |
| Ctrl+Alt+Q | Disconnect |

On a Mac these are ⌃⌥ plus the key. Holding a shortcut doesn't repeat it. Some systems reserve a few of these combinations: Ctrl+Alt+L locks the screen on many Linux desktops, and ChromeOS uses Ctrl+Alt+/. Those then never reach DeXterous; use the dock or the panel instead.

### Quick toggles

The panel's *Keyboard & security* section has live switches for *Use ⌘ as Ctrl* (Mac only), *Keep DeX usable while the phone is locked* and *Share the clipboard with this computer*. Changes apply immediately and are remembered.

### DeX shortcuts

These belong to DeX itself and can vary between One UI versions. ⊞ is the right ⌘ on a Mac (or either ⌘ with *Use ⌘ as Ctrl* off) and the Windows key elsewhere.

| Shortcut | Does |
|---|---|
| ⊞+/ | Show all DeX shortcuts (on your phone's list) |
| ⊞+← / ⊞+→ | Snap a window left or right |
| ⊞+D | Show the desktop |
| Alt+Tab | Switch apps (in full screen) |
| Alt+F4 | Close the window |
| ⌘V / Ctrl+V | Paste (from this computer when the clipboard is shared) |

### The dock

Move the mouse to the top edge of the window to show the dock. On a touch screen, tap the ⌄ handle in the top-right corner. From left to right: Back, Home, Recent apps, show keyboard, mute, lock phone, full screen, the shortcuts panel (?) and disconnect. Turning the phone's own screen off and the connection stats are in the panel.

## Settings explained

The settings live in *Display & input* on the connect screen. Your browser remembers them for this address, so another browser or device has its own. Most take effect the next time you click **Start DeX**.

| Setting | Options | What it does |
|---|---|---|
| Sharpness | Retina (2×), Balanced (1.5×), Fast (1×) | How many virtual display pixels DeX gets per browser pixel. Retina is crisp on HiDPI screens; Fast is lightest on the phone and the network. The default matches your screen. Large windows are capped so the display stays within 3840 × 2160. |
| DeX text size | Small, Default, Large, Larger | Scales DeX's UI by setting the virtual display's DPI. |
| Video codec | H.264, H.265, AV1 | H.264 is the most compatible. H.265 is sharper at the same bitrate in Chrome and Safari. AV1 needs a recent phone. Codecs this browser can't decode are greyed out, and DeXterous falls back to H.264 if needed. |
| Bitrate | 4, 8, 16 (default), 24 Mbps | Higher is sharper but needs more bandwidth. Use 4–8 Mbps over Wi‑Fi and 24 over USB. |
| Frame rate | 30, 60 (default), 120 fps | The maximum frame rate. |
| Play phone audio here | on by default | Sends the phone's audio to the browser. |
| Keep audio on the phone too | off by default | Also keeps playing it on the phone (Android 13+). |
| Share the clipboard with this computer | on by default | One shared clipboard, or two separate ones. See [Clipboard](#clipboard). Can be changed mid-session. |
| Use ⌘ as Ctrl | on by default, Mac only | Left ⌘ acts as Ctrl; right ⌘ stays DeX's ⊞ key. Can be changed mid-session. |
| Show the Android on-screen keyboard | off by default | Shows Android's keyboard on the DeX screen when a text field is focused. |
| Move open apps to the phone on disconnect | on by default | When off, apps open on DeX are closed when you disconnect. |
| Keep DeX usable while the phone is locked | off by default | See [The lock guard](#the-lock-guard). Can be changed mid-session, but only switched on while the phone is unlocked. |

## The lock guard

DeX keeps running on the virtual display even when the phone itself is locked. So by default, DeXterous follows the phone's lock state and protects the desktop for you.

### What it does

While the phone is locked or asleep, DeXterous:

- covers the DeX desktop with a lock screen,
- ignores all keyboard, mouse and touch input,
- mutes the phone's audio,
- holds back anything copied on the phone until you unlock it.

The lock screen says *Your phone is locked* or *Your phone is asleep*. When the phone is asleep, *Wake phone screen* turns its screen on, so you can unlock it with your face, fingerprint or PIN. You always unlock on the phone itself; there's no way to unlock it from the browser.

### It fails closed

DeXterous reads the lock state about once a second. When it can't tell (while the session is starting, if the check stops answering for a few seconds, or if the answer is garbled), it shows *Checking your phone…* and keeps DeX covered.

Uncovering works like a latch. Once DeX is covered, only seeing the phone awake **and** unlocked uncovers it. Changing a setting can't.

### Keep DeX usable while the phone is locked

Turn this on if you'd rather not unlock the phone every time, for example when the phone sits next to you and locks itself. With it on, DeX stays usable when the phone locks, and *Lock phone* just locks the phone ("Phone locked. DeX stays usable.").

You can only switch it on while the phone is unlocked and DeX is visible. While the lock screen is up, the switch is greyed out ("Unlock your phone first"). That way nobody at the computer can use the switch to get past a locked phone. Switching it off works at any time.

Some phones still pause DeX when their screen goes fully off, even with this setting on. Press Ctrl+Alt+W to wake the phone.

### Security notes

The lock guard is a convenience, not a security boundary. It stops someone from using DeX in your browser while your phone is locked in your pocket. It doesn't stop anyone who can use this computer's adb (or open your DeXterous link with its token) from controlling the phone in other ways. Lock your computer when you walk away, and see [SECURITY.md](../SECURITY.md) for the full picture.

### Why the phone stays awake

While DeXterous is connected, it keeps the phone awake: over USB the screen stays on while plugged in, and over Wi‑Fi DeXterous reports activity on the DeX display. Without this, the phone would time out its screen and lock in the middle of your work, and the lock guard would cover DeX.

The phone only locks when you lock it: with the side key, Ctrl+Alt+L, or the lock button in the dock. When you disconnect, the phone's normal screen timeout applies again.

## Using it from an iPad or another computer

The phone stays plugged into one computer, which runs DeXterous. Other devices on the same network open DeX in their browser.

### Start in LAN mode

```bash
dexterous --lan
```

In LAN mode, DeXterous:

- listens on all network interfaces, not only `localhost`,
- serves HTTPS, because browsers only allow video decoding and clipboard access on secure pages, using a self-signed certificate it creates for this computer's addresses,
- requires an access token, so other people on your network can't connect.

It prints one link per network address, like `https://192.168.1.20:8686/#token=…`, plus a `localhost` link for the computer itself, and the certificate's SHA-256 fingerprint.

Running a non-loopback `--host`, such as `--host 192.168.1.20`, turns on LAN mode too.

### Open the link and accept the certificate

1. Open the printed link on the other device. The `#token=…` part matters: without it, the page loads but can't connect. Sending the link to yourself is easier than typing it.
2. The browser warns that the certificate isn't trusted, because DeXterous made it itself. Choose *Advanced*, then *Proceed* (or *Accept the risk*, or *Visit this website*). Each browser asks once. To be sure it's really your computer, compare the fingerprint in the browser's certificate details with the one DeXterous printed.
3. Connect as usual.

The browser remembers the token after the first visit and removes it from the address bar. The token stays the same across restarts, so a bookmark keeps working. If you open `http://` instead of `https://`, DeXterous redirects you.

### The access token

- The token is stored in the `token` file in DeXterous's [state directory](#files-and-the-state-directory).
- **To rotate it**, delete that file and restart DeXterous. Every device then needs the new link; the old token shows *Invalid access token*.
- **To choose your own**, set `DEXTEROUS_TOKEN` to at least 16 random characters.
- Anyone with the link can control your phone. Only open it on your own devices.

### Firewall

Other devices can only connect if the computer's firewall lets them in.

- **macOS:** *System Settings › Network › Firewall › Options*: *Block all incoming connections* must be off. If macOS asks whether `node` may accept incoming connections, allow it. DeXterous warns you at startup when the firewall blocks everything.
- **Windows:** when Windows Defender Firewall asks about Node.js, allow it on *Private networks*, and make sure your network is set to *Private*.
- **Linux:** open the port if you run a firewall, e.g. `sudo ufw allow 8686/tcp`.

### Safari, iPad and trusted certificates

Safari, and every browser on iPad and iPhone, may load the page with a self-signed certificate but then refuse the live connection to the phone. The fix is a certificate the device trusts. Two ways:

**mkcert** (a local certificate authority)

1. Install [mkcert](https://github.com/FiloSottile/mkcert) on the computer and run `mkcert -install`.
2. Create a certificate for the computer's name and IP address, e.g. `mkcert my-mac.local 192.168.1.20`. This writes `my-mac.local+1.pem` and `my-mac.local+1-key.pem`.
3. Start DeXterous with it: `dexterous --lan --cert my-mac.local+1.pem --key my-mac.local+1-key.pem`.
4. On the iPad, trust mkcert's root certificate: send `rootCA.pem` from the folder `mkcert -CAROOT` prints (AirDrop works), install it in *Settings › General › VPN & Device Management*, then turn on full trust in *Settings › General › About › Certificate Trust Settings*.

**Tailscale** (if both devices are on your tailnet)

1. Run `tailscale cert <machine>.<tailnet>.ts.net` on the computer. It writes a `.crt` and a `.key` file for that name.
2. Start DeXterous with them: `dexterous --lan --cert <machine>.<tailnet>.ts.net.crt --key <machine>.<tailnet>.ts.net.key`.
3. Open `https://<machine>.<tailnet>.ts.net:8686/#token=…` on the iPad. DeXterous prints the link with the certificate's name.

With your own certificate, DeXterous skips the self-signed one and prints links for the names in your certificate.

### Behind a reverse proxy

If you put DeXterous behind a reverse proxy (`tailscale serve`, Caddy, nginx…), keep DeXterous on `127.0.0.1` and tell it the proxy's public origin:

```bash
dexterous --allow-origin https://my-pc.example.ts.net
```

That also turns on the token requirement, because proxied requests look local. The proxy must pass WebSocket upgrades on `/adb` through and keep the browser's `Origin` header. See [SECURITY.md](../SECURITY.md#running-behind-a-reverse-proxy) before you do this.

## Browser-only USB mode

In this mode the browser talks to the phone directly over USB (WebUSB). There's no relay and no adb on the computer. It works in Chrome and Edge, on a secure page (`https://`, or `http://localhost`).

### Getting the page

The web app is a static site, so any HTTPS host can serve it, even under a sub-path:

- **From source:** `npm run build`, then upload the `dist/` folder.
- **From an installed copy:** the built app is in DeXterous's package folder, `$(npm root -g)/@subsneaker/dexterous/dist`.

Only use a copy you host yourself or trust: whoever controls the page controls what it does with your phone once you approve it.

You can also use the *USB, browser only* tab on the page `dexterous` serves, as long as the computer's adb server isn't running.

### Connecting

1. **Free the phone.** Only one program can use the phone's USB debugging interface at a time. Run `adb kill-server`, and quit Android Studio, scrcpy and any other adb tools.
2. Open the page and choose the **USB, browser only** tab.
3. Click **Add phone…** and pick your phone in the browser's USB dialog. The browser remembers it for next time.
4. Click **Start DeX**. The phone asks *Allow USB debugging?* again, this time for the browser's own key. Tick *Always allow* and tap *Allow*.

The browser keeps its adb key in the site's storage. If you clear the site's data, the phone asks again. Browser-only USB mode hasn't been verified on a device yet; if the browser can't open the phone, use relay mode.

## Command-line reference

```text
dexterous [options]
npm start -- [options]      (from source)
```

### Options

| Option | Default | What it does |
|---|---|---|
| `-p, --port <n>` | `8686`, or `$PORT` | Port to listen on. |
| `--host <addr>` | `127.0.0.1` (`0.0.0.0` with `--lan`) | Address to bind. A non-loopback address implies `--lan`. |
| `--lan` | off | Let other devices on your network connect: binds all interfaces, serves HTTPS with a self-signed certificate and requires the access token. |
| `--https` | off | Serve HTTPS on localhost too. |
| `--cert <file>` | | TLS certificate (PEM) to use instead of the self-signed one, e.g. from mkcert or `tailscale cert`. Needs `--key`. |
| `--key <file>` | | Private key (PEM) for `--cert`. |
| `--adb <host:port>` | `127.0.0.1:5037`, or `$ADB_SERVER_SOCKET` / `$ANDROID_ADB_SERVER_PORT` | adb server address. If no server is running on the default address, DeXterous starts one with `adb start-server`. DeXterous never stops or restarts an adb server. |
| `--allow-origin <url>` | | Also accept connections from pages on this origin, e.g. a reverse proxy such as `https://my-pc.example.ts.net`. Repeatable. Implies `--require-token`. |
| `--require-token` | off (on with `--lan`) | Require the access token on localhost too. |
| `--dist <dir>` | the package's built app | Directory containing the built web app. |
| `--no-open` | | Don't open the browser on start. It isn't opened anyway when `$CI` is set, when the output isn't a terminal, or on Linux without a graphical display. |
| `-v, --verbose` | | Log every tunnel connection. |
| `-V, --version` | | Print the version and exit. |
| `-h, --help` | | Show the help and exit. |

### Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | Default for `--port`. |
| `ADB_SERVER_SOCKET` | adb server address in adb's own format, e.g. `tcp:127.0.0.1:5037`. Only `tcp:` addresses are supported. |
| `ANDROID_ADB_SERVER_PORT` | adb server port on 127.0.0.1. |
| `DEXTEROUS_TOKEN` | Use this access token instead of the generated one. Use at least 16 random characters. |
| `DEXTEROUS_HOME` | Directory for DeXterous's state files, instead of the default. |

### Files and the state directory

DeXterous creates these files on first use. They're secrets: keep them private.

| File | Contents |
|---|---|
| `token` | The access token, also used in the `#token=…` link. Delete it to rotate the token. |
| `cert.pem` | The self-signed certificate for `--lan` and `--https`. |
| `key.pem` | Its private key. |

The self-signed certificate covers `localhost`, the computer's name and its network addresses. DeXterous renews it before it expires and whenever the computer gets an address it doesn't cover. Delete both files to force a new one.

| OS | State directory |
|---|---|
| macOS | `~/Library/Application Support/DeXterous` |
| Windows | `%APPDATA%\DeXterous` |
| Linux | `~/.config/dexterous`, or `$XDG_CONFIG_HOME/dexterous` |

Set `DEXTEROUS_HOME` to use another directory.

## Updating and uninstalling

### Updating

- **Release tarball:** download the new release's tarball (`gh release download <tag> -R SubSneaker/DeXterous -p '*.tgz'`) and install it the same way.
- **npx:** npx can keep running the copy it cached earlier. To get a specific release, name it: `npx github:SubSneaker/DeXterous#v0.1.0`.
- **From source:** `git pull`, then `npm install`.

Run `dexterous --version` to check which version you have. Your settings, token and certificate are kept.

### Uninstalling

1. Remove the command: `npm uninstall -g @subsneaker/dexterous`.
2. Delete the [state directory](#files-and-the-state-directory) to remove the token and certificate.
3. In your browser, clear the site data for `localhost:8686` (and any LAN address you used) to remove saved settings and the remembered token.
4. On the phone, optionally:
   - remove the scrcpy server file: `adb shell rm /data/local/tmp/dexterous-server.jar`,
   - revoke the computer's access in *Developer options › Revoke USB debugging authorizations*,
   - turn off *USB debugging*, or *Developer options* altogether.
5. If you installed mkcert's root certificate only for DeXterous, remove it with `mkcert -uninstall` (and from your iPad's profiles).

## Troubleshooting

### Installing and starting

- **`gh release download` or `npx github:…` fails with an authentication or Git error:** you can't reach the private repository yet. Run `gh auth login` and let it set up Git, or add an SSH key to GitHub, then try again.
- **`npm install -g github:SubSneaker/DeXterous` installs a broken command:** that install method doesn't work (npm prepares GitHub packages for global installs without their build tools). Remove it with `npm uninstall -g @subsneaker/dexterous` and install the release tarball instead.
- **`dexterous: command not found`:** npm's global folder isn't on your `PATH`. `npm prefix -g` shows where it is; the command lives in its `bin` folder on macOS and Linux, and in the folder itself on Windows. On Windows, open a new terminal after installing.
- **"Port 8686 is already in use":** another DeXterous (or something else) is using the port. Stop it, or start with `--port 8787`.
- **The browser didn't open:** open the link DeXterous printed. DeXterous doesn't open a browser when `$CI` is set, when its output isn't a terminal, or on Linux without a graphical display.
- **"The relay can't reach adb" / "adb server: not reachable":** install Android platform-tools, make sure `adb` is on your `PATH`, then restart DeXterous.

### Connecting

- **No phone in the list:** unlock the phone, check that USB debugging is on, and run `adb devices`. If the phone shows as `unauthorized`, tap *Allow* on it. Try another cable or port; some cables only charge.
- **The phone never asks to allow USB debugging:** in *Developer options*, tap *Revoke USB debugging authorizations*, then replug. Check that *Auto Blocker* isn't blocking USB commands.
- **"This relay needs an access token":** open the full link with `#token=…` that DeXterous printed.
- **"Invalid access token":** the token changed. Open the new link.
- **"Couldn't reach DeXterous on your computer. Is it still running?":** the terminal running DeXterous was closed or stopped. Start it again and reload the page.
- **Other devices can't connect in LAN mode:** check the [firewall](#firewall). Make sure both devices are on the same network, and that the link uses an address of the computer on that network.
- **Safari or iPad loads the page, but connecting fails:** use a [trusted certificate](#safari-ipad-and-trusted-certificates).
- **"The phone refused to create a virtual display":** the phone is on One UI 7 or older. DeX on a virtual display needs One UI 8.
- **WebUSB says another program is using the phone:** run `adb kill-server`, quit other adb tools, or use relay mode.

### While using DeX

- **"Your phone is locked" / "Your phone is asleep" / "Checking your phone…":** unlock the phone (*Wake phone screen* turns its screen on first). To skip this in future, turn on *Keep DeX usable while the phone is locked* while the phone is unlocked.
- **"Waiting for the picture…":** the phone may be locked or busy. Unlock it and wait a few seconds.
- **Frozen desktop with *Keep DeX usable while the phone is locked* on:** some phones still pause DeX when their screen goes fully off. Press Ctrl+Alt+W to wake the phone.
- **Choppy over Wi‑Fi:** lower *Bitrate* to 4–8 Mbps and *Sharpness* to Balanced or Fast. USB is always smoothest.
- **Video codec greyed out, or "The browser couldn't decode the video":** this browser can't decode that codec. Use H.264, which works everywhere.
- **Text is too big or too small:** change *DeX text size*, then disconnect and start again.
- **Audio plays twice, slightly out of sync:** a desktop `scrcpy` is also forwarding audio. Run it with `--no-audio`.
- **No sound:** check *Play phone audio here*, the dock's mute button and the browser tab's own mute. Audio stays muted while the lock screen is up.
- **A shortcut does nothing:** your system may reserve it (Ctrl+Alt+L on many Linux desktops, Ctrl+Alt+/ on ChromeOS). Use the dock or the panel.
- **Esc, ⌘W or Alt+Tab go to the browser instead of DeX:** enter full screen in Chrome or Edge (Ctrl+Alt+F).
- **Dragging across text scrolls instead of selecting:** a known limitation. Double-click or long-press to select.

### Collecting details for a bug report

- Open the app with `?debug` added to the address, e.g. `http://localhost:8686/?debug`, then open the browser's developer console. The scrcpy server's log appears there at the *Verbose* / *Debug* level, prefixed with `[scrcpy]`.
- Run DeXterous with `-v` to log every connection in the terminal.
- Include your phone model, One UI and Android versions, the connection mode, your browser and operating system, and `dexterous --version`.

## FAQ

**Can I use it with a Pixel or another Android phone?**
No. DeX is Samsung's. DeXterous can still connect to other Android phones, but you'll only get Android's own desktop mode, if the phone has one, and that isn't tested or supported.

**Does it work on One UI 7 or older?**
No. Running DeX on a virtual display needs One UI 8 or newer. Older versions show a plain launcher or refuse to create the display.

**Does it need root?**
No. It uses adb, the same debugging connection Android Studio uses, and the scrcpy server, which runs with adb's normal permissions.

**Do I need to install an app on the phone?**
No. Each time you connect, DeXterous copies the scrcpy server to `/data/local/tmp/dexterous-server.jar` and starts it. It stops when you disconnect.

**Can I use the phone while DeX is running?**
Yes. DeX runs on its own virtual display, so the phone's screen works as usual.

**Why does the phone stay awake?**
So DeX doesn't doze off or lock in the middle of your work. Lock the phone yourself when you're done: side key, Ctrl+Alt+L or the dock. See [Why the phone stays awake](#why-the-phone-stays-awake).

**I hear everything twice.**
A desktop `scrcpy` is also forwarding audio. Start it with `--no-audio`, or turn off *Play phone audio here* in DeXterous.

**Can I keep using the desktop scrcpy app at the same time?**
Yes. DeXterous uses its own file name on the phone, so the two don't get in each other's way. Just turn off audio in one of them.

**Does DeXterous send anything to the internet?**
No. Everything runs on your computer and your phone, and there's no telemetry. Only installing (from GitHub) and the first build (which downloads the scrcpy server) need the internet.

**Can I use it over the internet, away from home?**
Don't expose DeXterous to the internet. Use a private network such as Tailscale or WireGuard instead, ideally with a [trusted certificate](#safari-ipad-and-trusted-certificates).

**Does it work with a Galaxy Tab?**
It should, if the tablet runs One UI 8 or newer. So far it has only been tested on a Galaxy Z Fold8.

**Is this Samsung DeX for PC?**
No. Samsung discontinued those apps. DeXterous is an independent, unofficial project that runs the DeX already built into your phone.

---

DeXterous is not affiliated with or endorsed by Samsung. "Samsung", "Galaxy" and "DeX" are trademarks of Samsung Electronics.
