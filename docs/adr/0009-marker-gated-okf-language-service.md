# OKF linting and completion are gated on the `okf_version` marker

Now that Frontmatter is edited as YAML text ([ADR-0008](0008-raw-yaml-frontmatter-editing.md)),
the affordances a structured panel used to provide come from a **language service**: syntax
highlighting, diagnostics, completion and an explicit format command. Everything in that service
that knows about **OKF** — the lint rules and the key/value completions — is active **only when
the Bundle declares itself OKF**, by carrying `okf_version` in its bundle-root `index.md`
([§12](../okf/spec.md#12-versioning)). There is no override and no heuristic.

In a Bundle without the marker, the service still runs: YAML **well-formedness** is always
linted, because malformed YAML is a defect in any bundle. It simply says nothing about `type`,
`sources`, `status` or any other OKF concept.

## Why gate it

`sunstone ./notes` opens any folder of markdown. Most are not OKF bundles and are never intended
to be. Linting them against a format they never adopted is the same mistake as the required-`type`
warning that was deliberately removed from the Properties panel — and it would contradict
[§11](../okf/spec.md#11-conformance), which tells consumers to tolerate non-conformance rather
than reject it.

A heuristic — "most files carry `type`, so this is probably OKF" — was rejected because it fails
in exactly the wrong direction: it would silently start erroring on someone's notes folder, which
is the nagging the gate exists to prevent. A manual "treat this Bundle as OKF" override was
considered and also rejected: `okf_version` is the signal the spec sanctions for precisely this
purpose, and a second, Sunstone-only way to answer the same question would only invite the two to
disagree.

Completion is gated alongside lint, not separately. A dropdown offering `sources` and
`stale_after` in a personal notes folder teaches the format to someone who did not ask for it,
and the split would make the marker mean two different things.

## Shape

- One pure function, `lintFrontmatter(yaml, mode)`, in plain TypeScript — unit-testable, per the
  repo's pure-logic convention. It parses once and returns findings with character offsets;
  `mode` selects well-formedness-only or full OKF.
- It stays in TypeScript rather than `sunstone-shared` under the exception
  [ADR-0006](0006-wasm-shared-core-for-frontend-logic.md) §11-C already carved for the frontmatter
  model: diagnostics need source positions, which `serde_yaml` does not provide and the `yaml`
  package does.
- CodeMirror calls it through `@codemirror/lint`'s `linter(source, { delay })`, with a 1s delay so
  errors do not flash mid-keystroke, and `needsRefresh` so the lint re-runs when OKF mode changes
  without the document changing.
- The **save gate** ([ADR-0008](0008-raw-yaml-frontmatter-editing.md)) deliberately does **not**
  call this. It asks a narrower `isParseable(yaml)`, so whether a Concept saves can never drift
  with lint policy — an OKF error never blocks a write.
- In OKF mode, fields the spec marks REQUIRED are **errors** (`type`, a `sources` entry's
  `resource`, `generated.by`); everything else is a warning or info.

## Consequences

- A Bundle that is plainly OKF but predates the marker gets no OKF lint until someone adds one
  line to its root `index.md`. This is accepted: the fix is trivial, discoverable, and makes the
  Bundle self-describing for every other consumer too. Ticket 07 writes the marker into Bundles
  Sunstone creates.
- Sunstone's own `docs/` Bundle was in exactly that position and now carries
  `okf_version: "0.2"`, which also makes it the test bed for the linter.
- OKF diagnostics are still scoped to families the author opted into: a Concept with no `sources`
  key gets no provenance diagnostics at all.
