// Applies the user's theme choice before the first paint (no flash of the wrong theme). Loaded as a classic
// same-origin script from index.html (the CSP allows only 'self' scripts, no inline ones). The choice is set in
// the sidebar's user menu (src/lib/theme.ts); «Как в системе» leaves the attribute unset.
(function () {
  try {
    var choice = window.localStorage.getItem("skh.theme");
    if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
  } catch (error) {
    // Storage blocked (private mode, policy): the system theme applies.
  }
})();
