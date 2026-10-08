---
status: done
blocked-by: [ov-1, ov-2, ov-3, ov-10]
---

# ov-12: The `Attested Computation` Concept type

**What to build:** a Concept whose `type` is `Attested Computation` is recognised as a computation with a contract, not just another document, and its contract fields are editable. This is the one new Concept type in OKF v0.2 (§10): a computation becomes a first-class Concept that other Concepts link to, so a metric narrates its figures and the figures themselves carry the code and the machinery to check it.

The contract is five keys: `runtime` names the execution environment, `parameters` is a list of `{ name, type, required }` maps, `computation` holds or points at the code, and `executor` and `attester` each carry a `resource` — with `executor` also carrying a `receipt` list naming what a run must return. `executor.resource`, `attester.resource` and `computation` are path-valued fields under §6.2, so they accept an absolute URL, a bundle-relative path, or a relative path, and they commonly point into a `references/` subdirectory. Resolving them reuses the link machinery, which is why this follows the provenance ticket.

Scope note: v0.2 explicitly defers the runtime protocol, receipt and verdict wire formats, and the attester ABI. Sunstone models and displays the contract; it does not execute or verify anything.

- [x] `Attested Computation` is recognised as a Concept type, and its contract keys parse, render and edit
- [x] `parameters` is authorable as a list of maps, with `name` and `type` present and `required` optional per entry
- [x] `executor.resource`, `attester.resource` and a path-valued `computation` resolve through the same link resolution as any in-Bundle link, including bundle-absolute form under the detected root
- [x] `executor.receipt` edits as a list of names
- [x] A Concept of this type missing optional contract keys renders without warning, per permissive conformance
- [x] Nothing is executed, run or verified — the contract is displayed only
- [x] Unit tests cover contract parsing and path-valued field resolution
- [x] All four gates green

## Resolution

`sunstone_shared::computation` reads the contract (over wasm as `contractOf` /
`isAttestedComputation`); a **contract card** after the trust line shows it in
the editor, the native render and the fake (shared goldens), display only. The
path-valued fields are links resolved like body links (`onLinkClick` →
`resolveLink` in the editor, `link_attrs` in the native render). The
`okf-computation` language-service family (`src/lib/okf/families/computation.ts`)
opts in on `type`, so only an Attested Computation is checked: missing
`runtime` is an error (§10.2 REQUIRED for the type), shape problems are
warnings, and it completes the type, the contract keys, `runtime` values and
parameter keys. See [Concept → Attested Computation](/okf/concept.md#attested-computation).
