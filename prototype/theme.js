/* Apply the saved appearance before the page paints; use the device theme until one is chosen. */
(() => {
  "use strict";
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const valid = value => value === "light" || value === "dark";
  let preference = null;
  try { preference = localStorage.getItem("story-theme"); } catch (_) { /* Storage may be unavailable. */ }

  function apply() {
    const theme = valid(preference) ? preference : system.matches ? "dark" : "light";
    root.dataset.theme = theme;
    const select = document.getElementById("theme");
    if (select) select.value = theme;
    const color = getComputedStyle(root).getPropertyValue("--bg-app").trim()
      || getComputedStyle(root).getPropertyValue("--bg").trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && color) meta.content = color;
  }

  apply();
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("theme");
    if (select) select.onchange = () => {
      if (!valid(select.value)) return;
      preference = select.value;
      try { localStorage.setItem("story-theme", preference); } catch (_) { /* Still apply for this visit. */ }
      apply();
    };
    apply();
  });
  system.addEventListener("change", () => { if (!valid(preference)) apply(); });
  window.addEventListener("storage", event => {
    if (event.key === "story-theme" || event.key === null) {
      preference = event.newValue;
      apply();
    }
  });
})();
