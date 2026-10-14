// Hero: a generic Galaxy-style phone floating in the middle, with a ring of generic devices
// (laptop, monitor, tablet, wide monitor) slowly orbiting it. Each screen shows a DeX-style
// desktop: a browser tab drawn here, holding a real photo of a DeX desktop (img/dex-desktop.webp,
// Maurizio Pesce, CC BY 2.0, credited in the page footer). If the photo can't load, the tab
// holds a drawn DeX-style desktop instead. The phone's home screen is drawn here too.
//
// Behavior:
//  - Loads Three.js lazily, only when WebGL works and the hero is near the viewport.
//  - Until then (and without JS or WebGL) the pre-rendered poster image stays visible.
//  - Caps the pixel ratio, pauses when offscreen or in a background tab.
//  - Drag, click a device, or use the arrow buttons to turn the ring.
//  - With prefers-reduced-motion it renders one still frame and never orbits on its own.
// No element styles are set from JS. The canvas is sized by CSS, and the scene's colours
// (backdrop, floor, track, shadows, light tints) come from --scene-* custom properties in CSS.

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js";
const DESKTOP_PHOTO_URL = new URL("../img/dex-desktop.webp", import.meta.url).href;

const stage = document.querySelector("[data-hero-stage]");
const canvas = document.querySelector("[data-hero-canvas]");

function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (gl && gl.getExtension("WEBGL_lose_context")) gl.getExtension("WEBGL_lose_context").loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------------------ */
/* Artwork                                                             */
/* ------------------------------------------------------------------ */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Layered hills and a low sun. Used as the wallpaper on both screens.
function drawWallpaper(ctx, x, y, w, h, tone) {
  const sky = ctx.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, tone.top);
  sky.addColorStop(0.65, tone.mid);
  sky.addColorStop(1, tone.low);
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);

  const sunX = x + w * tone.sunX;
  const sunY = y + h * 0.58;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.5);
  glow.addColorStop(0, "rgba(255,196,120,0.55)");
  glow.addColorStop(1, "rgba(255,196,120,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffc978";
  ctx.beginPath();
  ctx.arc(sunX, sunY, h * 0.075, 0, Math.PI * 2);
  ctx.fill();

  const hills = [
    { base: 0.66, amp: 0.05, f: 1.3, p: 0.4, color: tone.h1 },
    { base: 0.76, amp: 0.06, f: 1.8, p: 1.7, color: tone.h2 },
    { base: 0.88, amp: 0.05, f: 1.1, p: 3.1, color: tone.h3 },
  ];
  hills.forEach((hill) => {
    ctx.fillStyle = hill.color;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const yy = y + h * (hill.base + Math.sin(t * Math.PI * 2 * hill.f + hill.p) * hill.amp);
      ctx.lineTo(x + t * w, yy);
    }
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  });
}

function windowFrame(ctx, x, y, w, h, title, accent) {
  ctx.save();
  ctx.shadowColor = "rgba(5,10,30,0.45)";
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#f6f7fb";
  rr(ctx, x, y, w, h, 18);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 56, [18, 18, 0, 0]);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "600 22px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 22, y + 29);

  // minimize, maximize, close
  const cy = y + 28;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + w - 112, cy);
  ctx.lineTo(x + w - 96, cy);
  ctx.stroke();
  ctx.strokeRect(x + w - 66, cy - 8, 16, 16);
  ctx.beginPath();
  ctx.moveTo(x + w - 34, cy - 8);
  ctx.lineTo(x + w - 18, cy + 8);
  ctx.moveTo(x + w - 18, cy - 8);
  ctx.lineTo(x + w - 34, cy + 8);
  ctx.stroke();
}

function drawAppIcon(ctx, x, y, s, color, glyph) {
  ctx.fillStyle = color;
  rr(ctx, x, y, s, s, s * 0.3);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = s * 0.075;
  ctx.lineCap = "round";
  const cx = x + s / 2;
  const cy = y + s / 2;
  const k = s * 0.22;
  ctx.beginPath();
  if (glyph === 0) {
    ctx.arc(cx, cy, k, 0, Math.PI * 2);
    ctx.stroke();
  } else if (glyph === 1) {
    ctx.moveTo(cx - k * 0.7, cy - k);
    ctx.lineTo(cx + k, cy);
    ctx.lineTo(cx - k * 0.7, cy + k);
    ctx.closePath();
    ctx.fill();
  } else if (glyph === 2) {
    ctx.moveTo(cx - k, cy - k * 0.6);
    ctx.lineTo(cx + k, cy - k * 0.6);
    ctx.moveTo(cx - k, cy + k * 0.6);
    ctx.lineTo(cx + k * 0.4, cy + k * 0.6);
    ctx.stroke();
  } else if (glyph === 3) {
    ctx.rect(cx - k, cy - k, k * 2, k * 2);
    ctx.stroke();
  } else {
    ctx.arc(cx, cy, k * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Resolves to a decoded image, or null when it can't load.
function loadImage(url) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  return img.decode().then(() => img, () => null);
}

// Draws `img` to cover the box, cropping what doesn't fit. ax/ay (0..1) pick which part stays.
function drawCover(ctx, img, x, y, w, h, ax, ay) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s;
  const sh = h / s;
  const sx = (img.naturalWidth - sw) * ax;
  const sy = (img.naturalHeight - sh) * ay;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// A browser window showing DeX, drawn at W x H. With `photo` the tab holds the real desktop
// photo (cropped to fit, keeping its taskbar); without it, a drawn DeX-style desktop.
function drawDesktopArt(W, H, tone, photo) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");

  // Browser chrome
  const chromeH = 88;
  ctx.fillStyle = "#2a1a26";
  ctx.fillRect(0, 0, W, chromeH);
  ["#ff6b62", "#ffc247", "#3ed36b"].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(40 + i * 34, 44, 11, 0, Math.PI * 2);
    ctx.fill();
  });
  // tab
  ctx.fillStyle = "#3d2836";
  ctx.beginPath();
  ctx.roundRect(170, 18, 250, 70, [14, 14, 0, 0]);
  ctx.fill();
  ctx.fillStyle = "#f0613f";
  rr(ctx, 192, 40, 26, 26, 7);
  ctx.fill();
  ctx.fillStyle = "#e8ecf8";
  ctx.font = "500 24px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("DeXterous", 230, 54);
  // address bar
  ctx.fillStyle = "#1a0f17";
  rr(ctx, 450, 20, Math.min(760, W - 700), 48, 24);
  ctx.fill();
  ctx.fillStyle = "#9aa3bd";
  ctx.font = "500 24px ui-monospace, SF Mono, Menlo, Consolas, monospace";
  ctx.fillText("localhost:8686", 490, 45);
  ctx.strokeStyle = "#9aa3bd";
  ctx.lineWidth = 3;
  ctx.strokeRect(470 - 1, 38, 12, 10);
  ctx.beginPath();
  ctx.arc(475, 36, 5, Math.PI, 0);
  ctx.stroke();

  // Desktop
  if (photo) {
    drawCover(ctx, photo, 0, chromeH, W, H - chromeH, 0.5, 1);
    return c;
  }
  const tbH = 84;
  drawWallpaper(ctx, 0, chromeH, W, H - chromeH, tone);

  // Windows live in a 1600 x 828 box that is scaled to fit and centered.
  const availH = H - chromeH - tbH;
  const sc = Math.min(W / 1600, availH / 828);
  ctx.save();
  ctx.translate((W - 1600 * sc) / 2, chromeH + (availH - 828 * sc) / 2);
  ctx.scale(sc, sc);
  const top = 0;

  // Window: notes
  windowFrame(ctx, 110, top + 70, 590, 520, "Notes", "#e6683c");
  ctx.fillStyle = "#1f2438";
  ctx.font = "700 34px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Today", 144, top + 70 + 104);
  const rows = [
    ["Reply to Mia", true, 330],
    ["Book train tickets", true, 380],
    ["Finish slides", false, 300],
    ["Water the plants", false, 270],
  ];
  rows.forEach(([text, done, lineW], i) => {
    const yy = top + 70 + 154 + i * 62;
    ctx.strokeStyle = done ? "#e6683c" : "#9aa1b8";
    ctx.fillStyle = done ? "#e6683c" : "transparent";
    ctx.lineWidth = 3;
    rr(ctx, 144, yy, 28, 28, 8);
    if (done) ctx.fill();
    ctx.stroke();
    if (done) {
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(151, yy + 14);
      ctx.lineTo(157, yy + 20);
      ctx.lineTo(166, yy + 8);
      ctx.stroke();
    }
    ctx.fillStyle = done ? "#9aa1b8" : "#2b3149";
    ctx.font = "500 26px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(text, 190, yy + 15);
    if (done) {
      ctx.strokeStyle = "#9aa1b8";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(190, yy + 15);
      ctx.lineTo(190 + lineW * 0.62, yy + 15);
      ctx.stroke();
    }
  });
  ctx.fillStyle = "#dfe3ef";
  rr(ctx, 144, top + 70 + 420, 480, 14, 7);
  ctx.fill();
  rr(ctx, 144, top + 70 + 448, 340, 14, 7);
  ctx.fill();

  // Window: photos
  windowFrame(ctx, 520, top + 190, 640, 500, "Photos", "#1f8a86");
  const tiles = [
    ["#ffb457", "#ff6f61"], ["#69d2c2", "#2b8f9e"], ["#8a7cf0", "#4f4bb8"],
    ["#f6d365", "#fda085"], ["#7ed6a0", "#2f9e6a"], ["#ff9db1", "#d9467a"],
  ];
  tiles.forEach(([a, b], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const tx = 548 + col * 200;
    const ty = top + 190 + 80 + row * 190;
    const g = ctx.createLinearGradient(tx, ty, tx + 180, ty + 170);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    rr(ctx, tx, ty, 180, 170, 14);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.arc(tx + 128, ty + 52, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.moveTo(tx, ty + 170);
    ctx.lineTo(tx + 70, ty + 100);
    ctx.lineTo(tx + 120, ty + 150);
    ctx.lineTo(tx + 150, ty + 120);
    ctx.lineTo(tx + 180, ty + 170);
    ctx.closePath();
    ctx.fill();
  });

  // Window: music
  windowFrame(ctx, 1130, top + 90, 400, 250, "Music", "#8a3a78");
  const art = ctx.createLinearGradient(1160, top + 170, 1260, top + 270);
  art.addColorStop(0, "#ffc978");
  art.addColorStop(1, "#e6683c");
  ctx.fillStyle = art;
  rr(ctx, 1160, top + 160, 96, 96, 14);
  ctx.fill();
  ctx.fillStyle = "#1f2438";
  ctx.font = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Low sun", 1280, top + 186);
  ctx.fillStyle = "#6b7390";
  ctx.font = "500 22px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Evening mix", 1280, top + 222);
  ctx.fillStyle = "#dde1ee";
  rr(ctx, 1160, top + 288, 340, 8, 4);
  ctx.fill();
  ctx.fillStyle = "#8a3a78";
  rr(ctx, 1160, top + 288, 190, 8, 4);
  ctx.fill();

  // Cursor
  ctx.save();
  ctx.translate(1010, 515);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 46); ctx.lineTo(12, 36); ctx.lineTo(21, 56); ctx.lineTo(30, 52); ctx.lineTo(21, 32); ctx.lineTo(37, 32);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#10131f";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // Taskbar
  ctx.fillStyle = "rgba(30,14,26,0.78)";
  ctx.fillRect(0, H - tbH, W, tbH);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.arc(48 + (i % 3) * 16, H - tbH + 26 + Math.floor(i / 3) * 16, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const icons = ["#e6683c", "#1f8a86", "#f2b233", "#8a3a78", "#ee5a8a", "#3f7be0"];
  icons.forEach((col, i) => {
    const ix = W / 2 - icons.length * 36 + i * 72;
    drawAppIcon(ctx, ix, H - tbH + 14, 56, col, i % 5);
    if (i < 3) {
      ctx.fillStyle = "#ffffff";
      rr(ctx, ix + 20, H - tbH + 74, 16, 4, 2);
      ctx.fill();
    }
  });
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("10:08", W - 30, H - tbH + 32);
  ctx.font = "500 18px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillText("Tue 14 Oct", W - 30, H - tbH + 58);
  ctx.textAlign = "left";
  // tray: wifi and battery
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(W - 250, H - tbH + 50, 8 + i * 8, Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();
  }
  rr(ctx, W - 200, H - tbH + 30, 36, 20, 5);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  rr(ctx, W - 196, H - tbH + 34, 24, 12, 3);
  ctx.fill();

  return c;
}

// 720 x 1600: the phone's own home screen.
function drawPhoneArt() {
  const W = 720;
  const H = 1600;
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");

  drawWallpaper(ctx, 0, 0, W, H, {
    top: "#f4c7a1", mid: "#e98b74", low: "#8f5aa6", sunX: 0.5,
    h1: "#b4638f", h2: "#7d4a8f", h3: "#4a2f6e",
  });

  ctx.fillStyle = "#ffffff";
  ctx.font = "600 30px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("10:08", 54, 62);
  ctx.textAlign = "right";
  ctx.fillText("5G", W - 54, 62);
  ctx.textAlign = "left";
  ctx.fillStyle = "#101320";
  ctx.beginPath();
  ctx.arc(W / 2, 62, 17, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "300 190px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("10:08", W / 2, 260);
  ctx.font = "500 36px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Tuesday, 14 October", W / 2, 380);
  ctx.textAlign = "left";

  // Banner: the point of the whole thing
  ctx.fillStyle = "rgba(20,16,40,0.55)";
  rr(ctx, 54, 450, W - 108, 120, 30);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  rr(ctx, 88, 482, 56, 38, 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(116, 520);
  ctx.lineTo(116, 536);
  ctx.moveTo(100, 538);
  ctx.lineTo(132, 538);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 31px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("DeX is on a second screen", 168, 497);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "500 27px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("This phone is still all yours", 168, 538);

  // App grid
  const cols = ["#2f6bff", "#2fb67c", "#f2b233", "#ee5a8a", "#7c4dd6", "#e6683c", "#3fb8d8", "#5f6b8f"];
  const gs = 118;
  const gx = (W - 4 * gs) / 5;
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 4; col++) {
      const i = r * 4 + col;
      drawAppIcon(ctx, gx + col * (gs + gx), 650 + r * 190, gs, cols[i % cols.length], i % 5);
    }
  }
  // Dock
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  rr(ctx, 40, H - 300, W - 80, 160, 52);
  ctx.fill();
  for (let col = 0; col < 4; col++) {
    drawAppIcon(ctx, gx + col * (gs + gx), H - 280, gs, cols[(col + 3) % cols.length], (col + 2) % 5);
  }
  // Home bar
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  rr(ctx, W / 2 - 100, H - 56, 200, 9, 5);
  ctx.fill();
  return c;
}

function drawKeyboardArt() {
  const W = 1024;
  const H = 460;
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#c4c9d8";
  ctx.fillRect(0, 0, W, H);
  const rows = [14, 14, 13, 12, 7];
  const keyH = 56;
  const gap = 8;
  rows.forEach((n, r) => {
    const keyW = (W - 80 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const x = 40 + i * (keyW + gap);
      const y = 26 + r * (keyH + gap);
      ctx.fillStyle = "#a9afc2";
      rr(ctx, x, y + 3, keyW, keyH, 9);
      ctx.fill();
      ctx.fillStyle = "#f1f3f9";
      rr(ctx, x, y, keyW, keyH, 9);
      ctx.fill();
    }
  });
  ctx.fillStyle = "#b3b9cb";
  rr(ctx, W / 2 - 130, 330, 260, 110, 18);
  ctx.fill();
  return c;
}

// A soft round shadow, white on transparent. The material tints it.
function drawShadowArt() {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.5, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return c;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

const DEVICES = [
  { id: "laptop", name: "a Mac" },
  { id: "monitor", name: "a Windows PC" },
  { id: "tablet", name: "a tablet" },
  { id: "ultrawide", name: "a Linux PC" },
];

const FLOOR = -1.55; // y of the ring plane
const RX = 2.7; // ring half-width
const RZ = 2.3; // ring half-depth
const PHONE_Y = 1.85; // phone centre height

// Scene colours live in CSS as custom properties on the stage (--scene-*).
// Resolve any CSS colour syntax to 0..1 sRGB through a 1px canvas.
const probe = makeCanvas(1, 1).getContext("2d", { willReadFrequently: true });
function cssColor(name, fallback) {
  const value = getComputedStyle(stage).getPropertyValue(name).trim();
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  if (value) probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
function stageBackground() {
  // The nearest ancestor with a painted background is the hero section.
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#f0613f";
  probe.fillStyle = getComputedStyle(stage.closest(".hero") || document.body).backgroundColor;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

async function startHero() {
  // The desktop photo loads alongside Three.js; if it fails, the screens use the drawn desktop.
  const [THREE, photo] = await Promise.all([import(THREE_URL), loadImage(DESKTOP_PHOTO_URL)]);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // Fog in the hero's background colour: devices at the back fade into it.
  scene.fog = new THREE.Fog(0xffffff, 10, 19.5);
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.1, 80);
  camera.position.set(0, 3.0, 11.7);
  camera.lookAt(0, 0.1, 0);

  // Warm studio light: a cream sky, light bouncing up off the coloured floor, a butter rim.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.75);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff3e4, 2.2);
  key.position.set(-4, 6, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6);
  rim.position.set(5, 3, -4);
  scene.add(rim);

  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  function textureFrom(art) {
    const t = new THREE.CanvasTexture(art);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }

  function roundedShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r);
    s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h);
    s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r);
    s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  }
  function slab(w, h, r, depth, material, bevel = 0.012) {
    const geo = new THREE.ExtrudeGeometry(roundedShape(w, h, r), {
      depth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      curveSegments: 12,
    });
    geo.translate(0, 0, -depth / 2);
    return new THREE.Mesh(geo, material);
  }
  function plane(w, h, r, material, uv) {
    const geo = new THREE.ShapeGeometry(roundedShape(w, h, r), 12);
    if (uv) {
      const pos = geo.attributes.position;
      const t = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) t.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
    }
    return new THREE.Mesh(geo, material);
  }
  function box(w, h, d, material) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  }

  const mats = {
    black: new THREE.MeshStandardMaterial({ color: 0x1c1519, roughness: 0.4, metalness: 0.2 }),
    graphite: new THREE.MeshStandardMaterial({ color: 0x33282f, roughness: 0.4, metalness: 0.3 }),
    silver: new THREE.MeshStandardMaterial({ color: 0xd8d2d0, roughness: 0.42, metalness: 0.2 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa3979a, roughness: 0.35, metalness: 0.3 }),
    bezel: new THREE.MeshStandardMaterial({ color: 0x120c10, roughness: 0.5, metalness: 0.1 }),
  };

  // A display: body slab, black bezel plane, picture. Faces +z, centred on the origin.
  function display(w, h, bezel, depth, bodyMat, radius, art) {
    const g = new THREE.Group();
    g.add(slab(w + bezel * 2, h + bezel * 2, radius, depth, bodyMat));
    const front = depth / 2 + 0.013;
    if (bodyMat !== mats.black) {
      const b = plane(w + bezel * 1.5, h + bezel * 1.5, radius * 0.8, mats.bezel);
      b.position.z = front;
      g.add(b);
    }
    const screen = plane(w, h, 0.04, new THREE.MeshBasicMaterial({ map: textureFrom(art), toneMapped: false }), true);
    screen.position.z = front + 0.002;
    g.add(screen);
    return g;
  }
  function flatBase(w, d, mat) {
    const m = slab(w, d, Math.min(w, d) * 0.4, 0.05, mat, 0.01);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.035;
    return m;
  }

  const tones = {
    dusk: { top: "#3d1838", mid: "#d9573c", low: "#f5bd5c", sunX: 0.72, h1: "#a8433f", h2: "#74283f", h3: "#3d1534" },
    sea: { top: "#0d3a44", mid: "#1d7d82", low: "#93d3bf", sunX: 0.3, h1: "#1a6b70", h2: "#12505a", h3: "#0b3540" },
    peach: { top: "#f6d7b4", mid: "#ef9677", low: "#b75c78", sunX: 0.62, h1: "#c9707a", h2: "#97496a", h3: "#5e2c52" },
    plum: { top: "#1f1030", mid: "#5d2a68", low: "#d9695a", sunX: 0.5, h1: "#7a3566", h2: "#55234f", h3: "#311634" },
  };

  const builders = {
    // Generic laptop: deck with keyboard, hinge, tilted lid.
    laptop() {
      const g = new THREE.Group();
      const deck = slab(2.9, 1.9, 0.09, 0.07, mats.silver);
      deck.rotation.x = -Math.PI / 2;
      deck.position.set(0, 0.04, 0.12);
      g.add(deck);
      const keys = new THREE.Mesh(
        new THREE.PlaneGeometry(2.55, 1.15),
        new THREE.MeshBasicMaterial({ map: textureFrom(drawKeyboardArt()), toneMapped: false })
      );
      keys.rotation.x = -Math.PI / 2;
      keys.position.set(0, 0.092, 0.05);
      g.add(keys);
      const hinge = new THREE.Group();
      hinge.position.set(0, 0.08, -0.8);
      hinge.rotation.x = -0.3;
      const lid = display(2.66, 1.66, 0.12, 0.06, mats.silver, 0.09, drawDesktopArt(1600, 1000, tones.dusk, photo));
      lid.position.y = 0.95;
      hinge.add(lid);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 14), mats.steel);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(0, 0, 0);
      hinge.add(barrel);
      g.add(hinge);
      return g;
    },
    // Generic desktop monitor on a neck and base.
    monitor() {
      const g = new THREE.Group();
      g.add(flatBase(1.3, 0.7, mats.graphite));
      const neck = box(0.22, 0.85, 0.08, mats.graphite);
      neck.position.set(0, 0.45, -0.1);
      g.add(neck);
      const d = display(2.7, 1.52, 0.07, 0.09, mats.black, 0.07, drawDesktopArt(1600, 900, tones.sea, photo));
      d.position.set(0, 1.0 + 0.8, 0);
      d.rotation.x = -0.04;
      g.add(d);
      return g;
    },
    // Generic tablet on a small dock.
    tablet() {
      const g = new THREE.Group();
      g.add(flatBase(1.5, 0.62, mats.graphite));
      const neck = box(0.5, 0.6, 0.07, mats.graphite);
      neck.position.set(0, 0.34, -0.12);
      g.add(neck);
      const d = display(2.4, 1.8, 0.1, 0.05, mats.silver, 0.17, drawDesktopArt(1600, 1200, tones.peach, photo));
      d.position.set(0, 0.62 + 1.0, 0);
      d.rotation.x = -0.12;
      g.add(d);
      return g;
    },
    // Generic ultrawide monitor with a low stand.
    ultrawide() {
      const g = new THREE.Group();
      g.add(flatBase(1.6, 0.6, mats.graphite));
      const neck = box(0.2, 0.6, 0.08, mats.graphite);
      neck.position.set(0, 0.34, -0.1);
      g.add(neck);
      const d = display(3.3, 1.4, 0.06, 0.09, mats.black, 0.06, drawDesktopArt(1920, 820, tones.plum, photo));
      d.position.set(0, 0.62 + 0.76, 0);
      d.rotation.x = -0.04;
      g.add(d);
      return g;
    },
  };

  const tilt = new THREE.Group();
  scene.add(tilt);
  const ring = new THREE.Group();
  tilt.add(ring);

  const N = DEVICES.length;
  const STEP = (Math.PI * 2) / N;
  DEVICES.forEach((dev, i) => {
    const g = builders[dev.id]();
    g.userData.index = i;
    ring.add(g);
  });

  // The turntable: a flat disc a shade darker than the backdrop, one thin track on it,
  // and a soft shadow under every device and under the phone.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1, 128),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR - 0.01;
  floor.scale.set(RX * 1.36, RZ * 1.36, 1);
  floor.renderOrder = -2;
  tilt.add(floor);
  const track = new THREE.Mesh(
    new THREE.TorusGeometry(RX, 0.012, 8, 192),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
  );
  track.scale.set(1, RZ / RX, 1);
  track.rotation.x = Math.PI / 2;
  track.position.y = FLOOR;
  tilt.add(track);

  const shadowArt = textureFrom(drawShadowArt());
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowArt, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });
  function blob(w, d, mat = shadowMat) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.rotation.x = -Math.PI / 2;
    m.scale.set(w, d, 1);
    m.renderOrder = -1;
    return m;
  }
  const footprint = { laptop: [3.6, 2.6], monitor: [3.2, 1.3], tablet: [2.9, 1.2], ultrawide: [3.8, 1.2] };
  ring.children.forEach((g) => {
    const [w, d] = footprint[DEVICES[g.userData.index].id];
    const b = blob(w, d);
    b.position.set(0, 0.006, 0);
    g.add(b);
  });
  const phoneShadowMat = shadowMat.clone();
  const phoneShadow = blob(1.9, 1.0, phoneShadowMat);
  phoneShadow.position.set(0, FLOOR + 0.004, 0.1);
  tilt.add(phoneShadow);

  function syncColors() {
    const set = (color, rgb) => color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    set(scene.fog.color, stageBackground());
    set(floor.material.color, cssColor("--scene-floor", "#d9532f"));
    set(track.material.color, cssColor("--scene-track", "#fff4e6"));
    set(shadowMat.color, cssColor("--scene-shadow", "#4a1610"));
    phoneShadowMat.color.copy(shadowMat.color);
    set(hemi.color, cssColor("--scene-sky", "#fff6ea"));
    set(hemi.groundColor, cssColor("--scene-ground", "#f08060"));
    set(rim.color, cssColor("--scene-rim", "#ffe08a"));
  }
  syncColors();

  // The phone, floating in the middle
  const PW = 0.78;
  const PH = 1.62;
  const phone = new THREE.Group();
  phone.add(slab(PW, PH, 0.13, 0.095, mats.graphite));
  const pScreen = plane(PW - 0.07, PH - 0.07, 0.1, new THREE.MeshBasicMaterial({ map: textureFrom(drawPhoneArt()), toneMapped: false, fog: false }), true);
  pScreen.position.z = 0.0625;
  phone.add(pScreen);
  [[0.13, 0.3], [-0.2, 0.18]].forEach(([y, len]) => {
    const btn = box(0.03, len, 0.05, mats.steel);
    btn.position.set(PW / 2 + 0.008, y, 0);
    phone.add(btn);
  });
  phone.scale.setScalar(1.35);
  phone.position.set(0, PHONE_Y, 0);
  tilt.add(phone);

  /* ---------------- State ---------------- */
  const state = {
    visible: true,
    pageVisible: !document.hidden,
    raf: 0,
    last: 0,
    px: 0,
    py: 0,
    cx: 0,
    cy: 0,
    ang: 0, // ring rotation
    target: 0,
    mode: "auto", // auto | drag | snap
    hover: false,
    focus: false,
    paused: false,
    idleAt: 0,
    front: 0,
  };
  const reduced = () => motionQuery.matches;

  const captionName = document.querySelector("[data-hero-name]");
  const controls = document.querySelector("[data-hero-controls]");
  function frontIndex() {
    return (((Math.round(-state.ang / STEP) % N) + N) % N);
  }
  function updateCaption() {
    const f = frontIndex();
    if (f !== state.front || !captionName.textContent) {
      state.front = f;
      captionName.textContent = DEVICES[f].name;
    }
  }

  const announcer = document.querySelector("[data-hero-announce]");
  function announce(angle) {
    if (!announcer) return;
    const f = (((Math.round(-angle / STEP) % N) + N) % N);
    announcer.textContent = "Showing DeX on " + DEVICES[f].name;
  }

  function snapTo(targetAng) {
    state.target = targetAng;
    announce(targetAng);
    state.mode = "snap";
    state.idleAt = performance.now();
    if (reduced()) {
      state.ang = state.target;
      state.mode = "auto";
      renderOnce();
    } else {
      updateLoop();
    }
  }
  function go(dir) {
    const from = state.mode === "snap" ? state.target : state.ang;
    const cur = Math.round(-from / STEP);
    snapTo(-(cur + dir) * STEP);
  }
  function bringToFront(index) {
    // nearest equivalent angle that puts `index` at the front
    const base = -index * STEP;
    const turns = Math.round((state.ang - base) / (Math.PI * 2));
    snapTo(base + turns * Math.PI * 2);
  }

  /* ---------------- Pose and loop ---------------- */
  function applyPose(t, dt, still) {
    if (!still) {
      state.cx += (state.px - state.cx) * 0.06;
      state.cy += (state.py - state.cy) * 0.06;
      if (state.mode === "auto") {
        const paused = state.paused || state.hover || state.focus || performance.now() - state.idleAt < 2500;
        if (!paused) state.ang -= 0.16 * dt;
      } else if (state.mode === "snap") {
        state.ang += (state.target - state.ang) * (1 - Math.exp(-dt * 5));
        if (Math.abs(state.target - state.ang) < 0.002) {
          state.ang = state.target;
          state.mode = "auto";
        }
      }
    }
    // Devices ride an ellipse and keep facing the viewer, turned a little toward the phone.
    ring.children.forEach((g) => {
      const th = g.userData.index * STEP + state.ang;
      const near = (Math.cos(th) + 1) / 2;
      g.position.set(Math.sin(th) * RX, FLOOR, Math.cos(th) * RZ);
      g.rotation.y = -Math.sin(th) * 0.45;
      g.scale.setScalar(0.8 + 0.14 * near);
    });
    tilt.rotation.y = state.cx * 0.1;
    tilt.rotation.x = state.cy * 0.04;
    const bob = still ? 0 : Math.sin(t * 0.9);
    phone.position.y = PHONE_Y + bob * 0.06;
    phone.rotation.y = still ? 0 : Math.sin(t * 0.5) * 0.05 + state.cx * 0.14;
    // The shadow tightens and darkens as the phone dips.
    const lift = (bob + 1) / 2;
    phoneShadow.scale.set(1.9 - lift * 0.25, 1.0 - lift * 0.12, 1);
    phoneShadowMat.opacity = 0.42 - lift * 0.1;
    updateCaption();
  }

  function frame(now) {
    state.raf = 0;
    if (!state.visible || !state.pageVisible) return;
    const dt = Math.min(0.05, (now - (state.last || now)) / 1000);
    state.last = now;
    applyPose(now / 1000, dt, false);
    renderer.render(scene, camera);
    state.raf = requestAnimationFrame(frame);
  }
  function renderOnce() {
    applyPose(0, 0, true);
    renderer.render(scene, camera);
  }
  function updateLoop() {
    const animate = !reduced() && state.visible && state.pageVisible;
    if (animate && !state.raf) {
      state.last = 0;
      state.raf = requestAnimationFrame(frame);
    } else if (!animate && state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    if (!animate) renderOnce();
  }
  function resize() {
    const w = Math.max(1, Math.round(stage.clientWidth));
    const h = Math.max(1, Math.round(stage.clientHeight));
    // setSize(..., false) leaves the canvas styling to CSS.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 600 ? 1.75 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderOnce();
  }

  /* ---------------- Input ---------------- */
  window.addEventListener("pointermove", (e) => {
    if (!state.visible || e.pointerType === "touch") return;
    state.px = (e.clientX / window.innerWidth - 0.5) * 2;
    state.py = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });
  stage.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") state.hover = true; });
  stage.addEventListener("pointerleave", () => { state.hover = false; });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, startX: e.clientX, startY: e.clientY, t: performance.now() };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (state.mode !== "drag" && Math.abs(e.clientX - drag.startX) > 6) {
      state.mode = "drag";
      drag.x = drag.startX;
      stage.classList.add("is-dragging");
    }
    const dx = e.clientX - drag.x;
    drag.x = e.clientX;
    if (state.mode === "drag") {
      state.ang += dx * 0.007;
      if (reduced()) renderOnce();
    }
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const wasDrag = state.mode === "drag";
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    drag = null;
    stage.classList.remove("is-dragging");
    if (wasDrag) {
      snapTo(Math.round(state.ang / STEP) * STEP);
    } else if (moved < 6 && e.type === "pointerup") {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(ring.children, true)[0];
      if (hit) {
        let o = hit.object;
        while (o && o.userData.index === undefined) o = o.parent;
        if (o) bringToFront(o.userData.index);
      }
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  const pauseButton = document.querySelector("[data-hero-pause]");
  if (pauseButton) {
    pauseButton.hidden = reduced();
    pauseButton.addEventListener("click", () => {
      state.paused = !state.paused;
      pauseButton.setAttribute("aria-pressed", state.paused ? "true" : "false");
      pauseButton.setAttribute("aria-label", state.paused ? "Resume the slow turn" : "Pause the slow turn");
    });
    motionQuery.addEventListener("change", () => { pauseButton.hidden = reduced(); });
  }
  if (controls) {
    controls.addEventListener("focusin", () => { state.focus = true; });
    controls.addEventListener("focusout", () => { state.focus = false; });
  }

  document.querySelector("[data-hero-prev]").addEventListener("click", () => go(-1));
  document.querySelector("[data-hero-next]").addEventListener("click", () => go(1));

  new IntersectionObserver((entries) => {
    state.visible = entries[entries.length - 1].isIntersecting;
    updateLoop();
  }, { threshold: 0 }).observe(stage);
  document.addEventListener("visibilitychange", () => {
    state.pageVisible = !document.hidden;
    updateLoop();
  });
  motionQuery.addEventListener("change", updateLoop);
  darkQuery.addEventListener("change", () => { syncColors(); renderOnce(); });
  new ResizeObserver(resize).observe(stage);

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    stage.removeAttribute("data-gl");
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    stage.dataset.gl = "on";
    updateLoop();
  });

  resize();
  stage.dataset.gl = "on";
  if (controls) controls.hidden = false;
  updateLoop();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

if (stage && canvas && webglAvailable()) {
  const boot = () => startHero().catch(() => { /* the poster image stays */ });
  const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const start = () => {
    // Only fetch Three.js once the hero is near the viewport.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        whenIdle(boot, { timeout: 1500 });
      }
    }, { rootMargin: "200px" });
    io.observe(stage);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
