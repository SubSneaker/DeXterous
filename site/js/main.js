// Page behavior: theme switch, tabs and copy buttons.
// All styling lives in css/style.css. This file only toggles attributes and classes.
(function () {
  "use strict";

  // One polite live region announces every copy result.
  var liveRegion = document.createElement("p");
  liveRegion.className = "visually-hidden";
  liveRegion.setAttribute("role", "status");
  document.body.appendChild(liveRegion);

  // ---- Theme switch ----
  // The choice is "system", "light" or "dark". "system" leaves data-theme off so the CSS
  // follows prefers-color-scheme. An inline script in <head> applies a saved choice before paint.
  var THEME_KEY = "dexterous-theme";
  var THEME_COLOR = { light: "#f0613f", dark: "#8e2c1f" };
  var root = document.documentElement;
  var switcher = document.querySelector("[data-theme-switch]");

  function readTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) { /* storage blocked: follow the system */ }
    return "system";
  }
  function saveTheme(choice) {
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch (e) { /* the choice lasts until the page closes */ }
  }

  function applyTheme(choice) {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);

    // Browser chrome: with a forced theme both theme-color tags carry that theme's colour.
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute("content", choice === "system" ? "light dark" : choice);
    ["light", "dark"].forEach(function (mode) {
      var meta = document.querySelector('meta[name="theme-color"][media*="' + mode + '"]');
      if (meta) meta.setAttribute("content", THEME_COLOR[choice === "system" ? mode : choice]);
    });

    // The hero poster picks its image by media query. Point it at the chosen theme.
    var source = document.querySelector(".hero-stage picture source");
    if (source) {
      source.setAttribute("media", choice === "system" ? "(prefers-color-scheme: dark)" : choice === "dark" ? "all" : "not all");
    }

    if (switcher) {
      var options = switcher.querySelectorAll("[data-theme-value]");
      Array.prototype.forEach.call(options, function (opt) {
        var on = opt.getAttribute("data-theme-value") === choice;
        opt.setAttribute("aria-checked", on ? "true" : "false");
        opt.tabIndex = on ? 0 : -1;
      });
    }

    // The 3D hero listens for this and re-reads its colours.
    document.dispatchEvent(new CustomEvent("dexterous:themechange"));
  }

  if (switcher) {
    var themeOptions = Array.prototype.slice.call(switcher.querySelectorAll("[data-theme-value]"));
    applyTheme(readTheme());
    switcher.hidden = false;

    themeOptions.forEach(function (opt, i) {
      function choose(target, focus) {
        var choice = target.getAttribute("data-theme-value");
        saveTheme(choice);
        applyTheme(choice);
        if (focus) target.focus();
      }
      opt.addEventListener("click", function () { choose(opt, false); });
      opt.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = themeOptions[(i + 1) % themeOptions.length];
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = themeOptions[(i - 1 + themeOptions.length) % themeOptions.length];
        else if (e.key === "Home") next = themeOptions[0];
        else if (e.key === "End") next = themeOptions[themeOptions.length - 1];
        if (next) { e.preventDefault(); choose(next, true); }
      });
    });

    // Another tab changed the choice.
    window.addEventListener("storage", function (e) {
      if (e.key === THEME_KEY || e.key === null) applyTheme(readTheme());
    });
  }

  // ---- Tabs (hero install box and the OS picker) ----
  function setupTabs(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;

    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });

    return select;
  }

  document.querySelectorAll("[data-tabs]").forEach(function (root) {
    var select = setupTabs(root);
    if (select && root.hasAttribute("data-os-tabs")) {
      // Preselect the visitor's system.
      var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "";
      var id = /win/i.test(platform) ? "os-tab-win" : /linux|x11|cros/i.test(platform) && !/android/i.test(navigator.userAgent) ? "os-tab-linux" : "os-tab-mac";
      var tab = document.getElementById(id);
      if (tab) select(tab, false);
    }
  });

  // ---- Copy buttons ----
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "visually-hidden";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    var label = button.querySelector(".copy-label");
    var timer = 0;
    button.addEventListener("click", function () {
      // The text to copy sits on the nearest visible panel.
      var scope = button.closest(".cmd");
      var panel = scope && Array.prototype.find.call(
        scope.querySelectorAll("[data-copy-text]"),
        function (el) { return !el.hidden; }
      );
      if (!panel) return;
      var status = liveRegion;
      copyText(panel.getAttribute("data-copy-text")).then(function () {
        button.setAttribute("data-state", "done");
        if (label) label.textContent = "Copied";
        if (status) status.textContent = "Copied to clipboard";
      }, function () {
        var keys = /mac/i.test(navigator.platform || navigator.userAgent) ? "\u2318C" : "Ctrl+C";
        if (label) label.textContent = "Press " + keys;
        liveRegion.textContent = "Copy failed. The command is selected. Press " + keys + ".";
        var code = panel.querySelector("code");
        if (code) {
          var range = document.createRange();
          range.selectNodeContents(code);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }).then(function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          button.removeAttribute("data-state");
          if (label) label.textContent = "Copy";
          if (status) status.textContent = "";
        }, 2200);
      });
    });
  });
})();
