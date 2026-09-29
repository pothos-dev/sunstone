# 09 — Web write test strategy

Type: grilling
Status: resolved
Blocked by: 07

## Question

The web write path is now specified (ticket 07). Decide how it is **tested**
against the project's four green gates + Playwright, given the seam has a real
`http.ts` and an in-memory `fake.ts`.

Resolve:

- **What the `fake` backend must model.** `fake.ts` is the Playwright/Chromium
  backend. Today its write methods back the desktop specs. For web-write specs it
  must model the *new* behaviours: does the fake need to model **commits** at all
  (e.g. a commit log the spec can assert on), or is committing purely a server
  concern the fake ignores (writes just mutate the in-memory Bundle)? How does the
  fake represent the amend-else-fresh anchor commit (ticket 07 §5) if commits are
  modelled?
- **Where each behaviour is proven.** Split across the gates: pure TS logic
  (`bun test src/lib`) vs Rust unit tests (`cargo test` — the new `git::commit`
  primitive + server orchestration + write classifier, temp-repo pattern) vs
  Playwright (the editor-shell island driving writes end-to-end over the fake).
- **Auth in tests.** The `AuthedUser` extractor / JWT gate (ticket 07 §3) — how do
  the Rust server tests exercise gated routes, and does Playwright (fake backend,
  no real axum) need to simulate auth at all?
- **The desktop↔web asymmetry** (desktop writes without committing; web writes +
  commits) — ensure the shared specs don't wrongly assert commits on the desktop
  target.

Record the decision under `## Answer`.

## Answer

Test the web write path by the **seam**: the frontend never sees a commit (all write
methods return `204`/`RewriteSummary`), so commit correctness lives below the seam in
Rust, client decision-logic lives in pure `.ts`, and the rendered end-to-end path lives in
the **real** web e2e runner. Nothing is faked that the real `http.ts` can't observe.

### Grounding facts (looked up, not assumed)

- **Two Playwright runners already exist and are disjoint by `testMatch`/`testIgnore`:**
  - `playwright.config.ts` — the **desktop suite**: `bun run build && bun run preview`
    (adapter-static SPA) + the in-memory **`fake` backend** on port 1420.
    `testIgnore: /web-viewer\.spec\.ts/`.
  - `playwright.web.config.ts` — the **web e2e suite**: boots the **real
    `sunstone-server` Rust binary** over `tests/fixtures/web-bundle` **+** the real
    adapter-node SSR build (`SUNSTONE_TARGET=web`) proxying `/api`.
    `testMatch: /web-viewer\.spec\.ts/`. Already writes real files to disk to drive the
    live-reload SSE test. **Read-only today; no auth wired.**
- The web chrome (`web-viewer`, the Edit toggle + island, concurrency modals) **only
  renders in the SSR web build**, so it is reachable only under the web e2e runner — never
  in the desktop fake suite.
- `fake.ts` models a `FileChange` subscriber stream + a **canned read-only** commit history
  (`FAKE_COMMITS` / `committedContentAt`) purely for the review-diff UI; it does not create
  commits.

### 1. The fake models NO commit creation

Commits do not cross the seam (`writeConcept`→`204`, `createConcept`→`void`,
`rename`/`move`→`RewriteSummary`), so there is nothing commit-shaped for a fake-backed
Playwright spec to legitimately observe. `fake.ts` web writes just **mutate the in-memory
Bundle + fire `FileChange`**, exactly as today; the existing canned history is untouched
(still feeds the review UI). A live fake commit log would assert on fiction the real
`http.ts` cannot expose. **Commit correctness is Rust's job** (§2).

### 2. Coverage split by gate

| Gate | Owns | Notes |
|---|---|---|
| **`cargo test`** (Rust) | The substance *below* the seam: `git::commit` + amend-else-fresh against a **temp git repo** (assert real `git log` — message templating, `author==committer==OIDC identity`), server write-route orchestration + **global-write-lock** serialization, the write **error classifier** (400/404/409/500), and the **`AuthedUser` JWT extractor**. | Temp-repo pattern `git.rs` tests already use. This is where commits + the auth gate are *really* proven. |
| **`bun test src/lib`** (pure TS) | Client **decision logic**, extracted to plain `.ts` per the repo's "pure logic in `.ts`" convention: ticket 08 **path-match routing** (active-path→buffer flow / other-path→refresh / removed-active→"deleted by X"), **clean→reload vs dirty→modal**, the **three-way** leave/structural-op branch, and the per-tab **`clientId` echo filter**. Plus extending `http.test.ts` for write-method request shaping + write-error→message mapping. | `.svelte`/`.svelte.ts` stay thin over these helpers so they are unit-testable. |
| **Web e2e** (`playwright.web.config.ts`, extended) | The **rendered end-to-end** path: a test-authed user toggles Edit, edits, Saves → a **real commit lands** in the fixture repo (assert via history/`git log`); a **second client's** real edit drives the clean-silent-reload / dirty-conflict modal over **real SSE**. | Fixture Bundle `tests/fixtures/web-bundle` becomes a **real git repo**. The `/api` hook→JWT→axum chain is exercised transitively (if the Save commits, the chain worked). |
| **Desktop fake suite** (`playwright.config.ts`) | Unchanged — the desktop `Tile.svelte` editor. Only new duty: the asymmetry stays structurally guarded (§4). | |

**Rejected alternative:** teaching the web SSR build to accept the `fake` backend so the
concurrency UI could run in the lightweight desktop suite. That is a **new seam** (a fake
path in the web target); the e2e runner already does real disk writes + SSE, so writes +
commits are a natural extension, not new machinery.

### 3. Auth in tests

- **Rust (`cargo test`)**: the extractor verifies an **HS256 JWT** against a shared-secret
  env var, so tests **mint a JWT with the test secret** and set `Authorization: Bearer …`
  directly. Valid→200; missing/expired/tampered→**401**. **No OIDC, no Auth.js needed** —
  the faithful home for the gate itself.
- **Web e2e (Playwright)**: a **test-only, env-gated Auth.js Credentials provider** (e.g.
  enabled by `SUNSTONE_TEST_AUTH=1`, **off in every real build**) yielding a fixed identity.
  Playwright logs in through the **real sign-in flow**, so the whole chain *we own* runs
  live: real session cookie → real CSRF (Origin + `SameSite`) → real hook JWT-mint + forward
  → real axum verify → real write + commit → real SSE. **Unauthed** (no Edit toggle, 401 on a
  raw write) is reached by simply **not logging in**.
  - Rejected: **injecting a pre-baked session cookie** (couples tests to Auth.js internal
    cookie/JWT format + secret — brittle); a **hook bypass flag** that fabricates a user
    (skips the session→hook seam we own; can't reach the unauthed branch without
    reconfiguring the server).
- **Stays deployment fog** (unchanged on the map): the real **OIDC/Dex provider wiring** —
  provider-specific config, not our logic.
- **Risk to manage:** the test Credentials provider must be **env-gated** so it can never
  ship enabled.

### 4. Desktop↔web asymmetry — below the seam, structurally guarded (no explicit guard)

The asymmetry (**desktop writes without committing; web writes + commits**) lives **entirely
below the seam**. `writeConcept` returns `204/void` on both targets; the commit is pure
server-side orchestration (ticket 07 §2), invisible to the frontend. The ticket 06 island
reuses `Tile.svelte` and only swaps the `http` backend behind the seam — **Save is identical
client code on both targets**. There is **no commit method on the seam**, so no frontend or
shared spec can *express* a commit assertion. Combined with §1 (fake has no commit log) and
the disjoint runner split (§2), a commit assertion is **only expressible in the web e2e
runner** (real git). Therefore **no special asymmetry guard is needed**.

The one affirmative practice is organizational: put new web-write behavioural specs in their
**own web-matched spec files** (`web-write.spec.ts`, `web-concurrency.spec.ts`, …) and
broaden the web runner's `testMatch` (and the desktop runner's `testIgnore`) from the single
`web-viewer\.spec\.ts` to a **`web-*.spec.ts`** pattern — keeping the disjoint split as the
guard.

### Consequence: the map's decision route is complete

Ticket 09 was the last open decision ticket. With it resolved, **every locked-scope decision
is pinned**; what remains is implementation (the "build/handoff" fog items) + genuinely
operator-dependent deployment fog. A `docs/testing.md` capturing how to run each gate is
written as part of this resolution and referenced from `AGENTS.md`.
