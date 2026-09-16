---
status: ready-for-agent
blocked-by: [01, 02a, 02b, 09]
---

# 11: The `Attested Computation` Concept type

**What to build:** a Concept whose `type` is `Attested Computation` is recognised as a computation with a contract, not just another document, and its contract fields are editable. This is the one new Concept type in OKF v0.2 (§10): a computation becomes a first-class Concept that other Concepts link to, so a metric narrates its figures and the figures themselves carry the code and the machinery to check it.

The contract is five keys: `runtime` names the execution environment, `parameters` is a list of `{ name, type, required }` maps, `computation` holds or points at the code, and `executor` and `attester` each carry a `resource` — with `executor` also carrying a `receipt` list naming what a run must return. `executor.resource`, `attester.resource` and `computation` are path-valued fields under §6.2, so they accept an absolute URL, a bundle-relative path, or a relative path, and they commonly point into a `references/` subdirectory. Resolving them reuses the link machinery, which is why this follows the provenance ticket.

Scope note: v0.2 explicitly defers the runtime protocol, receipt and verdict wire formats, and the attester ABI. Sunstone models and displays the contract; it does not execute or verify anything.

- [ ] `Attested Computation` is recognised as a Concept type, and its contract keys parse, render and edit
- [ ] `parameters` is authorable as a list of maps, with `name` and `type` present and `required` optional per entry
- [ ] `executor.resource`, `attester.resource` and a path-valued `computation` resolve through the same link resolution as any in-Bundle link, including bundle-absolute form under the detected root
- [ ] `executor.receipt` edits as a list of names
- [ ] A Concept of this type missing optional contract keys renders without warning, per permissive conformance
- [ ] Nothing is executed, run or verified — the contract is displayed only
- [ ] Unit tests cover contract parsing and path-valued field resolution
- [ ] All four gates green
