/**
 * Whether the wasm module is registered, as a rune. The free exports
 * (`./exports`) read a plain module variable, so a `$derived` over them does
 * not re-run when wasm arrives; a display-time derivation that must (lifecycle
 * staleness: `instantSeconds` is `null` until then) reads `wasmReady.loaded`
 * too. Set by the browser loader (`./index`); never true on SSR.
 */
class WasmReady {
  loaded = $state(false);
}

export const wasmReady = new WasmReady();
