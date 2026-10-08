import { contractOf, type Contract, type Parameter, type PathField } from '$lib/wasm/exports';

// ---------------------------------------------------------------------------
// The contract card of an Attested Computation (OKF v0.2 §10, ov-12)
//
// A Concept whose `type` is `Attested Computation` carries a contract in its
// Frontmatter: `runtime`, `parameters`, `computation`, `executor` (with its
// `receipt`) and `attester`. The card shows it above the body, after the trust
// line, so the Concept reads as a computation rather than as a document. It is
// display only: Sunstone never executes, runs or verifies anything (v0.2 defers
// the runtime protocol, receipts, verdicts and the attester ABI).
//
// The reading of the keys is `sunstone_shared::computation` over wasm
// (`contractOf`); this module only builds the markup. The native render emits
// the same markup (`sunstone-native/src/render/computation.rs`), with its links
// classified like any rendered link; styled by `.computation*` in `app.css`:
//
//   <section class="computation" data-testid="computation">
//     <div class="computation-heading">Attested Computation …</div>
//     <dl class="computation-fields">
//       <dt>Runtime</dt><dd><code class="computation-runtime">bigquery</code></dd>
//       <dt>Parameters</dt><dd><ul class="computation-params"><li>…</li></ul></dd>
//       <dt>Computation</dt><dd><a data-resource="…" …>…</a></dd>
//       <dt>Executor</dt><dd><a …>…</a> <span class="computation-receipt">…</span></dd>
//       <dt>Attester</dt><dd><a …>…</a></dd>
//     </dl>
//   </section>
//
// A path-valued field is an `<a>` carrying `data-resource` (the value as
// written): the editor opens it through `onLinkClick`, i.e. the same link
// resolution as any in-Bundle link. A key that is absent is simply not shown
// (permissive conformance, §11): no row, no warning. An Attested Computation
// with no contract keys at all gets no card.
// ---------------------------------------------------------------------------

export type { Contract, Parameter, PathField };

/** The attributes of a path-valued field's `<a>`; the fake uses the raw value. */
export type LinkAttrs = (value: string) => string;

const rawHref: LinkAttrs = (value) => `href="${esc(value)}"`;

/** The contract card for a Frontmatter block (inner YAML), or `''` without one. */
export function contractCardHtml(yaml: string, link: LinkAttrs = rawHref): string {
  const c = contractOf(yaml);
  return c ? contractHtml(c, link) : '';
}

const HEADING_HINT =
  'OKF §10: the sanctioned way to compute this value. Shown only: Sunstone does not run or verify it.';

/** The card's markup for a parsed contract, or `''` when it carries nothing. */
export function contractHtml(c: Contract, link: LinkAttrs = rawHref): string {
  const rows: string[] = [];
  const row = (label: string, value: string) => rows.push(`<dt>${label}</dt><dd>${value}</dd>`);
  if (c.runtime) row('Runtime', `<code class="computation-runtime">${esc(c.runtime)}</code>`);
  if (c.parameters.length > 0) {
    row('Parameters', `<ul class="computation-params">${c.parameters.map(paramHtml).join('')}</ul>`);
  }
  if (c.computation) row('Computation', pathHtml(c.computation, link));
  if (c.executor) {
    const parts: string[] = [];
    if (c.executor.resource) parts.push(pathHtml(c.executor.resource, link));
    if (c.executor.receipt.length > 0) {
      const names = c.executor.receipt.map((n) => `<code>${esc(n)}</code>`).join(' ');
      parts.push(
        `<span class="computation-receipt"><span class="computation-label">Receipt</span> ${names}</span>`,
      );
    }
    if (parts.length > 0) row('Executor', parts.join(' '));
  }
  if (c.attester?.resource) row('Attester', pathHtml(c.attester.resource, link));
  if (rows.length === 0) return '';
  return (
    `<section class="computation" data-testid="computation">` +
    `<div class="computation-heading" title="${esc(HEADING_HINT)}">Attested Computation</div>` +
    `<dl class="computation-fields">${rows.join('')}</dl></section>`
  );
}

/** One parameter: `name` then its `type`, and `required` / `optional` when given. */
function paramHtml(p: Parameter): string {
  const name = p.name
    ? `<code class="computation-param-name">${esc(p.name)}</code>`
    : `<span class="computation-missing">unnamed</span>`;
  const type = p.type ? ` <span class="computation-param-type">${esc(p.type)}</span>` : '';
  const req =
    p.required == null
      ? ''
      : ` <span class="computation-param-${p.required ? 'required' : 'optional'}">${p.required ? 'required' : 'optional'}</span>`;
  return `<li>${name}${type}${req}</li>`;
}

/** A path-valued field (§6.2): a link carrying the value as written. */
function pathHtml(f: PathField, link: LinkAttrs): string {
  return `<a data-resource="${esc(f.value)}" ${link(f.value)}>${esc(f.value)}</a>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
