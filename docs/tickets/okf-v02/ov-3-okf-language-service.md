---
status: ready
blocked-by: [ov-2, ov-5]
---

# ov-3: OKF linting and completion for Frontmatter

**What to build:** in a Bundle that declares itself OKF, the Frontmatter editor tells the author what the spec requires and offers the keys it defines; in every other Bundle it stays quiet. [ov-2](ov-2-frontmatter-yaml-editor.md) replaced a form that could suggest keys with a text editor that cannot, so the suggestions and the checks come back as a language service. This is [ADR 0009](/adr/0009-marker-gated-okf-language-service.md).

The gate is the `okf_version` marker in the bundle-root `index.md` ([§12](/okf/spec.md#12-versioning)) — detected by [ov-5](ov-5-bundle-root-okf-version-marker.md). There is no override and no heuristic: `sunstone ./notes` opens any folder of markdown, and linting one against a format it never adopted repeats the required-`type` nag that was deliberately removed. YAML well-formedness is linted everywhere regardless, because malformed YAML is a defect in any Bundle.

Family-specific rules are not all this ticket's job. It builds the service, the gate, and the [§4.1](/okf/spec.md#41-frontmatter) core rules; [ov-9](ov-9-generated-verified-trust-tiers.md), [ov-10](ov-10-sources-provenance-family.md), [ov-11](ov-11-status-stale-after-lifecycle.md) and [ov-12](ov-12-attested-computation-concept-type.md) each add their own rules and completions to it.

- [ ] A pure `lintFrontmatter(yaml, mode)` in plain TypeScript returns findings with source positions, and is unit-tested without a DOM or an editor
- [ ] Malformed YAML is reported with a position in every Bundle, marker or not
- [ ] OKF rules and OKF completions are both active only when the bundle-root `index.md` declares `okf_version`, and both go quiet when it does not
- [ ] In OKF mode, fields the spec marks REQUIRED are errors — `type`, a `sources` entry's `resource`, `generated.by` — and everything else is a warning or info
- [ ] Diagnostics are scoped to families the author opted into: a Concept with no `sources` key gets no provenance diagnostics
- [ ] A duplicate key is reported, restoring the rejection the Properties panel used to enforce — the `yaml` parser flags it, but `yamlError` asks with `uniqueKeys: false` so it can never hold a write back ([ov-2](ov-2-frontmatter-yaml-editor.md))
- [ ] Completion offers OKF's recommended top-level keys and the keys of any family already present, replacing the panel's `OKF_KEYS` autocomplete
- [ ] An explicit format command preserves comments and quoting
- [ ] The save gate asks only whether the YAML parses and never consults the lint, so an OKF error never blocks a write
- [ ] Toggling OKF mode re-runs the lint without the document changing
- [ ] All four gates green
