// Page behavior: tabs, copy buttons, reveal on scroll.
// All styling lives in css/style.css. This file only toggles attributes and classes.
(function () {
  "use strict";

  // ---- Reveal on scroll ----
  var items = document.querySelectorAll(".reveal");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!("IntersectionObserver" in window) || reduce) {
    items.forEach(function (el) { el.classList.add("is-in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }


  // One polite live region announces every copy result.
  var liveRegion = document.createElement("p");
  liveRegion.className = "visually-hidden";
  liveRegion.setAttribute("role", "status");
  document.body.appendChild(liveRegion);

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
        if (label) label.textContent = "Press Ctrl+C";
        liveRegion.textContent = "Copy failed. The command is selected. Press Ctrl+C.";
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

  // "Copy the install command" in the closing section jumps to the top. Focus the copy button there.
  var closing = document.querySelector('.closing a[href="#top"]');
  if (closing) {
    closing.addEventListener("click", function () {
      var target = document.querySelector(".hero .copy");
      if (target) setTimeout(function () { target.focus({ preventScroll: true }); }, 400);
    });
  }
})();
