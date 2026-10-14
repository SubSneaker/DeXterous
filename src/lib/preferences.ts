/**
 * The connect screen's look: the colour theme (System, Light, Dark) and the Animations switch.
 *
 * Both only set attributes on <html>; src/styles.css does the rest. An inline script in
 * index.html applies the saved choices before the first paint, with the same keys and rules.
 * The site (site/js/main.js) uses the same theme key and values.
 */

import { readStored, removeStored, writeStored } from "./storage";

export type ThemeChoice = "system" | "light" | "dark";
type Motion = "on" | "off";

const THEME_KEY = "dexterous-theme";
const MOTION_KEY = "dexterous-motion";
/** The band colour for the browser's toolbar: oklch(56% 0.2 32) and oklch(41% 0.14 31). */
const THEME_COLOR = { light: "#d02f14", dark: "#861f12" } as const;

const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Whether animations are on right now. Code that waits for an animation checks this first. */
export function motionEnabled(): boolean {
  return root.dataset.motion === "on";
}

// #region Theme

function readTheme(): ThemeChoice {
  const saved = readStored(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function applyTheme(choice: ThemeChoice, options: readonly HTMLElement[]) {
  if (choice === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = choice;
  }

  // Browser chrome: with a forced theme, both theme-color tags carry that theme's colour.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", choice === "system" ? "light dark" : choice);
  for (const mode of ["light", "dark"] as const) {
    document
      .querySelector(`meta[name="theme-color"][media*="${mode}"]`)
      ?.setAttribute("content", THEME_COLOR[choice === "system" ? mode : choice]);
  }

  for (const option of options) {
    const on = option.dataset.themeValue === choice;
    option.setAttribute("aria-checked", String(on));
    option.tabIndex = on ? 0 : -1;
  }
}

/** A radio group of three buttons, like the site's: arrows, Home and End move and select. */
function initThemeSwitch(group: HTMLElement) {
  const options = [...group.querySelectorAll<HTMLElement>("[data-theme-value]")];
  const choose = (option: HTMLElement, focus: boolean) => {
    // The markup only has these three values (index.html).
    const choice = option.dataset.themeValue as ThemeChoice;
    // Storage can be blocked; then the choice lasts until the page closes.
    if (choice === "system") {
      removeStored(THEME_KEY);
    } else {
      writeStored(THEME_KEY, choice);
    }
    applyTheme(choice, options);
    if (focus) {
      option.focus();
    }
  };

  options.forEach((option, index) => {
    option.addEventListener("click", () => choose(option, false));
    option.addEventListener("keydown", (event) => {
      const last = options.length - 1;
      const target = {
        ArrowRight: index === last ? 0 : index + 1,
        ArrowDown: index === last ? 0 : index + 1,
        ArrowLeft: index === 0 ? last : index - 1,
        ArrowUp: index === 0 ? last : index - 1,
        Home: 0,
        End: last,
      }[event.key];
      if (target !== undefined) {
        event.preventDefault();
        choose(options[target]!, true);
      }
    });
  });

  applyTheme(readTheme(), options);

  // Another tab changed the choice.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY || event.key === null) {
      applyTheme(readTheme(), options);
    }
  });
}

// #endregion

// #region Animations

/** On, unless the system asks for reduced motion. */
function defaultMotion(): Motion {
  return reducedMotion.matches ? "off" : "on";
}

function readMotion(): Motion {
  const saved = readStored(MOTION_KEY);
  return saved === "on" || saved === "off" ? saved : defaultMotion();
}

function applyMotion(motion: Motion, toggle: HTMLElement) {
  root.dataset.motion = motion;
  toggle.setAttribute("aria-checked", String(motion === "on"));
}

function initMotionSwitch(toggle: HTMLElement) {
  toggle.addEventListener("click", () => {
    const next: Motion = motionEnabled() ? "off" : "on";
    // An explicit choice, like the site's: it wins over the system setting from now on.
    writeStored(MOTION_KEY, next);
    applyMotion(next, toggle);
  });

  applyMotion(readMotion(), toggle);

  const follow = () => applyMotion(readMotion(), toggle);
  // With nothing saved, the system setting decides and can change while the page is open.
  reducedMotion.addEventListener("change", follow);
  window.addEventListener("storage", (event) => {
    if (event.key === MOTION_KEY || event.key === null) {
      follow();
    }
  });
}

// #endregion

export function initPreferences(elements: { theme: HTMLElement; motion: HTMLElement }) {
  initThemeSwitch(elements.theme);
  initMotionSwitch(elements.motion);
}
