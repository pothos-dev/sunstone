// The canonical write form of an ISO 8601 instant (OKF v0.2 §5). Pure; no DOM.
//
// Reading one is not done here: every datetime check and comparison goes
// through the shared Rust grammar (`sunstone-shared/src/instant.rs`) over wasm
// — `isIsoDatetime`, `epochSeconds`, `instantSeconds` in `$lib/wasm/exports`
// (ADR 0006: no TS twins).

/** The canonical write form: whole seconds, UTC, `Z` offset (`2026-09-23T00:00:00Z`). */
export function isoUtc(at: Date | number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
