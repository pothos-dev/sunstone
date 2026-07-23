# 06 — Web Edit → save/revert (DEFERRED)

**What to build:** On the web build, the concept header's Edit toggle behaves differently from desktop: because web is not auto-save, pressing Edit enters an editing session, and the control then morphs into save/revert actions; committing (save) or discarding (revert) quits edit mode. Desktop remains auto-save (Edit simply toggles editing off).

**Blocked by:** The web-write epic (`.scratch/enable-web-writing/`) — the web backend rejects all writes today, and there is no auth/identity model yet. Also depends on 01 (editing model) and 04 (web rail/header). **Cannot start until web writing exists.**

**Status:** blocked — deferred

- [ ] Web concept header shows an Edit toggle only when the web build supports writes.
- [ ] Entering edit mode on web reveals save + revert actions; save commits via the (future) web write path; revert discards and exits edit mode.
- [ ] Desktop behaviour unchanged (auto-save; Edit toggles editing off with no save/revert step).

## Comments

- Captured here to record intent from the layout redesign discussion. Move into / merge with the web-write epic when that work is scheduled; do not start as part of the layout-rework set.
