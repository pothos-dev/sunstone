# `sunstone serve` runs the desktop SPA over the HTTP API, trusted on loopback

`sunstone serve [BUNDLE] [--port PORT]` serves the editor to a browser at
`http://localhost:PORT/` (default 3000) instead of opening a window. It is the **desktop**
experience in a browser tab, not Sunstone Web on a laptop:

- **One process, one origin.** The desktop binary links `sunstone-server` as a library and
  calls `serve_local` (`crates/sunstone-server/src/local.rs`): the ordinary API route table
  plus a fallback that serves the static SPA build. There is no SvelteKit Node process and no
  `/api` proxy; the browser talks to axum directly.
- **The desktop frontend, unchanged.** The SPA is the one Tauri embeds into the binary
  (`tauri::Context::assets`); a dev build, which embeds nothing, reads `build/` from disk.
  The server stamps `window.__SUNSTONE_SERVE__` into every `index.html` it serves, and
  `src/lib/ipc/index.ts` selects `http.ts` on that flag. Because `__SUNSTONE_WEB__` is
  false in this build, every desktop behaviour stays: autosave, the tiling layout, history
  navigation, the desktop file-change subscription.
- **A fourth shape, `local`.** It never comes from the environment; only `Config::local`
  builds it. It writes like the desktop does: the file only, **never a commit**. Its history
  reads spawn git wherever the Bundle sits, as the desktop's do, which the plain shape
  deliberately refuses. And it **trusts every request**: `AuthedUser` admits a request with
  no token.

## Why no JWT gate

The gate exists because Sunstone Web is shared: the SvelteKit hook turns an OIDC session
into a token so that axum knows who is writing. `sunstone serve` has one user, the person at
the machine, which is the desktop's trust model, and the desktop has no gate either. In
place of the token:

- the listener binds **127.0.0.1 only**;
- a middleware refuses any request whose `Host` is not `localhost` / `127.0.0.1` / `[::1]`
  (with any port), or whose `Origin`, when sent, names another host. This is what stops
  **DNS rebinding**: a hostile page whose domain re-resolves to 127.0.0.1 counts as
  same-origin to the browser, but it still sends its own domain as `Host`;
- the write routes take JSON bodies (`axum::Json` requires `application/json`), so a
  cross-origin `fetch` needs a CORS preflight, and this server never answers one.

Other users on a shared machine can still reach the port. That is the same exposure as any
local dev server, and it is why this mode stays loopback-only and offers no `--host`.

## Considered options

- **Desktop SPA over the existing API, in the desktop binary (chosen).** Reuses both halves
  that already exist (`http.ts` and the axum routes) and adds no build target. A user who
  installed the desktop app already has it.
- **Run the Sunstone Web stack locally** (SSR Node process plus `sunstone-server`). That
  gives the web reader, not the editor, unless you sign in through OIDC. It needs Node and
  two processes, and it is configured by env.
- **A third Vite target** (`SUNSTONE_TARGET=served`) that compiles `http.ts` in at build
  time. That means another build artifact to ship and keep in step. A runtime flag
  stamped by the server costs one `in` check and keeps the shipped SPA byte-identical.

## Consequences

- `sunstone-server` is now a library plus a thin binary; `serve_from_env` is the old `main`.
  The architecture doc's line "the server serves no static assets" holds for Sunstone Web
  only.
- What the browser cannot do degrades through the existing browser fallbacks
  (`ipc/browserShell.ts`). There is no Launcher, because the Bundle is fixed for the
  process. Print goes to a tab and the browser's own Save-as-PDF. View state lives in
  `localStorage`, per origin, which means per port. Theme colours use the default palette.
