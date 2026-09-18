---
status: ready
blocked-by: [ov-1]
---

# ov-4: Recognise the OKF actor convention

**What to build:** wherever Sunstone shows who produced or confirmed something, a reader sees a person distinguished from a machine at a glance rather than a raw string. OKF v0.2 §7 defines one convention for every identity-valued field: `human:<id>` for a person, `process:<id>` for an automated process, and `<producer>/<version>` for an agent or tool. The spec's own examples also use a `team:` prefix on a source's author, so the parser must tolerate prefixes it does not model rather than mangling them.

This lands before the trust and provenance families because both key off it: trust tiers are derived purely from whether a `human:` actor appears, and a source's `author` is an actor too.

- [ ] A pure helper parses an actor string into its kind and id, and round-trips an unrecognised form unchanged
- [ ] Actors render with their kind distinguishable from their id, consistently everywhere an actor is shown
- [ ] An empty or malformed actor degrades to showing the raw string, never an error — consumers must not reject a Concept over it
- [ ] Unit tests cover each documented form plus unknown-prefix and malformed input
- [ ] All four gates green
