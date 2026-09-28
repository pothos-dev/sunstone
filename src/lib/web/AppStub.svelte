<!--
  Web-build SSR stub for `$lib/App.svelte`.

  `App.svelte` is the desktop shell (CodeMirror, the full editor, the write
  path) and statically imports browser-only code, so it must never enter the
  SSR graph: on the web build's SSR pass ONLY, `vite.config.js` resolves
  `$lib/App.svelte` to THIS empty component. The CLIENT pass resolves the real
  App, which `WebAppShellIsland` lazy-loads for a signed-in user. Routing goes
  through `PageShell` (`src/lib/PageShell.svelte`), which renders `WebViewer`
  on the web build.
-->
