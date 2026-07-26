# Deploying Sunstone Web

Sunstone Web is the server-rendered viewer/editor for an OKF Bundle. Sunstone has
an authenticated write path (JWT + Auth.js); the **base deployment here runs it
read-only**, a dev-only
**[writable stack with Dex OIDC](#local-dev-writable-stack-with-dex-oidc)** unlocks
the full editor locally, and a
**[git-synced wiki stack](#serving-a-git-backed-wiki)** runs it writable *and*
continuously reconciled with a git remote — see the security note below. It ships
as a **single Docker image** that runs two processes side by side:

- **`sunstone-server`** — the Rust API (axum over `sunstone-native`), serving
  `/api/*` (tree, concept, render, search, backlinks, tags, history, SSE events)
  over the Bundle. Its write routes require a JWT signed with
  `SUNSTONE_JWT_SECRET`; the base image sets no such secret, so every write
  returns `401` and the API is effectively read-only. In the **git-synced** shape
  this process also runs the **[sync loop](#the-sync-loop-third-moving-part)**.
- **`node build`** — the SvelteKit **adapter-node** SSR server. It renders pages,
  hydrates in the browser, and proxies `/api/*` to the Rust API (see
  `src/hooks.server.ts`). This is the single public origin.

> This is separate from the **desktop** release flow (the `/deploy` skill, which
> tags a version and lets GitHub Actions build the Tauri installers). Deploying
> the web viewer does not touch versions, tags, or the desktop artifacts.

The Dockerfile and this guide live at the repo root and in this `docker/` folder;
the compose files (`docker-compose*.yml`) sit at the repo root. Commands below run
**from the repo root** unless noted.

> ## ⚠️ Unauthenticated reads — internal networks only
>
> This container serves **reads with no authentication** of any kind. Anyone who
> can reach the published port can read the entire Bundle. (Sunstone's write path
> is JWT-authenticated, but this image sets no write secret and wires in no auth
> provider — see above.) You **must**:
>
> - keep it on a trusted internal network / VPN, or behind a private reverse proxy
>   that enforces access control, and
> - **never** expose the published port directly to the public internet.
>
> Because the mount is read-only and no write secret is set, exposure is a
> confidentiality risk (the Bundle can be read), not an integrity one (it cannot
> be modified through the app).

## The three deployment shapes

One image, three shapes. The server derives its shape from the **presence of any
`SUNSTONE_GIT_*` variable** — there is no mode flag (`SUNSTONE_GIT_MODE` was
proposed, never shipped, and must not appear anywhere).

| Shape | Env signature | Bundle root | Save does | Loop | Compose file |
| --- | --- | --- | --- | --- | --- |
| **plain** | no `SUNSTONE_GIT_*` at all | `SUNSTONE_BUNDLE` (bind mount) | write the file, **no git** | — | `docker-compose.yml`, `docker-compose.remote.yml` |
| **git-local** | `SUNSTONE_GIT_BRANCH` only | `/srv/repo[/<subdir>]` | commit locally | — | `docker-compose.dex.yml` |
| **git-synced** | branch + `SUNSTONE_GIT_ORIGIN` + key | `/srv/repo[/<subdir>]` | commit | fetch → rebase → push | `docker-compose.wiki.yml` |

`SUNSTONE_GIT_BRANCH` has **no default** and is **required** as soon as any git
variable is set. That explicit declaration is what prevents a mounted repository
subdirectory from silently starting to commit.

Malformed git configuration makes the container **refuse to boot**, reporting
every problem at once (see the [strict/lenient
column](#environment--volume-reference)). Under `restart: unless-stopped` that is
a crash loop rather than a friendly error — deliberately, because the alternative
is a wiki that serves perfectly, commits nothing, and accumulates edits in a
volume classed as a disposable cache.

> ### ⚠️ An empty value means *unset* — the silent-downgrade trap
>
> `VAR=` is treated exactly like an absent variable, uniformly across the whole
> surface (so a blank line in an env file means "default", not "crash"). The trap
> that follows is documented, not fixed: **`SUNSTONE_GIT_ORIGIN=` silently
> downgrades a git-synced deployment to git-local.** The container comes up, the
> wiki serves, every Save commits happily — and nothing is ever pushed anywhere.
>
> So the prescribed post-deploy check is to confirm the shape actually took
> effect:
>
> ```bash
> curl -s localhost:3000/api/sync-status
> # {"shape":"git-synced","lastFetchOk":true,"lastPushOk":true,
> #  "pendingCommits":0,"lastSyncAgeSecs":3}
> ```
>
> `GET /api/sync-status` is unauthenticated and deliberately **content-free** —
> booleans, counts, an age and the shape, never an error string, remote URL or
> branch name (diagnostic detail lives in `docker logs`). It is **not** a
> healthcheck: an unreachable remote must not mark the container unhealthy,
> because offline tolerance is by design and a restart fixes nothing.
> `pendingCommits` is the number to alert on — it is literally how much web work
> exists only inside this container.

## Quick start (docker compose)

From the repo root:

```bash
# Serve the Bundle at /srv/okf/my-bundle on host port 8080:
SUNSTONE_BUNDLE_HOST=/srv/okf/my-bundle SUNSTONE_WEB_PORT=8080 \
  docker compose up --build -d

# Then open http://<internal-host>:8080/
```

Two knobs, both with sane defaults:

| Variable               | Default      | Meaning                                     |
| ---------------------- | ------------ | ------------------------------------------- |
| `SUNSTONE_BUNDLE_HOST` | `./examples` | Host path of the Bundle directory to serve. |
| `SUNSTONE_WEB_PORT`    | `3000`       | Host port the web viewer is published on.   |

The Bundle is bind-mounted **read-only** (`:ro`) into the container at `/bundle`,
and `SUNSTONE_BUNDLE=/bundle` points the server at it. The container cannot write
to your Bundle even if it tried.

Stop it with `docker compose down`.

## What runs inside the container

Two processes and — in the **git-synced** shape only — a third moving part inside
the second one:

| Moving part | Port (in container) | Env |
| --- | --- | --- |
| SSR web (node) | `3000` (published) | `HOST=0.0.0.0`, `PORT=3000` |
| Rust API (axum) | `8787` (internal) | `SUNSTONE_BUNDLE=/bundle`, `SUNSTONE_API_PORT=8787` |
| **Sync loop** (tokio task *inside* the Rust API) | — (outbound git/ssh only) | `SUNSTONE_GIT_*` — spawned **only** when the shape is git-synced |

The web process reaches the API over container loopback via
`SUNSTONE_API_INTERNAL=http://localhost:8787`. Only the web port is published;
the API port stays private to the container.

The container runs **non-root, as uid/gid 1000**. Two paths exist in the image
already chowned to that user: `/srv/repo` (the clone) and `/srv/ssh` (the deploy
key + `known_hosts`). Both are **constants, not knobs** — Docker copies an image
directory's owner onto a freshly created named volume, which is what makes the
`repo` volume writable **by construction**, with no chown step at boot and nothing
running as root.

`docker/entrypoint.sh` is PID 1: it starts the API in the background, starts the
node server, forwards `SIGTERM`/`SIGINT` to both, and — via `wait -n` — exits the
whole container as soon as **either** process dies. `restart: unless-stopped`
(compose) then restarts the container, and `init: true` reaps zombies. So a crash
of either half brings the container down cleanly rather than leaving it
half-serving. The entrypoint does **no** git work: the server owns `git init`, the
clone, the seed commit and the optional seed copy, because only the server knows
where the Bundle root actually is in a git shape.

## Live reload & concurrent viewers

The API exposes `/api/events` as a Server-Sent Events stream fed by the
filesystem watcher; the SSR proxy streams it through un-buffered. Any number of
browsers can view the same container concurrently, and an external edit to the
Bundle on the host is pushed to every connected viewer.

The watcher attaches to the Bundle root's inode(s) at startup, so live reload
only fires when edits are written **in place under a stable path**. Anything that
swaps a symlink to a fresh directory per update leaves the watcher pinned to the
old (soon deleted) inode and will **not** live-reload — which is why nothing in
this repo does that any more.

### The sync loop: third moving part

In the **git-synced** shape the watcher has a third source of events beside "a
human edited the host folder" and "someone Saved in the browser": the server's own
**sync loop**, which rewrites files in place as it integrates what it fetched from
origin. It deliberately broadcasts nothing of its own, so an inbound change arrives
as an ordinary, unattributed `FileChange` that every client already knows how to
render — a clean buffer silently reloads with an "Updated on disk" notice, a dirty
one raises the discard-vs-keep modal, and anything else refreshes the tree (which
is how a [fork](#conflicts-nothing-ever-blocks) appears).

- **Outbound is immediate**: a Save kicks the loop rather than waiting for the next
  tick, so a collaborator's browser is not gated on the poll interval.
- **Inbound is up to one interval** (`SUNSTONE_GIT_SYNC_INTERVAL_SECS`, default
  `10`) — discovering an external `git push` is inherently a poll.
- Events under a **dot-prefixed path component** are dropped before indexing and
  before the SSE stream, so the in-tree `.git` directory generates no traffic.
- Accepted cost: a rebase replaying N commits writes each path once per commit, so
  a client can briefly see intermediate content and receive a redundant notice
  before the run converges. For the normal 0–2 commit tick the window is
  sub-second.

See [Serving a git-backed wiki](#serving-a-git-backed-wiki) for the stack that
turns this on.

## Building the image directly (without compose)

```bash
docker build -t sunstone-web:latest .
docker run --rm -p 3000:3000 \
  -v /srv/okf/my-bundle:/bundle:ro \
  -e SUNSTONE_BUNDLE=/bundle \
  sunstone-web:latest
```

## Image layout (multi-stage build)

1. **`rust-build`** (`rust:1-bookworm`) — `cargo build --release -p sunstone-server`.
   `src-tauri` is a workspace member, so its manifest is present, but it is
   stubbed and never compiled (no Tauri deps are pulled).
2. **`web-build`** (`oven/bun:1`) — `bun install` then
   `SUNSTONE_TARGET=web bun run build` (adapter-node → `build/`), then a pruned
   production `node_modules` for the externalized runtime deps (e.g. `yaml`).
3. **`runtime`** (`node:22-bookworm-slim`) — the `sunstone-server` binary, the
   `build/` output, the production `node_modules`, and the entrypoint. `bookworm`
   on both build and runtime keeps glibc compatible.

---

# Local dev: writable stack with Dex OIDC

[`../docker-compose.dex.yml`](../docker-compose.dex.yml) is a **self-contained
local-dev stack** that brings up a **writable** Sunstone Web behind an
already-running Traefik, authenticated by a [Dex](https://dexidp.io/) OIDC provider
seeded with two test users. It is the **git-local** shape (`SUNSTONE_GIT_BRANCH: main`
and no origin): unlike the read-only base deployment above, a real OIDC login
unlocks the full editor and every Save lands a git commit — locally, with no push
and no sync loop. It is **dev-only**:
all secrets, passwords and hashes are committed fixtures — never use it for a
real/public deployment.

```bash
docker compose -f docker-compose.dex.yml up --build -d   # bring up
docker compose -f docker-compose.dex.yml down            # tear down
```

| URL | What |
| --- | --- |
| `http://sunstone.docker.localhost` | the app (click **Sign in** → OIDC) |
| `http://dex.docker.localhost` | the OIDC issuer / login |

Seeded users (Dex `staticPasswords`):

| Email | Password | Name |
| --- | --- | --- |
| `alice@sunstone.test` | `alice-password` | Alice Example |
| `bob@sunstone.test` | `bob-password` | Bob Example |

OIDC client: id `sunstone-web`, secret `sunstone-oidc-secret`, redirect
`http://sunstone.docker.localhost/auth/callback/oidc`.

## The issuer must resolve identically both ways

The issuer `http://dex.docker.localhost` has to mean the *same* origin from the
browser (redirect) **and** from the Sunstone SSR container (discovery + token
exchange):

- Dex listens on plain HTTP `:80` (`web.http: 0.0.0.0:80` in
  [`dex/config.yaml`](dex/config.yaml)).
- The Dex service has a **network alias `dex.docker.localhost` on `traefik-net`**,
  so Sunstone resolves `http://dex.docker.localhost/...` straight to Dex:80.
- A Traefik label routes Host `dex.docker.localhost` → Dex:80, so the browser
  reaches the same issuer via Traefik.

`@auth/core` (via `oauth4webapi`) already allows a plain-HTTP issuer for OIDC
discovery/token/userinfo — it passes `allowInsecureRequests: true` on those
calls — so no extra flag is needed for the `http://` dev issuer. `AUTH_TRUST_HOST`
+ `ORIGIN`/`PROTOCOL_HEADER`/`HOST_HEADER` handle host validation behind Traefik.

## Bundle is a container-local git copy (host `docs/` is never written)

The image bakes the repo's `docs/` in at `/bundle-src`, and the **server's** seed
step (`SUNSTONE_BUNDLE_SEED_FROM=/bundle-src`) copies it into the git-shape Bundle
root — `/srv/repo`, plain container filesystem here, with no named volume — then
`git init`s it and lands a seed commit authored by the sync identity. Edits/Saves
commit **there**, authored by the logged-in OIDC identity (`edit <path> via web`,
`Alice Example <alice@sunstone.test>`). The host `docs/` is **isolated and never
modified**, and the repo is deliberately ephemeral: `down`/recreate reseeds from the
baked-in docs. Add a named volume on `/srv/repo` if you want a dev's history to
survive.

> `docs/` is **baked into the image** rather than bind-mounted because this repo's
> `docs/` lives inside the outer git tree (no standalone `docs/.git`) and, in some
> dev sandboxes, the Docker daemon does not share the workspace filesystem (a bind
> mount would resolve to an empty dir). Baking it in keeps
> `docker compose ... up --build` a single portable step. The seed copy is
> **env-gated** on `SUNSTONE_BUNDLE_SEED_FROM`, so the read-only stack (which never
> sets it) is unaffected. It lives in the server, not in
> [`entrypoint.sh`](entrypoint.sh), because in a git shape only the server knows the
> destination — `SUNSTONE_BUNDLE` is ignored there. Setting it **together with an
> origin is a boot error**: you cannot seed a clone.

The runtime image installs `git` (every write shells out to it) and
`openssh-client` (git shells out to `ssh` for SSH transport) — both no-ops for the
plain shape.

---

# Serving a git-backed wiki

The **git-synced** shape backs the served Bundle with a git remote, in **one
container**: the server clones origin on boot, commits every web Save as the
signed-in OIDC user, and continuously `fetch → rebase → push`es so that external
`git push`es and web edits reconcile. Nothing sits beside it — no sidecar, no
host-side hook, no symlink swapping, and live reload simply works. This supersedes
the four-approach sidecar comparison that used to live here; the reasoning is
[ADR-0007](../docs/adr/0007-server-owns-the-git-sync-loop.md).

The stack is [`../docker-compose.wiki.yml`](../docker-compose.wiki.yml) with its
env-file template [`wiki.env.example`](wiki.env.example):

```bash
cp docker/wiki.env.example ./wiki.env    # then fill it in — see the runbook below
docker compose -f docker-compose.wiki.yml up -d
curl -s localhost:3000/api/sync-status   # confirm shape: "git-synced"
```

It uses `env_file:` (the repo's first) rather than inline `environment:` because
this stack carries three secrets, one of them a base64 private key: inline values
land in `~/.bash_history` and in every `ps` listing. That is **not** a secrets
manager — the values still show in `docker inspect`. It is the best of the options
available here, not actual secret hygiene.

The clone lives in the `repo` **named volume**, which is a **cache, not the record
of truth** — origin is. It is safe to delete whenever `/api/sync-status` reports
`pendingCommits: 0`.

## Host-side deploy runbook

Everything below runs on the host that owns the bare repo. Steps 1–5 produce the
three values `wiki.env` needs: `SUNSTONE_GIT_ORIGIN`, `SUNSTONE_GIT_KNOWN_HOSTS`
and `SUNSTONE_GIT_SSH_KEY`.

```sh
# 1. A dedicated, restricted host user owning the bare repo. git-shell permits only
#    git-upload-pack / git-receive-pack / git-upload-archive, so a container
#    compromise yields push access to this repo and nothing else.
sudo useradd -m -s "$(command -v git-shell)" git
sudo chown -R git:git /opt/docker/git-wiki/aitools-wiki.git

# 2. A deploy key. No passphrase — nothing can enter one at boot.
ssh-keygen -t ed25519 -N '' -C sunstone-wiki-deploy -f ~/.ssh/sunstone_wiki_deploy

# 3. Trust the public key, with `restrict` (no pty, no port/agent/X11 forwarding).
#    NOT a forced command= — the loop fetches as well as pushes, and one forced
#    command cannot serve both directions.
sudo -u git mkdir -p ~git/.ssh
printf 'restrict %s\n' "$(cat ~/.ssh/sunstone_wiki_deploy.pub)" \
  | sudo -u git tee -a ~git/.ssh/authorized_keys
sudo -u git chmod 700 ~git/.ssh && sudo -u git chmod 600 ~git/.ssh/authorized_keys

# 4. Pin the host key → SUNSTONE_GIT_KNOWN_HOSTS (one line, quoted).
ssh-keyscan -t ed25519 <docker-host-gateway-ip>

# 5. The private key, base64, single line → SUNSTONE_GIT_SSH_KEY.
base64 -w0 < ~/.ssh/sunstone_wiki_deploy

# 6. Register the OIDC client and the https://<host>/auth/callback/oidc redirect
#    URI with your provider (out of scope here; the provider id is hardcoded
#    `oidc`, and the app treats AUTHENTICATED AS AUTHORIZED).
```

`SUNSTONE_GIT_ORIGIN` uses the **URL form** — `ssh://git@host/absolute/path` — so
the path is absolute rather than relative to the remote user's home. The server
treats it as an **opaque string** and inspects it exactly once ("is this
ssh-shaped?", which is what gates the key requirement).

**Key rotation = change `SUNSTONE_GIT_SSH_KEY` and recreate the container.** `ssh`
reads the key file per invocation and nothing caches it, so there is no volume
surgery and no stale material to clean up. The server writes
`/srv/ssh/id_ed25519` at `0600` from the variable at boot and then removes the
variable from its own environment, so no git or ssh child inherits the key
material.

**`/srv/ssh` is deliberately not a volume.** The key is rewritten from the
environment on every boot, and `known_hosts` is either written from
`SUNSTONE_GIT_KNOWN_HOSTS` (strict host-key checking) or re-trusted on first
connect (`accept-new`, never persisted). Leaving it unpinned therefore means
"re-trust after every recreate" — pin it in any real deployment.

To reach a bare repo on the **Docker host**, the stack maps
`host.docker.internal:host-gateway`; drop that line when origin is a remote forge.

## Conflicts: nothing ever blocks

Integration is **rebase-always**, so history stays linear, and a true conflict is
resolved automatically — there is no manual step, ever. Per conflicted path:
**origin keeps the canonical name**, and the web bytes are written verbatim to a
**fork** beside it, `notes/foo.md` → `notes/foo-20260726T101500Z.md` (the timestamp
is the conflicting edit's author date). At most one fork per path per rebase run,
carrying the final content; the git history behind it still holds every author's
edit. The fork is an ordinary Concept — it appears in the tree, in **Search** and
in **Quick nav** — while inbound links keep pointing at the canonical file.

The one case where a committed web action does **not** survive is *web deleted /
origin modified*: origin's file stays and the deletion is dropped, because a
deletion carries no content and origin's concurrent edit is evidence someone still
wants the file.

Those two events — *fork created* and *deletion reverted* — are the only ones users
are told about, as a dismissible notice in the editor. Fetch and push failures are
never shown to users: nothing is lost, and there is no user action to take. They go
to `docker logs` (on transition, with the git error text) and to
`/api/sync-status`. Logging is quiet by default: every content change is logged
always, and a successful no-op tick logs nothing at all.

## Relocating origin (e.g. to GitLab)

**Changes:** `SUNSTONE_GIT_ORIGIN` (the URL string), `SUNSTONE_GIT_KNOWN_HOSTS`
(the forge's host key), where the public key is registered (a project deploy key
with write access instead of `authorized_keys`), and dropping `extra_hosts:`.

**Does not change:** the server, the loop, the image, the compose topology, the
volume, the key delivery mechanism, or any other variable. The `restrict` /
`git-shell` hardening simply has no analogue to carry over — GitLab already
constrains deploy keys to git transport.

## Cutover from an existing folder-sync deployment

If a deployment currently serves a work-tree that some external mechanism refreshes
(a `post-receive` hook, a polling sidecar), that work-tree has no `.git` of its own
and its history lives entirely in the bare repo — so a clone reproduces it exactly.
**Cutover is therefore delete, not convert**: no `mv content content.bak`, no
host-side git surgery.

1. Do the runbook above and fill `wiki.env` from
   [`wiki.env.example`](wiki.env.example).
2. Bring up `docker-compose.wiki.yml`. The server clones origin into the **fresh**
   `repo` volume; a fresh volume is empty, so clone-on-boot is safe by construction
   rather than by guard.
3. Verify: `curl -s localhost:3000/api/sync-status` reports `shape: "git-synced"`,
   `lastFetchOk: true`, `pendingCommits: 0`. Sign in, edit, and confirm the commit
   lands in the bare repo with **the OIDC user as author** and `Sunstone Sync` as
   committer. Then push to the bare repo from elsewhere and confirm the change
   appears in a connected browser within one interval.
4. Then, and only then, remove the old work-tree and whatever refreshed it.

> ### ⚠️ Migration hazard — root-era volumes
>
> Files that an older **root** container wrote into a volume stay owned by `0:0`,
> and today's non-root container **cannot overwrite them**. Such a volume needs a
> one-off `chown -R 1000:1000`, or to be dropped. The cutover above creates a
> **fresh** volume and dodges this entirely; it matters only if you reuse a
> pre-existing one.

## Environment & volume reference

This table is **normative**: it is the single list of everything the deployment
reads, and [`docs/architecture/sunstone-server.md`](../docs/architecture/sunstone-server.md)
links here rather than repeating it.

The **strict** column is the part to internalise. Every `SUNSTONE_GIT_*` variable
is strict — malformed ⇒ the container **refuses to boot**, reporting all config
errors at once. The pre-existing variables are deliberately **lenient**: they
silently fall back on garbage (`SUNSTONE_API_PORT=banana` still yields `8787`).
That inconsistency is knowing — making them fatal would change behaviour for
deployments that exist today. Everywhere, an **empty value means unset**.

| Variable | Default | Strict? | Meaning |
| --- | --- | --- | --- |
| **git family — read by the server, every entry strict** | | | |
| `SUNSTONE_GIT_BRANCH` | none — **required** once any `SUNSTONE_GIT_*` is set | strict | The deployment's line of history: clone `--branch`, rebase target, push target, `init --initial-branch`. Setting it is what declares a git shape. |
| `SUNSTONE_GIT_ORIGIN` | unset ⇒ **git-local** | strict | Opaque string passed to `git clone`; inspected once (ssh-shaped ⇒ a key is required). Empty ⇒ silent downgrade to git-local — see [the trap](#the-three-deployment-shapes). |
| `SUNSTONE_GIT_BUNDLE_SUBDIR` | `""` = repo root | strict | Bundle root relative to `/srv/repo`. Absolute, or containing `..` ⇒ boot error. |
| `SUNSTONE_GIT_SYNC_INTERVAL_SECS` | `10` | strict | Inbound poll period. Saves kick the loop, so this governs **inbound only**. Unparseable or `0` ⇒ boot error. |
| `SUNSTONE_GIT_SYNC_NAME` / `_EMAIL` | `Sunstone Sync` / `sync@sunstone.invalid` | name only | The loop's **committer** identity — load-bearing, since without it `rebase` dies with "Committer identity unknown". Never the author, except on a git-local seed commit. Only the *name* is strict (the namespace is closed); the **value** is unvalidated — any string reaches `git commit`, so a garbage e-mail is not caught at boot. |
| `SUNSTONE_GIT_SSH_KEY` | unset | strict | base64 of the deploy key's private PEM, single line (`base64 -w0`). Undecodable ⇒ boot error. Written to `/srv/ssh/id_ed25519` `0600`, then dropped from the environment. |
| `SUNSTONE_GIT_KNOWN_HOSTS` | unset ⇒ `accept-new`, unpersisted | strict | `ssh-keyscan` output. Set ⇒ strict host-key checking. |
| *any other* `SUNSTONE_GIT_*` | — | strict | **Boot error — the namespace is closed.** This is what catches a typo'd `SUNSTONE_GIT_ORGIN=…`, and turns a stale sidecar env file still carrying `SUNSTONE_GIT_REPO` / `_REF` / `_PERIOD` into a caught migration instead of a wiki quietly serving un-synced content. |
| **pre-existing — read by the server, deliberately lenient (one exception, noted)** | | | |
| `SUNSTONE_BUNDLE` | `/bundle` (baked into the image) | lenient | Bundle root for the **plain** shape. In a git shape it is **logged and ignored** — the one log-and-ignore case in the whole surface, because a baked image default cannot be told apart from an operator's override. |
| `SUNSTONE_BUNDLE_SEED_FROM` | unset | strict | Optional one-time file copy into the resolved Bundle root, before any git step. **Plus an origin ⇒ boot error** (you cannot seed a clone, and `git clone` requires an empty target). Strict rather than log-and-ignored because — unlike `SUNSTONE_BUNDLE` — it has no baked image default, so its presence is always an explicit operator act. |
| `SUNSTONE_API_PORT` | `8787` | lenient | Internal Rust API port; garbage falls back to the default. |
| `SUNSTONE_API_INTERNAL` | `http://localhost:8787` | lenient | Where the SSR process reaches the API, over container loopback. |
| `SUNSTONE_JWT_SECRET` | unset | lenient | Unset ⇒ **read-only**: every write route `401`s **and** history is unavailable (the history gate *is* the write gate). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | lenient | SSR web bind. |
| **documented here, but NOT read by the server** | | | |
| `SUNSTONE_UID` / `SUNSTONE_GID` | `1000` / `1000` | n/a | Compose-level `user:` override, for a **writable bind mount** not owned by uid 1000; commented out by default. Never set it on the git-synced stack — the named volume inherits uid 1000 from the image directory, so an override breaks the very clone it is meant to enable. |
| `SUNSTONE_WEB_PORT` | `3000` | n/a | Host port the viewer is published on (compose interpolation). |
| `SUNSTONE_BUNDLE_HOST` | `./examples` | n/a | Host path bind-mounted at `/bundle` in the plain stacks (compose interpolation). |
| `SUNSTONE_OIDC_*` | unset | n/a | `_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_NAME` — read by the SSR process (`src/auth.ts`), never by Rust. The callback is `/auth/callback/oidc`; the provider id is hardcoded `oidc`. |
| `SUNSTONE_TEST_AUTH*` | unset | n/a | Playwright-only auth bypass, read by `src/auth.ts`. Never set in production. |
| `ORIGIN` / `PROTOCOL_HEADER` / `HOST_HEADER` / `AUTH_SECRET` / `AUTH_TRUST_HOST` | — | n/a | Standard SvelteKit + Auth.js variables, read by the SSR process. |
| `DOCKERHUB_USERNAME` / `SUNSTONE_TAG` | per compose file (`your-user` / `chonkybirb`) / `latest` | n/a | Image coordinates; compose interpolation only. |

Volumes and paths:

| Path | Kind | Notes |
| --- | --- | --- |
| `/srv/repo` | the **`repo` named volume** in the git-synced stack; plain container filesystem in the dex stack | The clone, with an in-tree `.git`. A **constant, not a knob**: it exists in the image chowned to uid 1000, so a freshly created named volume inherits that owner and is writable **by construction** — no chown at boot, no `gosu`, no root at PID 1. A **cache, not the record of truth**; safe to delete when `pendingCommits: 0`. |
| `/srv/ssh` | **never a volume** | The deploy key and `known_hosts`, deliberately container-local and dying with the container: the key is rewritten from the environment every boot, and host-key trust is either pinned from `SUNSTONE_GIT_KNOWN_HOSTS` or re-trusted on first connect. A second volume would only persist material that is regenerated anyway. |
| `/bundle` | bind mount (`:ro` in the plain stacks) | The Bundle in the **plain** shape, from `SUNSTONE_BUNDLE_HOST`. Ignored in git shapes. |
| `/bundle-src` | baked into the image | The dex stack's seed source (`SUNSTONE_BUNDLE_SEED_FROM`). |

There is deliberately **no healthcheck** on `/api/sync-status`: an unreachable
remote must not mark the container unhealthy, because offline tolerance is
intentional and a restart fixes nothing.

---

# Publishing & installing from Docker Hub

The guides above build the image locally. To install Sunstone Web on a remote host
**without a repo checkout or build context**, push the image to Docker Hub once and
pull it there (see [running the published image](#running-the-published-image-remote-host)
below).

## One-time setup (maintainer only)

Pushing requires **your** Docker Hub credentials — nobody else can push under
your namespace on your behalf. Do this once:

1. Create a [Docker Hub](https://hub.docker.com/) account and, under **Account
   Settings → Personal access tokens**, create an access token with
   **Read & Write** scope.
2. In this GitHub repo, under **Settings → Secrets and variables → Actions**, set:
   - a **variable** `DOCKERHUB_USERNAME` — your Docker Hub namespace (used to
     derive the image name `<namespace>/sunstone-web`; nothing is hardcoded), and
   - a **secret** `DOCKERHUB_TOKEN` — the access token from step 1.

The image name is always `${DOCKERHUB_USERNAME}/sunstone-web`.

## Automatic path: tag a release

Tagging a release (`vX.Y.Z`, the same tag the desktop
[release flow](../.github/workflows/release.yml) reacts to) triggers
[`publish-web-image.yml`](../.github/workflows/publish-web-image.yml). It builds
a **multi-arch** (`linux/amd64,linux/arm64`) image and pushes two tags:
`:<version>` (e.g. `0.14.0`, the tag with the leading `v` stripped) and
`:latest`. The job is standalone — it does not wait on the Tauri installer build.

You can also run it on demand from the **Actions** tab
(**Publish Web Image → Run workflow**), optionally overriding the tag (defaults
to `latest`).

## Manual path: build & push from your machine

If you'd rather push by hand (or don't use GitHub Actions), build multi-arch with
buildx and push in one step. Log in first, then:

```bash
docker login                     # authenticate to Docker Hub

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <your-user>/sunstone-web:<version> \
  -t <your-user>/sunstone-web:latest \
  --push .
```

`--platform linux/amd64,linux/arm64` matters because the image is built for a
specific CPU architecture: if your machine is `arm64` (e.g. Apple Silicon) but
the remote is `amd64` (or vice versa), a single-arch image won't run there.
Building both and pushing a manifest list lets the remote pull the arch it needs.
buildx must push a multi-arch build straight to the registry — it can't `--load`
a multi-arch result into the local Docker daemon.

## Running the published image (remote host)

On the remote, use [`../docker-compose.remote.yml`](../docker-compose.remote.yml),
which runs the published image (`image:` instead of `build:`) with the same
read-only Bundle mount, published web port, and no-auth/internal-only posture as
the base compose:

```bash
DOCKERHUB_USERNAME=your-user SUNSTONE_TAG=0.14.0 \
SUNSTONE_BUNDLE_HOST=/srv/okf/my-bundle SUNSTONE_WEB_PORT=8080 \
  docker compose -f docker-compose.remote.yml pull && \
  docker compose -f docker-compose.remote.yml up -d
```

`SUNSTONE_TAG` defaults to `latest`. This is the **plain** shape: a `:ro` folder,
no git, no writes. To keep a git-backed Bundle in sync on the remote instead, use
[`../docker-compose.wiki.yml`](../docker-compose.wiki.yml) — it runs the same
published image and the server does the syncing itself, so nothing needs to be
combined with anything. See [Serving a git-backed
wiki](#serving-a-git-backed-wiki).
