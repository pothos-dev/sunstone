# Enable writing on the web

## Destination

Sunstone Web today is **read-only by design** — the axum `sunstone-server` exposes
only read routes, `http.ts` hard-rejects every write with `READ_ONLY`, and the web
UI (`src/lib/web/`) is a server-rendered HTML *viewer*, not the CodeMirror editor.

The destination: **a handful of authenticated users can edit a shared Bundle from
the browser using the real CodeMirror editor, with edits persisted as git commits.**
Locked scope (from the charting grill):

- **Writers/auth:** few *known, authenticated* users, all editing the same Bundle.
  No per-user branching, no realtime merge.
- **Editing surface:** bring the real desktop CodeMirror + atomic-editor editor to
  the web (parity), not a lightweight textarea.
- **Persistence:** **git-backed** — writes land, then commit. **Explicit
  save/commit only** (a Save action), *not* per-autosave — no commit storm.
- **Concurrency:** **last-write-wins + live refresh** — the existing SSE broadcast
  warns/reloads a stale buffer. No locking, no merge.
- **Write scope:** edit Concept body + frontmatter; full Tree CRUD (create / rename
  / move / delete); anchor & link rewrite on rename — all mirrored server-side with
  commits.

The map is done when every decision above is pinned precisely enough that a builder
can implement web writing without further design choices.

## Notes

- **Domain:** read `docs/GLOSSARY.md` (Bundle, Concept, Wikilink, Region, …) and use those
  terms. `ARCHITECTURE.md` is the implementation contract — the **IPC seam**
  (`src/lib/ipc/backend.ts` + `tauri.ts` / `fake.ts` / `http.ts`) is central: every
  write method already exists on the `Backend` interface; the web just rejects them.
- **Key existing pieces:** `crates/sunstone-server/src/main.rs` (read-only axum),
  `src/hooks.server.ts` (`/api` proxy → axum), `src/lib/web/*` (viewer UI),
  `svelte.config.js` (`SUNSTONE_TARGET=web` → adapter-node + SSR). A git seam
  already exists (`fileHistory` / `fileAtRev` via the system `git` binary).
- **Skills:** use `/grilling` + `/domain-modeling` for decision tickets, `/prototype`
  for the editor-shell ticket, `/research` (subagent) for research tickets.
- Every change must keep the four green gates (see `AGENTS.md`): `bun test src/lib`,
  `bun run check`, `cargo test`, `cargo check`.

## Decisions so far

<!-- one line per resolved ticket; zoom the link for detail -->

- [Research: auth approaches](issues/01-research-auth-approaches.md) — recommend GitHub
  OAuth via `@auth/sveltekit` (in-process cookie session), enforced in the `/api` hook,
  forwarding a trusted identity header to a **loopback-bound** axum; GitHub email+name =
  git author. Bearer token as CLI/bot secondary. Lucia is deprecated — avoid.
- [Research: git commit/push from server](issues/02-research-git-commit-push-from-server.md)
  — keep the **system `git` CLI** (already used in `sunstone-core/src/git.rs`); per-Save
  `git add`+commit with per-request `GIT_AUTHOR_*` / fixed committer, serialized behind
  one mutex (shared `index.lock`), push deferred (`GIT_TERMINAL_PROMPT=0` + deploy key);
  server **must** call `AppState::note_self_write` or its Save echoes over SSE.
- [Research: CodeMirror under SvelteKit SSR](issues/03-research-codemirror-under-sveltekit-ssr.md)
  — keep the SSR read view; mount the editor as a client-only island (`onMount` +
  **dynamic** `import('$lib/editor/cm')` into a `bind:this` host) so atomic-editor / CSS
  never enter the SSR graph. Don't drop SSR per-route.
- [Auth & git-identity model](issues/04-auth-and-git-identity-model.md) — **provider-agnostic
  OAuth/OIDC** via `@auth/sveltekit` (any provider giving name+email; Dex fronts LDAP/password).
  Reads open, **writes gated at the `/api` hook**, which mints a per-request ~60s **HS256 JWT**
  that **axum verifies itself** (axum self-defends; loopback now optional defense-in-depth).
  Commit **author = committer = OIDC name+email**. Authz = **trust the (operator-scoped)
  provider**, no app allowlist. CSRF via SvelteKit Origin check + `SameSite`/`HttpOnly` cookie
  + Auth.js `skipCSRFCheck`.
- [Git persistence & commit model](issues/05-git-persistence-and-commit-model.md) —
  **one Concept = one commit**, templated per-op messages (`edit/create/rename/move/delete
  <path> via web`). Text edits buffer until Save; **Tree CRUD commits immediately** (rewrites
  folded in). Structural op requires a **clean active buffer** — if dirty, a **confirm dialog**
  flush-commits it first (2 commits), **cancel aborts both**; editor holds **≤1 dirty buffer**.
  System `git` CLI extending `git.rs`; **author=committer=OIDC identity** via `GIT_*` env
  (overrides ticket 02's fixed committer); `note_self_write` on every written path. **One global
  write lock** wraps the whole write→rewrite→add→commit critical section; conflicts are
  last-write-wins (SSE warn/reload is separate). **Push/pull out of scope** (deployment-level).
- [Web editor shell](issues/06-web-editor-shell.md) — keep `WebViewer`'s SSR read chrome;
  add a **viewer-default + Edit toggle** (Edit shown to authed users only, swaps the CENTER
  article for the editor in place, Done/Save returns to rendered view). Mount the existing
  desktop **`Tile.svelte`** editor as a **client-only dynamic-`import()` island** — the island
  (`WebEditorIsland`) wraps the *whole* `Tile` (it statically imports CM/atomic-editor), keeping
  it out of the SSR graph (ticket 03). Not full `App.svelte`, not a from-scratch shell. Reuse is
  real but needs scaffolding: `Tile` couples to the `workspace` model + `focus`/`index`/`session`/
  `suggestions`/`theme`/`treeActions` stores, so the island constructs a **single-Tile** workspace
  state + stubs desktop-only affordances (region/tile-split). `cm.ts` drives unchanged, only the
  `http` backend swapped behind the seam. One Concept at a time (matches ≤1 dirty buffer).
- [Server write-route surface](issues/07-server-write-route-surface.md) — **RESTful-per-method**
  write routes mirroring the seam 1:1 (`PUT /api/concept`=overwrite, `POST /api/concept`=create,
  `POST /api/folder|rename|move`, `DELETE /api/concept?path=`, `POST /api/rewrite-anchors`); each
  **write-then-commits immediately** (no server-side pending Save) under **one global write lock**
  on a blocking thread. Auth = **`AuthedUser` axum extractor** verifying the hook-minted JWT
  (reads stay open); the `/api` hook forwards method+body+`Bearer` on writes. Commit **primitive**
  extends core `git.rs` (reuse `run_git`); all **orchestration is server-side**; core writers stay
  commitless. `rewriteAnchors` is **editor-driven by necessity** (backend can't infer heading
  renames from content) and **amends the preceding `edit … via web` commit** iff HEAD subject+author
  match, else fresh `relink … via web` (safe — local-only, no push). **Self-write suppression already
  wired** in the shared watcher; write path just `note_self_write`s every written path.
  `saveBundleState` **off the surface** (it's *View state*, browser-held — glossary mismatch flagged).
  Write **error classifier** separate from reads: 400 bad-path / 409 exists / 404 missing / 500
  server / 401 from the extractor.
- [Web write concurrency UX](issues/08-web-write-concurrency-ux.md) — client-side
  last-write-wins. **Echo suppression revised** (ticket 07's global `note_self_write`
  drops the SSE event for *all* subscribers, killing multi-user live refresh): web
  writes **don't** `note_self_write`; instead `FileChange` grows
  `origin: {clientId, author.name}`, server stamps it, each browser drops its **own**
  `clientId` echo (clientId per-tab, in-memory) — gains write attribution + realtime hook.
  Detection = **path-match routing** (active-path change → buffer flow; other paths →
  refresh tree/backlinks/tags only; `removed` active path → "deleted by X" state, dirty
  buffer recreatable via Save; remote rename reads as delete). Flow: **clean → silent
  reload + "Updated by X"** notice; **dirty → blocking modal** ([Discard & reload] /
  [Keep mine → next Save overwrites], re-raises on repeat, no diff/merge). Leaving a
  dirty buffer: in-app exits → **three-way Save/Discard/Cancel** modal; tab close →
  `beforeunload` guard; ticket 06 toggle = **Done when clean / Save when dirty**.
  Structural-op-while-dirty (rename/move/delete) → **three-way Save & continue / Discard
  & continue / Cancel** (adds Discard to ticket 05); **create exempt** from the gate.
- [Web write test strategy](issues/09-web-write-test-strategy.md) — test by the **seam**.
  **Fake models no commits** (invisible at the seam; web writes just mutate + fire
  `FileChange`). Split: **`cargo test`** owns commits (`git::commit` + amend-else-fresh vs a
  temp repo, orchestration, global lock, error classifier, `AuthedUser` JWT extractor);
  **`bun test src/lib`** owns pure client logic (ticket 08 path-match routing, clean/dirty +
  three-way branching, `clientId` echo filter; http write shaping); the **real web e2e
  runner** (`playwright.web.config.ts`, extended — fixture Bundle becomes a **real git repo**)
  owns the rendered end-to-end write + a **real commit landing** + multi-client concurrency
  modals over real SSE. Auth: **Rust mints JWTs directly** with the test secret; e2e uses a
  **test-only env-gated Auth.js Credentials provider** (real session→hook→JWT→axum chain;
  unauthed = don't log in). Desktop↔web asymmetry is **below the seam** → no explicit guard,
  just the disjoint runner split + **`web-*.spec.ts`** file convention. **OIDC/Dex wiring
  stays deployment fog.**

## Not yet specified

<!-- in-scope fog; graduates into tickets as the foundational decisions resolve -->

**No open decision tickets remain — the map's decision route is complete.** Every
locked-scope decision (tickets 01–09) is pinned; what is left is implementation
(the "build/handoff" items below) plus genuinely operator-dependent deployment fog.

Still genuinely foggy (operator-dependent, not yet sharp enough to ticket):

- **Deployment / ops** — self-hosted always-on server, Bundle-as-git-repo assumptions,
  how the Node SSR process and the axum server are run together, and provisioning the
  **JWT shared secret + OIDC provider** (ticket 04's Dex-fronts-known-users shape).

**Now fully specified → build / handoff** (no decisions left — *not* decision tickets;
implementation work spec'd by tickets 07 + 04 + 05):

- **`http.ts` write implementation** — mirror ticket 07's route table on the seam, drop
  the `READ_ONLY` rejections.
- **Server write routes + Tree CRUD over HTTP** — implement ticket 07's table
  (`bundle`/`rewrite` writers + the new `git::commit` primitive under the global lock).
- **`/api` proxy write-forwarding** — `hooks.server.ts` forwards method+body+`Bearer` JWT
  on writes (ticket 07 §3); reads unchanged.
- **SSE origin stamping + client echo filter** (ticket 08 §1) — add `origin: {clientId,
  author.name}` to `FileChange`; web write path **drops** `note_self_write` and stamps the
  broadcast with the forwarded `clientId` + OIDC identity; client mints a per-tab clientId,
  forwards it on writes, and filters incoming events whose `clientId` is its own. Desktop
  path keeps `note_self_write` unchanged.
- **Concurrency-UX shell wiring** (ticket 08 §2–5) — path-match routing of `onFileChanged`,
  the clean-silent-reload / dirty-conflict-modal, the leave-dirty three-way modal +
  `beforeunload` guard, and the structural-op-while-dirty three-way modal, all in ticket
  06's single-Tile island.
- **Test suites** (ticket 09) — `cargo test` for `git::commit`/amend + orchestration + lock
  + error classifier + `AuthedUser` (mint JWTs directly); `bun test src/lib` for the extracted
  concurrency-UX decision logic + `clientId` echo filter + http write shaping; extend
  `playwright.web.config.ts` (fixture Bundle → real git repo; `testMatch` → `web-*.spec.ts`)
  with `web-write` / `web-concurrency` specs gated by the env-only Auth.js Credentials provider.
  Docs: `docs/testing.md` (how to run each gate), referenced from `AGENTS.md`.

## Out of scope

<!-- ruled beyond the destination; never graduates unless the destination is redrawn -->

- **Real 3-way merge / CRDT collaborative editing** — explicitly excluded; concurrency
  is last-write-wins only.
- **Realtime multi-cursor / presence** beyond the last-write-wins refresh.
- **Per-user roles / fine-grained permissions** — all authenticated users can edit
  everything (few known users).
- **Multi-Bundle / Bundle switching on the web** — the server serves one fixed Bundle.
- **Offline / PWA editing.**
- **Remote push / pull from the server** ([ticket 05](issues/05-git-persistence-and-commit-model.md))
  — the server commits **locally only**; syncing the Bundle repo to a remote (backup, replication)
  is a deployment-level concern, not part of the web write path. Returns as a fresh effort if
  in-API push is ever needed.
- **CLI/bot web write path** ([ticket 04](issues/04-auth-and-git-identity-model.md) §8) —
  automation clones the git repo and commits/pushes via normal git, so the web write API
  needs no machine credential; axum accepts only the hook-minted JWT. Returns as a fresh
  effort if a bot ever needs the API.
