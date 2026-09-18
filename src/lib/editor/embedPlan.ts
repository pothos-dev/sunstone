import type { Embed, EmbedTargetKind } from '$lib/wasm/exports';

// ---------------------------------------------------------------------------
// Embed placement planning (slice: embedded-images, ADR-0010)
//
// The PURE half of `embedBlocks()`: given the Embeds the wasm kernel found in
// the body, decide — with no DOM, no CodeMirror and no backend — WHERE each
// widget goes, WHAT it should show, and what identity it has for
// `WidgetType.eq()`. `embeds.ts` is the thin CM/DOM shell over this, following
// the `mermaidBlocks.ts` / `mermaid.ts` split the repo conventions call for.
//
// Everything this module needs from the outside is injected as a callback
// (`classify` / `isImage` / `resolve` / `url`), so a unit test drives the whole
// planner over plain strings without wasm, without an index and without a
// backend.
//
// The two decisions ADR-0010 turns on:
//
//   * PLACEMENT — one predicate, "is the Embed the only content on its line?".
//     Alone  -> a BLOCK point widget anchored at `line.to` (the image sits
//               below its source line, exactly where upstream `imageBlocks` put
//               it).
//     Among  -> an INLINE point widget anchored at the Embed's end, so the image
//     text    stays in the paragraph flow where its author put it, and it is
//             SUPPRESSED while its own line is active (the cursor-overlap skip
//             `citations.ts` and `smartDashesView.ts` already use) so the line
//             being edited shows source only.
//
//   * RENDER — what the widget is. `image` (a resolved Attachment), `remote`
//     (a neutral click-to-load affordance that fetches NOTHING until clicked),
//     or `error` (the `cm-broken-link`-styled placeholder, for an unresolvable
//     target). A `data:` / other-scheme target and a non-image Attachment get NO
//     widget at all — see `planEmbeds`.
//
// NOTE that nothing here ever hides the raw `![alt](x.png)` source: that is
// `inlinePreview`'s job (it replaces the whole `Image` node on every inactive
// line and honours Sunstone's `alwaysRender` flag in `read` mode). This module
// only ever plans POINT widgets, never a replace.
// ---------------------------------------------------------------------------

/** Where an Embed's widget goes relative to its source. */
export type EmbedPlacement = 'block' | 'inline';

/** What an Embed's widget shows. */
export type EmbedRender =
  /** A resolved Attachment: a real `<img>`. */
  | 'image'
  /** An `http`/`https` target: the neutral click-to-load affordance. */
  | 'remote'
  /** An unresolvable target: the `cm-broken-link`-styled error placeholder. */
  | 'error';

/** The slice of a CodeMirror `Line` the planner reads. */
export interface EmbedLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** The slice of a CodeMirror `Text` the planner reads (`state.doc` satisfies it). */
export interface EmbedDoc {
  lineAt(pos: number): EmbedLine;
}

/** The slice of a CodeMirror `SelectionRange` the planner reads. */
export interface EmbedRange {
  readonly from: number;
  readonly to: number;
}

/** One planned Embed widget: everything the DOM shell needs, and nothing else. */
export interface EmbedPlan {
  /** Document offset of the Embed's leading `!` (UTF-16 units). */
  readonly from: number;
  /** Document offset one past the Embed's final `)` / `]]` (UTF-16 units). */
  readonly to: number;
  /** Where the widget decoration is anchored. */
  readonly at: number;
  readonly placement: EmbedPlacement;
  readonly render: EmbedRender;
  /**
   * The Embed's RAW target, verbatim from the source — what the author wrote,
   * not what it resolved to. Only the error placeholder uses it (`Missing
   * attachment: …` must show WHAT was asked for, or the typo is unfindable), so
   * it is deliberately not part of the widget key.
   */
  readonly target: string;
  /**
   * What the `<img>` loads: the Attachment URL for `image`, the raw remote URL
   * for `remote` (NOT set on an element until the affordance is clicked), and
   * `''` for `error` — there is nothing to load.
   */
  readonly src: string;
  /** The accessible name, already resolved by the kernel (never `''`). */
  readonly alt: string;
  /** An explicit `|300` / `300x200` width in CSS pixels, or `null`. */
  readonly width: number | null;
  /** An explicit `300x200` height in CSS pixels, or `null`. */
  readonly height: number | null;
}

/** Everything the planner needs from wasm, the index and the backend seam. */
export interface EmbedPlanOptions {
  /**
   * `read` mode. Reading has no caret, so an inline Embed is never suppressed
   * there — the same reason `citations` / `smartDashes` gate their reveal on it.
   */
  readonly reading: boolean;
  /** The current selection ranges (the cursor-overlap skip reads these). */
  readonly selection: readonly EmbedRange[];
  /** `classifyEmbedTarget` — local / remote / data / otherScheme. */
  readonly classify: (target: string) => EmbedTargetKind;
  /** Does this target name a file we render as an image? (`isImageAttachment`) */
  readonly isImage: (target: string) => boolean;
  /**
   * Resolve a LOCAL Embed to a bundle-relative Attachment path, or `null` when
   * it resolves to nothing. The caller picks the model per `embed.kind`:
   * `resolveEmbedPathIn` for `path`, `resolveEmbedNameIn` for `name`.
   */
  readonly resolve: (embed: Embed) => string | null;
  /** `backend.attachmentUrl` — bundle-relative path to a loadable URL. */
  readonly url: (path: string) => string;
}

/**
 * Is the Embed the only content on its line? The ONE predicate ADR-0010's
 * placement branches on.
 *
 * "Only content" means the Embed spans the whole line once leading and trailing
 * whitespace is discounted — so `  ![x](a.png)  ` is alone, and
 * `see ![x](a.png)` is not. A multi-line Embed (possible for a `![[ … ]]` whose
 * close is on a later line) is never alone: its `to` runs past `line.to`.
 */
export function isAloneOnLine(line: EmbedLine, from: number, to: number): boolean {
  const lead = line.text.length - line.text.trimStart().length;
  const trail = line.text.length - line.text.trimEnd().length;
  return from === line.from + lead && to === line.to - trail;
}

/** True when any selection range overlaps `[from, to]` (edges count as inside). */
export function overlapsSelection(
  ranges: readonly EmbedRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * An explicit Embed size as CSS lengths.
 *
 * ADR-0010: an explicit size is applied as CSS `width`/`height`, **never** as
 * the HTML `width`/`height` attributes, which the URL-keyed `dimensionCache`
 * owns for the image's NATURAL dimensions — otherwise two differently-sized
 * Embeds of one file would corrupt each other's cache entry.
 *
 * A width alone leaves height to the stylesheet's `height: auto`, so the aspect
 * ratio is preserved (and the browser derives it from the natural-size
 * attributes). A non-positive size is not a size — `parse_size` accepts `0`
 * happily, and a zero-width image is a broken layout, not a request.
 */
export function embedSizeCss(
  width: number | null,
  height: number | null,
): { width: string | null; height: string | null } {
  if (width === null || !Number.isFinite(width) || width <= 0) {
    return { width: null, height: null };
  }
  const h = height !== null && Number.isFinite(height) && height > 0 ? `${height}px` : null;
  return { width: `${width}px`, height: h };
}

/**
 * The identity a widget is reused on — ADR-0010's `(src, alt, width, height,
 * placement)`, plus `render`.
 *
 * Source alone is not enough once sizes exist: editing `|300` to `|400` must
 * produce a NON-equal widget or CodeMirror reuses the old DOM at the old size.
 * `render` is the one addition to the ADR's list: an error placeholder and a
 * remote affordance are different DOM for what could otherwise be the same key,
 * and encoding "this is an error" as `src === ''` is an invariant waiting to be
 * broken. An UNRELATED edit still yields an equal key, so CodeMirror reuses the
 * element and the browser never re-decodes the image.
 */
export function embedWidgetKey(plan: {
  readonly src: string;
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly placement: EmbedPlacement;
  readonly render: EmbedRender;
}): string {
  return [
    plan.render,
    plan.placement,
    plan.width ?? '',
    plan.height ?? '',
    plan.alt,
    plan.src,
  ].join(' ');
}

/**
 * Plan one widget per renderable Embed, in document order.
 *
 * An Embed gets NO widget — and so renders as nothing at all, since
 * `inlinePreview` has already hidden its source — when:
 *
 *   * its target is a `data:` URI or any other non-`http(s)` scheme. `data:` is
 *     an injection vector once ei-2 inlines SVG and carries no benefit a Bundle
 *     file does not (ticket ei-1, "Remote images");
 *   * its target is not an image we render. Non-image Attachments are out of
 *     scope until `al-1`;
 *   * it is INLINE and its own line is active in `editing` — the cursor-overlap
 *     skip, so the line being edited shows source only.
 *
 * Everything else gets a widget, including an unresolvable target: that is the
 * error placeholder, and it must never swallow the rest of the Concept.
 */
export function planEmbeds(
  embeds: readonly Embed[],
  doc: EmbedDoc,
  opts: EmbedPlanOptions,
): EmbedPlan[] {
  const plans: EmbedPlan[] = [];

  for (const embed of embeds) {
    const kind = opts.classify(embed.target);
    // `data:` and `mailto:`/`file:`/… never render (ADR-0011 / ei-1).
    if (kind === 'data' || kind === 'otherScheme') continue;
    // Non-image Attachments keep today's rendering until al-1.
    if (!opts.isImage(embed.target)) continue;

    const line = doc.lineAt(embed.from);
    const placement: EmbedPlacement = isAloneOnLine(line, embed.from, embed.to)
      ? 'block'
      : 'inline';

    // The cursor-overlap skip (citations.ts / smartDashesView.ts): an inline
    // widget is suppressed while its OWN LINE is active, matching the line
    // granularity `inlinePreview` reveals source at. A block widget is never
    // suppressed — it sits below the line, so the revealed source and the image
    // coexist, exactly as upstream `imageBlocks` behaved.
    if (
      placement === 'inline' &&
      !opts.reading &&
      overlapsSelection(opts.selection, line.from, line.to)
    ) {
      continue;
    }

    let render: EmbedRender;
    let src: string;
    if (kind === 'remote') {
      render = 'remote';
      src = embed.target.trim();
    } else {
      const path = opts.resolve(embed);
      if (path === null) {
        render = 'error';
        src = '';
      } else {
        render = 'image';
        src = opts.url(path);
      }
    }

    plans.push({
      from: embed.from,
      to: embed.to,
      at: placement === 'block' ? line.to : embed.to,
      placement,
      render,
      target: embed.target,
      src,
      alt: embed.alt,
      width: embed.width ?? null,
      height: embed.height ?? null,
    });
  }

  return plans;
}
