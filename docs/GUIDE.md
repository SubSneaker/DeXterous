# DeXterous user guide

DeXterous runs Samsung DeX from your Galaxy phone or tablet in a web browser. This guide covers setting up the phone and the computer, connecting for the first time, everyday use, every setting, and what to do when something goes wrong.

For a shorter overview, see the [README](../README.md) or the [project site](https://subsneaker.github.io/DeXterous/).

## Contents

- [What you need](#what-you-need)
- [Prepare the phone](#prepare-the-phone)
- [Install DeXterous](#install-dexterous)
- [Your first connection](#your-first-connection)
- [Connect over Wi-Fi](#connect-over-wi-fi)
- [Everyday use](#everyday-use)
- [Shortcuts and the commands panel](#shortcuts-and-the-commands-panel)
- [Settings explained](#settings-explained)
- [The lock guard](#the-lock-guard)
- [Use it from another device](#use-it-from-another-device)
- [Browser-only USB mode](#browser-only-usb-mode)
- [Command-line reference](#command-line-reference)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## What you need

- **A Galaxy phone or tablet on One UI 8 or newer.** DeX can only run on a virtual display from One UI 8 on. To check your version, open *Settings › About phone › Software information*.
- **A USB cable**, the easiest and smoothest way to connect. Wi‑Fi works too, with or without a cable for the first connection (see [Connect over Wi-Fi](#connect-over-wi-fi)).
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

## Install DeXterous

### macOS

1. Install Node.js 22.18 or newer, either from [nodejs.org](https://nodejs.org) or with Homebrew: `brew install node`.
2. Install adb: `brew install --cask android-platform-tools`.
3. Install DeXterous (see [Install the command](#install-the-command)).

### Windows

1. Install Node.js 22.18 or newer: `winget install OpenJS.NodeJS.LTS`, or the installer from [nodejs.org](https://nodejs.org).
2. Install adb: `winget install Google.PlatformTools`.
3. Open a **new** terminal, so it picks up the updated `PATH`.
4. Install DeXterous (see [Install the command](#install-the-command)).

If `adb devices` doesn't list the phone when it's plugged in, install Samsung's Android USB driver for Windows, from Samsung's developer site.

### Linux

1. Install Node.js 22.18 or newer. Many distributions ship an older version, so check with `node --version`. A version manager such as [nvm](https://github.com/nvm-sh/nvm) is the easiest way to get a current one.
2. Install adb from your distribution, for example:
   - Debian and Ubuntu: `sudo apt install android-tools-adb`
   - Fedora: `sudo dnf install android-tools`
   - Arch: `sudo pacman -S android-tools`

   Or download Google's [platform-tools zip](https://developer.android.com/tools/releases/platform-tools) and put its folder on your `PATH`.
3. Install DeXterous (see [Install the command](#install-the-command)).

If `adb devices` says "no permissions", your user can't open the USB device. Install your distribution's Android udev rules (for example `android-sdk-platform-tools-common` on Debian and Ubuntu, or `android-udev` on Arch), then unplug and replug the phone.

If `npm install -g` fails with `EACCES`, npm is trying to write to a system folder. Use Node from nvm, or point npm at a folder you own: `npm config set prefix ~/.local`, and make sure `~/.local/bin` is on your `PATH`. Installing with `sudo npm install -g` works too, but then DeXterous can't update itself, and you'll need `sudo` for every update.

### Install the command

DeXterous is on npm. This installs the `dexterous` command:

```bash
npm install -g @subsneaker/dexterous
```

It comes ready-built, so nothing gets compiled on your computer.

### Other ways to install

- **Run it without installing:** `npx @subsneaker/dexterous@latest`. The first run downloads it; later runs check for a newer version and use npm's cache otherwise. Options go at the end, e.g. `npx @subsneaker/dexterous@latest --lan`.
- **From source:**

  ```bash
  git clone https://github.com/SubSneaker/DeXterous.git
  cd DeXterous
  npm install
  npm start
  ```

  `npm install` builds everything. The first build downloads the scrcpy server (v5.0.1) from GitHub and checks its SHA-256. `npm start` takes the same options as `dexterous`, after a `--`: `npm start -- --lan`. To also get the `dexterous` command, run `npm install -g .` in that folder. It links the command to the clone, so keep the folder.

### Check the installation

```bash
dexterous --version
adb devices
```

The first prints DeXterous's version. The second should list your phone once it's plugged in and authorized.

## Your first connection

1. **Start DeXterous.** Run `dexterous` in a terminal. It prints something like this, then opens the address in your browser:

   ```text
     DeXterous v0.2.2

     Open DeXterous in your browser:
       http://localhost:8686/

     adb server:  127.0.0.1:5037  reachable

     Opening it in your default browser (--no-open to skip)...

     Keep this window open while using DeXterous. Ctrl+C to stop.
   ```

   If adb isn't running yet, DeXterous starts it for you. Use `dexterous --no-open` if you'd rather open the browser yourself. DeXterous doesn't open one when there's no graphical display, for example over SSH.
2. **Plug the phone in and unlock it.** The phone asks *Allow USB debugging?* and shows your computer's key fingerprint. Tick *Always allow from this computer* (that's the phone's own wording, and it means your computer) and tap *Allow*. Until you do, the phone's card says *Tap Allow on your phone*.
3. **Pick the phone** under *Connect your phone › Through DeXterous › Your phone*. Each phone gets a card with its name, model code, One UI version, battery level and a *USB* or *Wi‑Fi* badge. The name is the one set in *Settings › About phone*; the model code (like `SM-S938B`) is shown below it. *Ready* means you can start. The list updates by itself when phones come and go; the refresh button next to it forces an update. With the keyboard, the arrow keys move between phones and Enter starts DeX. Next time, DeXterous selects the phone you used last.
4. **Check the settings** (optional). Open *Display & input* to choose the picture quality or change text size, audio and more. The default, *Best (USB)*, is meant for a cable. See [Settings explained](#settings-explained).
5. **Click Start DeX.** DeXterous pushes the scrcpy server to the phone, starts it, and waits for the first frame. This takes a few seconds. *Cancel* stops it at any point.
6. **Unlock the phone** if DeXterous shows *Your phone is locked*. DeX appears as soon as the phone is unlocked.

The dock flashes briefly at the top of the window to show where it lives, and a tip reminds you of the shortcut for the commands panel.

### Before you start: the setup checklist

Below the connect card, *Before you start* checks your setup as you go:

1. DeXterous is running
2. DeXterous can talk to adb
3. Phone found
4. USB debugging allowed
5. One UI 8 or newer

Each step gets a tick when it's done. The first step that isn't done shows what to do about it. When everything is ready, the list folds up and says *All set*; click it to open it again. If DeXterous can't read the phone's One UI version, that step is left unchecked and doesn't hold you up. In *USB, browser only* mode the list is shorter: whether this browser can use USB, and whether you've added a phone.

### Theme, Animations and help

At the top right of the connect screen, the first control sets the colour theme: *System* follows your device, or pick *Light* or *Dark*. The *Animations* switch turns the connect screen's motion on or off; with it off, the dock in a session also appears without sliding. It starts off if your device is set to reduce motion. Your browser remembers both. The session view is always dark.

The *Project site* link sits under the name. *Help*, below the checklist, links to sections of this guide, and the shortcuts panel has a short *Help* row too. These links open in a new tab.

### If your phone isn't supported

A phone card warns you with *needs One UI 8+* (a Galaxy on One UI 7 or older) or *not a Galaxy*. You can still try: you'll get Android's own desktop, if the phone has one, or a basic launcher. Update a Galaxy in *Settings › Software update*.

## Connect over Wi-Fi

USB is the smoothest connection, but DeXterous also works over Wi‑Fi. The phone and the computer must be on the same network. Wi‑Fi phones get a *Wi‑Fi* badge on their card and are listed below USB ones.

### From the connect screen

1. On the phone, open *Settings › Developer options › Wireless debugging* and turn it on. Allow it on this network.
2. On the connect screen, under *Through DeXterous*, open *Add a phone over Wi‑Fi*.
3. Enter the phone's address: the *IP address & port* shown on the *Wireless debugging* screen, like `192.168.1.20:37215`.
4. **The first time you pair this phone**, open *First time pairing this phone?* too. On the phone, tap *Pair device with pairing code*. It shows a pairing address (with a different port) and a 6-digit code. Enter both, and keep that window open on the phone until it works.
5. Click **Connect** (or **Pair and connect** the first time). The phone appears in the list and is selected.

Pairing is only needed once per computer. After that, the phone address is enough, but the port changes each time *Wireless debugging* is turned on, so check it on the phone.

If you pick a Wi‑Fi phone while *Best (USB)* (or a custom mix above 8 Mbps) is selected, DeXterous suggests *Balanced (Wi‑Fi)*, which a normal Wi‑Fi connection can keep up with. Click *Use Balanced*, or *Keep mine* to stay with what you have.

### From a terminal

You can also connect with adb yourself, and the phone shows up in the list the same way.

**Wireless debugging (no cable needed)**

1. On the phone, open *Developer options › Wireless debugging*, turn it on and tap *Pair device with pairing code*.
2. On the computer, run `adb pair <ip>:<pairing-port>` with the values the phone shows, and type the code.
3. Run `adb connect <ip>:<port>` with the *IP address & port* from the *Wireless debugging* screen.

**`adb tcpip` (needs USB once)**

1. Plug the phone in over USB and run `adb tcpip 5555`.
2. Unplug it and run `adb connect <phone-ip>:5555`.

You'll find the phone's IP address in *Settings › Connections › Wi‑Fi*: tap the gear next to your network. This lasts until the phone restarts. `adb tcpip` phones can also be added from the connect screen: enter `<phone-ip>:5555` as the phone address.

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

*Share the clipboard with this device* decides whether there is one clipboard or two.

- **On (default):** one shared clipboard. Anything you copy in DeX lands on the clipboard of the device you're using, and ⌘V / Ctrl+V in DeX pastes that device's clipboard.
- **Off:** two separate clipboards. Copies in DeX stay on the phone, and ⌘V / Ctrl+V pastes the phone's own clipboard.

You can switch it mid-session in the shortcuts panel. Some details:

- Safari only lets pages write to the clipboard right after you click or press a key, so a copy from DeX reaches the clipboard on your next click or key press. Until it has, ⌘V pastes the phone's copy, so pasting inside DeX still works.
- While the lock screen covers DeX, nothing is copied to your device. The most recent copy arrives once you unlock the phone.

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

Press Ctrl+Alt+Q, click the disconnect button at the right end of the dock (or *Disconnect* on the lock screen), or close the tab. Your open apps move back to the phone, like unplugging a DeX monitor (unless you turned off *Move open apps to the phone on disconnect*). Stopping DeXterous in the terminal (Ctrl+C) also ends the session. When the session ends, the phone's normal screen timeout applies again.

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

The panel's *Keyboard & security* section has live switches for *Use ⌘ as Ctrl* (Mac only), *Keep DeX usable while the phone is locked* and *Share the clipboard with this device*. Changes apply immediately and are remembered.

### DeX shortcuts

These belong to DeX itself and can vary between One UI versions. ⊞ is the right ⌘ on a Mac (or either ⌘ with *Use ⌘ as Ctrl* off) and the Windows key elsewhere.

| Shortcut | Does |
|---|---|
| ⊞+/ | Show all DeX shortcuts (on your phone's list) |
| ⊞+← / ⊞+→ | Snap a window left or right |
| ⊞+D | Show the desktop |
| Alt+Tab | Switch apps (in full screen) |
| Alt+F4 | Close the window |
| ⌘V / Ctrl+V | Paste (from this device when the clipboard is shared) |

### The dock

Move the mouse to the top middle of the DeX screen and hold it there for a moment, or slide it off the top edge, to show the dock. It hides again when you move away. It doesn't open while you drag, so dragging a window to the top still works. On a touch screen, tap the ⌄ handle in the top-right corner. From left to right: Back, Home, Recent apps, show keyboard, mute, lock phone, full screen, the shortcuts panel (?) and disconnect. Turning the phone's own screen off and the connection stats are in the panel.

## Settings explained

The settings live in *Display & input* on the connect screen. Your browser remembers them for this address, so another browser or device has its own. Most take effect the next time you click **Start DeX**.

### Picture quality

Pick a preset, and DeXterous sets the sharpness, codec, bitrate and frame rate for you:

| Preset | Sharpness | Codec | Bitrate | Frame rate | Good for |
|---|---|---|---|---|---|
| **Best (USB)** | 2× | H.265 | 24 Mbps | 60 fps | A USB cable. The default. |
| **Balanced (Wi‑Fi)** | 1.5× | H.264 | 8 Mbps | 60 fps | A normal Wi‑Fi connection. |
| **Light** | 1× | H.264 | 4 Mbps | 30 fps | Slow Wi‑Fi or an older computer. |
| **Custom** | | | | | Your own mix, set under *Custom*. |

*Best* uses H.264 instead of H.265 when your browser can't decode H.265. Under the presets, a line spells out what the selected one uses. Opening *Custom* shows the four settings below; changing any of them switches to *Custom*.

### All settings

| Setting | Options | What it does |
|---|---|---|
| Sharpness | Retina (2×), Balanced (1.5×), Fast (1×) | Under *Custom*. How many virtual display pixels DeX gets per browser pixel. Retina is crisp on HiDPI screens; Fast is lightest on the phone and the network. Large windows are capped so the display stays within 3840 × 2160. |
| Video codec | H.264, H.265, AV1 | Under *Custom*. H.264 is the most compatible. H.265 is sharper at the same bitrate in Chrome and Safari. AV1 needs a recent phone. Codecs this browser can't decode are greyed out, and DeXterous falls back to H.264 if needed. |
| Bitrate | 4, 8, 16, 24 Mbps | Under *Custom*. Higher is sharper but needs more bandwidth. Use 4–8 Mbps over Wi‑Fi and 24 over USB. |
| Frame rate | 30, 60, 120 fps | Under *Custom*. The maximum frame rate. |
| DeX text size | Small, Default, Large, Larger | Scales DeX's UI by setting the virtual display's DPI. |
| Play phone audio here | on by default | Sends the phone's audio to the browser. |
| Keep audio on the phone too | off by default | Also keeps playing it on the phone (Android 13+). |
| Share the clipboard with this device | on by default | One shared clipboard, or two separate ones. See [Clipboard](#clipboard). Can be changed mid-session. |
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

The lock guard is a convenience, not a security boundary. It stops someone from using DeX in your browser while your phone is locked in your pocket. It doesn't stop anyone who can use your computer's adb (or open your DeXterous link with its token) from controlling the phone in other ways. Lock your computer when you walk away, and see [SECURITY.md](../SECURITY.md) for the full picture.

### Why the phone stays awake

While DeXterous is connected, it keeps the phone awake: over USB the screen stays on while plugged in, and over Wi‑Fi DeXterous reports activity on the DeX display. Without this, the phone would time out its screen and lock in the middle of your work, and the lock guard would cover DeX.

The phone only locks when you lock it: with the side key, Ctrl+Alt+L, or the lock button in the dock. When you disconnect, the phone's normal screen timeout applies again.

## Use it from another device

The phone stays plugged into one computer, which runs DeXterous. Any device on the same network, such as a tablet or another computer, can then open DeX in its browser.

### Start in LAN mode

```bash
dexterous --lan
```

In LAN mode, DeXterous:

- listens on all network interfaces, not only `localhost`,
- serves HTTPS, because browsers only allow video decoding and clipboard access on secure pages, using a self-signed certificate it creates for the computer's addresses,
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

### Safari and trusted certificates

Safari, and every browser on an iPhone or iPad, may load the page with a self-signed certificate but then refuse the live connection to the phone. The fix is a certificate the device trusts. Two ways:

**mkcert** (a local certificate authority)

1. Install [mkcert](https://github.com/FiloSottile/mkcert) on the computer and run `mkcert -install`.
2. Create a certificate for the computer's name and IP address, e.g. `mkcert my-mac.local 192.168.1.20`. This writes `my-mac.local+1.pem` and `my-mac.local+1-key.pem`.
3. Start DeXterous with it: `dexterous --lan --cert my-mac.local+1.pem --key my-mac.local+1-key.pem`.
4. On the other device, trust mkcert's root certificate, `rootCA.pem` from the folder `mkcert -CAROOT` prints. On an iPhone or iPad, send the file to it (AirDrop works), install it in *Settings › General › VPN & Device Management*, then turn on full trust in *Settings › General › About › Certificate Trust Settings*.

**Tailscale** (if both devices are on your tailnet)

1. Run `tailscale cert <machine>.<tailnet>.ts.net` on the computer. It writes a `.crt` and a `.key` file for that name.
2. Start DeXterous with them: `dexterous --lan --cert <machine>.<tailnet>.ts.net.crt --key <machine>.<tailnet>.ts.net.key`.
3. Open `https://<machine>.<tailnet>.ts.net:8686/#token=…` on the other device. DeXterous prints the link with the certificate's name.

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

- **From the project site:** [subsneaker.github.io/DeXterous/app/](https://subsneaker.github.io/DeXterous/app/) serves a copy built from this repository by its GitHub Actions workflow. The *Browser* tab on the [project site](https://subsneaker.github.io/DeXterous/) opens it too. It can only connect with *USB, browser only*. Its *Through DeXterous* tab says "Needs DeXterous on your computer" and shows how to [install DeXterous](#install-dexterous) instead of a phone list.
- **From source:** `npm run build`, then upload the `dist/` folder.
- **From an installed copy:** the built app is in DeXterous's package folder, `$(npm root -g)/@subsneaker/dexterous/dist`.

Only use a copy you host yourself or trust: whoever controls the page controls what it does with your phone once you approve it.

This mode is for computers that aren't running DeXterous. Where `dexterous` runs, its adb server already holds the phone, so use *Through DeXterous* there: it works over USB too.

### Connecting

1. **Free the phone.** Only one program can use the phone's USB debugging interface at a time. Close Android Studio, scrcpy and any other adb tools. If adb is still running, run `adb kill-server`.
2. Open the page and choose the **USB, browser only** tab.
3. Click **Add phone…** and pick your phone in the browser's USB dialog. The browser remembers it for next time.
4. Click **Start DeX**. The phone asks *Allow USB debugging?* again, this time for the browser's own key. Tick *Always allow* and tap *Allow*.

The browser keeps its adb key in the site's storage. If you clear the site's data, the phone asks again. If the browser can't open the phone, install DeXterous and use *Through DeXterous*.

## Command-line reference

```text
dexterous [options]
dexterous update [--check]  install the latest version (--check: only check)
npm start -- [options]      (from source)
```

`dexterous update` is explained in [Updating](#updating).

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
| `--no-update-check` | | Don't check npm's registry for new versions. See [Updating](#updating). |
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
| `DEXTEROUS_NO_UPDATE_CHECK` | Set to `1` to turn off update checks, like `--no-update-check`. |
| `DEXTEROUS_UPDATE_REGISTRY` | The npm registry to check for updates, if you use a mirror. Default: `https://registry.npmjs.org`. |

### Files and the state directory

DeXterous creates these files on first use. The first three are secrets: keep them private.

| File | Contents |
|---|---|
| `token` | The access token, also used in the `#token=…` link. Delete it to rotate the token. |
| `cert.pem` | The self-signed certificate for `--lan` and `--https`. |
| `key.pem` | Its private key. |
| `update-check.json` | When DeXterous last checked for a new version, and the answer. Safe to delete. |
| `update.log` | npm's output from the last update installed from the DeXterous page. Safe to delete. |

The self-signed certificate covers `localhost`, the computer's name and its network addresses. DeXterous renews it before it expires and whenever the computer gets an address it doesn't cover. Delete both files to force a new one.

| OS | State directory |
|---|---|
| macOS | `~/Library/Application Support/DeXterous` |
| Windows | `%APPDATA%\DeXterous` |
| Linux | `~/.config/dexterous`, or `$XDG_CONFIG_HOME/dexterous` |

Set `DEXTEROUS_HOME` to use another directory.

## Updating and uninstalling

### Updating

DeXterous looks for a new version about once a day: when it starts, if the last check is more than a day old, and again while it runs. When there is one, it prints a line like this in the terminal:

```text
DeXterous 0.3.0 is available (you have 0.2.0). To update, ...
```

The connect screen shows it too, in a banner at the top: *DeXterous X.Y.Z is available*, with a *What's new* link. When DeXterous can update itself, the banner has an *Update now* button. Otherwise it shows the command to run, with a *Copy* button. Close the banner with its × to hide it until the next version. The version you're running is at the bottom of the connect screen, next to links to the project site and to DeXterous on GitHub.

The rest of the terminal line says how to update the way you installed it:

- **Installed with `npm install -g`:** click *Update now* on the DeXterous page, or stop DeXterous and run `dexterous update`. This works while DeX isn't running (disconnect first), because DeXterous restarts afterwards. It installs the update with npm, restarts in the same terminal window, and the page reloads by itself. Your settings, token and certificate are kept. If you stop DeXterous while the update installs, it waits for npm to finish first, so the install isn't left half done.
- **With npx:** start it with `npx @subsneaker/dexterous@latest`. The `@latest` makes npx look for a new version instead of reusing the copy it saved.
- **From source:** `git pull`, then `npm install`.

`dexterous update --check` only checks, without installing. Run `dexterous --version` to see which version you have, and the [changelog](../CHANGELOG.md) for what's new.

DeXterous can't update itself when npm needs administrator rights to change its global folder. That's common on Linux when Node.js came from the distribution and you installed with `sudo`. It then tells you to run `sudo npm install -g @subsneaker/dexterous@latest` yourself. To avoid `sudo`, see the `EACCES` tip under [Linux](#linux).

#### About the update check

The check is a single request to `https://registry.npmjs.org` that asks for the latest version number of `@subsneaker/dexterous`. It doesn't send your version, a user ID or anything about your computer or phone. Like any website, the registry sees your IP address. The answer is saved in `update-check.json` in the [state directory](#files-and-the-state-directory), so DeXterous doesn't ask again for a day. If you're offline, it stays quiet and tries again later.

The check is off when:

- you start DeXterous with `--no-update-check`, or set `DEXTEROUS_NO_UPDATE_CHECK=1`,
- `$CI` is set,
- DeXterous runs from a clone of the repository (`npm start`, `npm run relay`, or a clone linked with `npm install -g .`).

### Uninstalling

1. Remove the command: `npm uninstall -g @subsneaker/dexterous`.
2. Delete the [state directory](#files-and-the-state-directory) to remove the token and certificate.
3. In your browser, clear the site data for `localhost:8686` (and any LAN address you used) to remove saved settings and the remembered token.
4. On the phone, optionally:
   - remove the scrcpy server file: `adb shell rm /data/local/tmp/dexterous-server.jar`,
   - revoke the computer's access in *Developer options › Revoke USB debugging authorizations*,
   - turn off *USB debugging*, or *Developer options* altogether.
5. If you installed mkcert's root certificate only for DeXterous, remove it with `mkcert -uninstall`, and from any other device you installed it on.

## Troubleshooting

### Installing and starting

- **`npm install -g` fails with `EACCES`:** npm is trying to write to a system folder. See the tip under [Linux](#linux).
- **`dexterous: command not found`:** npm's global folder isn't on your `PATH`. `npm prefix -g` shows where it is; the command lives in its `bin` folder on macOS and Linux, and in the folder itself on Windows. On Windows, open a new terminal after installing.
- **"Port 8686 is already in use":** another DeXterous (or something else) is using the port. Stop it, or start with `--port 8787`.
- **The browser didn't open:** open the link DeXterous printed. DeXterous doesn't open a browser when `$CI` is set, when its output isn't a terminal, or on Linux without a graphical display.
- **"DeXterous can talk to adb" isn't ticked, "The relay couldn't talk to adb" or "adb server: not reachable":** install Android platform-tools, make sure `adb` is on your `PATH`, then restart DeXterous.

### Installing updates

- **The page says a DeX session is open:** disconnect first, in every tab and on every device. DeXterous restarts after an update, which would end the session.
- **"DeXterous is updating":** an update is installing, so DeXterous doesn't start new sessions, and *Start DeX* is greyed out. Wait for the page to reload with the new version, then start DeX.
- **"DeXterous can't update itself", or the banner shows a command instead of *Update now*:** npm needs administrator rights, DeXterous wasn't installed with `npm install -g`, or the page is open on another device (only the computer running DeXterous can install updates). Run the command it shows in a terminal.
- **The update failed:** the terminal running DeXterous shows the end of npm's error message, and `update.log` in the [state directory](#files-and-the-state-directory) has all of it. Or run `npm install -g @subsneaker/dexterous@latest` yourself to see the whole story. If it says "EACCES" or "EPERM", see the `EACCES` tip under [Linux](#linux). Your current version keeps running either way.
- **"The new version needs a newer Node.js":** install a current Node.js (see [Install DeXterous](#install-dexterous)), then update again.
- **No update shows up:** DeXterous only checks about once a day. Run `dexterous update --check` to check right away.

### Connecting

- **No phone in the list:** look at *Before you start* on the connect screen: the first unticked step says what's missing. Unlock the phone, check that USB debugging is on, and run `adb devices`. If the phone's card says *Tap Allow on your phone* (or `adb devices` says `unauthorized`), tap *Allow* on the phone. Try another cable or port; some cables only charge.
- **The phone never asks to allow USB debugging:** in *Developer options*, tap *Revoke USB debugging authorizations*, then replug. Check that *Auto Blocker* isn't blocking USB commands.
- **"This relay needs an access token":** open the full link with `#token=…` that DeXterous printed.
- **"Invalid access token":** the token changed. Open the new link.
- **"Couldn't reach DeXterous on your computer. Is it still running?":** the terminal running DeXterous was closed or stopped. Start it again and reload the page.
- **Other devices can't connect in LAN mode:** check the [firewall](#firewall). Make sure both devices are on the same network, and that the link uses an address of the computer on that network.
- **Safari loads the page, but connecting fails:** use a [trusted certificate](#safari-and-trusted-certificates).
- **"The phone refused to create a virtual display":** the phone is on One UI 7 or older. DeX on a virtual display needs One UI 8.
- **A phone card says *needs One UI 8+* or *not a Galaxy*:** see [If your phone isn't supported](#if-your-phone-isnt-supported).
- **"That pairing code didn't work":** check the 6-digit code and the pairing address in the pairing window. Codes only work while that window is open on the phone. If it closed, tap *Pair device with pairing code* again and enter the new code and address.
- **"Couldn't reach" a Wi‑Fi phone:** check the address and port on the phone's *Wireless debugging* screen (the port changes when Wireless debugging is turned off and on), and that both devices are on the same Wi‑Fi.
- **"The phone hasn't accepted this connection":** pair it first, under *First time pairing this phone?*.
- **Browser-only mode says adb is using the phone:** only one program can use the phone's USB connection at a time, and where DeXterous runs, its adb server usually has it. Close the programs that use adb, or click *Use Through DeXterous* (shown when DeXterous is running) to start DeX through DeXterous instead. It works over USB too. Running `adb kill-server` also works, but it stops scrcpy and other adb tools, and DeXterous's own mode needs adb.

### While using DeX

- **"Your phone is locked" / "Your phone is asleep" / "Checking your phone…":** unlock the phone (*Wake phone screen* turns its screen on first). To skip this in future, turn on *Keep DeX usable while the phone is locked* while the phone is unlocked.
- **"Waiting for the picture…":** the phone may be locked or busy. Unlock it and wait a few seconds.
- **Frozen desktop with *Keep DeX usable while the phone is locked* on:** some phones still pause DeX when their screen goes fully off. Press Ctrl+Alt+W to wake the phone.
- **Choppy over Wi‑Fi:** choose *Balanced (Wi‑Fi)* or *Light* under *Picture quality*. USB is always smoothest.
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
No. DeX is Samsung's. DeXterous can still connect to other Android phones, but you'll only get Android's own desktop mode, if the phone has one, and that isn't supported.

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
Almost nothing, and no telemetry. Everything runs on your computer and your phone. About once a day, DeXterous asks npm's registry for the latest version number; the request carries nothing about you (see [About the update check](#about-the-update-check)), and `--no-update-check` turns it off. Otherwise, only installing and updating need the internet.

**Can I use it over the internet, away from home?**
Don't expose DeXterous to the internet. Use a private network such as Tailscale or WireGuard instead, ideally with a [trusted certificate](#safari-and-trusted-certificates).

**Does it work with a Galaxy Tab?**
Yes, if the tablet runs One UI 8 or newer. Everything this guide says about phones applies to tablets too.

**Is this Samsung DeX for PC?**
No. Samsung discontinued those apps. DeXterous is an independent, unofficial project that runs the DeX already built into your phone.

---

DeXterous is not affiliated with or endorsed by Samsung. "Samsung", "Galaxy" and "DeX" are trademarks of Samsung Electronics.
