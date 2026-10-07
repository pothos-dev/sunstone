# `sunstone serve` runs the desktop SPA over the HTTP API, trusted on loopback

`sunstone serve [BUNDLE] [--port PORT]` serves the editor to a browser at
`http://localhost:PORT/` (default 3000) instead of opening a window. It is the **desktop**
experience in a browser tab, not Sunstone Web on a laptop:

- **One process, one origin.** The desktop binary links `sunstone-server` as a library and
  calls `serve_local` (`crates/sunstone-server/src/local.rs`): the ordinary API route table
  plus a fallback that serves the static SPA build. There is no SvelteKit Node process and no
  `/_api` proxy; the browser talks to axum directly.
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

- the listeners bind **loopback** by default: 127.0.0.1, plus `[::1]` when the machine has
  IPv6;
- a middleware refuses any request whose `Host` is not `localhost` / `127.0.0.1` / `[::1]`
  (with any port) or a name passed with `--allow-host`, or whose `Origin`, when sent, names
  another host. This is what stops **DNS rebinding**: a hostile page whose domain re-resolves to 127.0.0.1 counts as
  same-origin to the browser, but it still sends its own domain as `Host`;
- the write routes take JSON bodies (`axum::Json` requires `application/json`), so a
  cross-origin `fetch` needs a CORS preflight, and this server never answers one.

Other users on a shared machine can still reach the port. That is the same exposure as any
local dev server.

### Behind a reverse proxy (amended)

The loopback-only version could not sit behind a reverse proxy: the proxy forwards the
public name as `Host` and the page's `https://` origin as `Origin`, and the guard refused
both. The workaround was a second proxy that rewrote both headers to `localhost`, which
turned the guard off entirely. Two opt-in flags replace it:

- `--allow-host NAME` (repeatable) adds exact host names to the trusted set. `Origin` may
  then be `http://` or `https://`. Any other name still gets a 403, so DNS rebinding stays
  closed: the attacker's domain is not on the list.
- `--bind ADDR` listens on another address, for a proxy that cannot reach loopback (e.g. a
  container on a Docker bridge). The binary warns when ADDR is not loopback.

Neither flag adds a sign-in. Whoever can reach the proxy can edit the Bundle, so access
control belongs in the proxy.

## Deep links to a Concept (amended)

The desktop window takes a Concept on the command line
(`sunstone ./docs guide/setup.md#install`); the browser tab had no way to name one. The
page URL now does that job, in the same scheme Sunstone Web uses, so a link works against
either:

| URL | Opens |
|-----|-------|
| `/guide/setup` | `guide/setup.md` (the pretty URL, `concept_url` / `url_to_concept`) |
| `/guide` | `guide/index.md`, which wins over a `guide.md` |
| `/guide/setup.md` | `guide/setup.md` (the Bundle path, as copied from the repo) |
| `…#install` | the same, scrolled to the `install` heading |
| `/` | nothing: the restored layout stands |

- **The startup-Document seam carries it.** `http.ts`'s `takeStartupDocument` reads
  `location` and resolves it (`ipc/servedStartup.ts`), and `App.svelte` opens the result
  into the restored active Tile exactly as it opens a command-line Document. The other
  Tiles are left alone. A URL with no Concept behind it opens nothing and shows
  "No Concept at /guide/nope".
- **The server routes `.md` paths to the SPA.** The app-shell fallback used to 404 any
  last segment with an extension; a `.md` one now gets `index.html` like an extensionless
  route. Other missing files still 404.
- **The address bar follows the active Tile.** `App.svelte` writes the active Tile's pretty
  URL with SvelteKit's `replaceState`, so a copied URL is a deep link and a reload lands
  back on it. It replaces and never pushes: each Tile has its own Back/Forward, and browser
  history entries would fight them. That conflict is why the web build allows a single
  Tile, and serve mode keeps the tiling layout.
- **The API moved from `/api` to `/_api`.** Under `/api` a Concept in a top-level `api/`
  folder had no URL: the fallback 404s unrouted API paths on purpose (a client calling a
  route that does not exist should get an error, not a page), and Sunstone Web's proxy
  claims the whole prefix. The underscore sits beside SvelteKit's own `/_app/`. Concepts
  under `_api/` or `_app/` still cannot be linked by path.
- **Root only.** The SPA is built for `/`: its assets load from `/_app/…`, the backend
  fetches `/_api/…`, and Concept URLs start at `/`. Behind a proxy that mounts it under a
  subpath (`https://host/notes/`), every one of those requests misses. Give it its own
  host name or port instead.

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
  `localStorage`, keyed by Bundle root, because one port can serve different Bundles over
  time. Theme colours use the default palette.
