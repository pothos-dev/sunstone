// The fake backend's ATTACHMENTS: bundle-relative path -> `data:` URL.
//
// An Attachment (docs/GLOSSARY.md) is a non-`.md` file stored in the Bundle —
// here, the images the fixture's Concepts Embed. Two things make this module
// necessary rather than a few more entries in `./fixture`:
//
//  1. **There is no file server.** The desktop Playwright suite serves a static
//     SPA over the in-memory fake backend; a real URL has nothing to resolve
//     against. So the fake's `attachmentUrl` hands the widget a `data:` URL
//     built from the bytes seeded right here (ADR-0011: a URL, never bytes, is
//     what crosses the seam — a `data:` URL is still a URL).
//  2. **Attachments are a SEPARATE index from Concepts** — the same decision the
//     ticket makes for the Rust side. `FILES` in `./store` is the Concept
//     working tree, seeded `.md`-only: `buildTree` lists every key it holds and
//     `conceptPaths()` feeds link resolution. (Only seeded that way — a test
//     hook like `simulateExternalChange` can write any key.) Folding the
//     Attachments in there would put images in the Explorer tree. Keeping them
//     in their own map keeps the seeded Attachments out of the tree without
//     remembering a filter.
//
// The payloads are GENUINELY DECODABLE images, not placeholder strings: a
// Playwright spec must be able to assert an Embed actually LOADED
// (`naturalWidth > 0`), which a broken `data:` URL would not satisfy. Their
// natural sizes are deliberately distinct so a sizing spec has something to
// measure:
//
//   | path                             | natural size | note                  |
//   | -------------------------------- | ------------ | --------------------- |
//   | `assets/dot.png`                 | 16 x 16      | square, at the root   |
//   | `concepts/assets/wide.png`       | 64 x 16      | landscape, 4:1        |
//   | `concepts/assets/mark.svg`       | 48 x 48      | vector                |
//   | `concepts/editor/assets/diagram.png` | 96 x 32  | landscape, 3:1        |

/**
 * Seeded Attachments: bundle-relative, forward-slash path -> `data:` URL.
 *
 * Mutable (a live binding, like `FILES`) so a future test hook can add one, but
 * nothing in the fake writes Attachments today.
 */
export const ATTACHMENTS: Record<string, string> = {
  // 16x16 solid green PNG. Lives at the Bundle ROOT so a bundle-absolute Embed
  // (`/assets/dot.png`) is exercised, and so the "a top-level `assets/` folder
  // must not perturb Concept paths" case is covered by the fixture itself.
  'assets/dot.png':
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPQO1NIEmIY1TCqYfhqAAC4lWsQZ+JqLgAAAABJRU5ErkJggg==',

  // 64x16 striped blue PNG — a 4:1 aspect ratio, clearly different from
  // `dot.png`'s 1:1, so a spec can tell an unsized Embed from a sized one.
  'concepts/assets/wide.png':
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAATElEQVR42mOQc5oPRyYV3+BoqIgzDGnXyznNZxjSrod6YOi6HuSBIe16FA8M0dzMMKRdD/XAkC5JGUbrgdF6YLQeGK0HRuuBEV0PAABxq0JMnd6PWAAAAABJRU5ErkJggg==',

  // 48x48 SVG (a white triangle on purple). Carries explicit `width`/`height`
  // so it has a natural size when loaded through an `<img>`.
  'concepts/assets/mark.svg':
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIGZpbGw9IiM5YjU5YjYiLz48cGF0aCBkPSJNOCAzNiBMMjQgMTAgTDQwIDM2IFoiIGZpbGw9IiNmZmZmZmYiLz48L3N2Zz4=',

  // 96x32 striped orange PNG. This is the target of the Embed that has sat in
  // `concepts/editor/live-preview.md` since the walking skeleton
  // (`![diagram](./assets/diagram.png)`) — seeding it turns that long-standing
  // "renders but 404s" fixture note into a working case.
  'concepts/editor/assets/diagram.png':
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAAa0lEQVR42u3WMQ3AMAADQcMIjTApnOApxgDIUCmjCfQkTx5/uqxn3O133vm/RYX+R4X+R4X+R4X+R4X+R4X+R4X+RwUO4iAO4iAO4iAO4iB1OIiDOIiDOIiDOIiD1OEgDuIgDuIgDuKgH/wHbzbq4kYUMgAAAAAASUVORK5CYII=',
};

/**
 * Every Attachment path in the fixture, sorted. The Attachment counterpart of
 * `conceptPaths()` — a SEPARATE list, deliberately: `listConceptPaths()` stays
 * `.md`-only, and Embed name-resolution (`![[wide.png]]`) searches this one.
 */
export function attachmentPaths(): string[] {
  return Object.keys(ATTACHMENTS).sort();
}

/** True if `path` names a seeded Attachment. */
export function attachmentExists(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(ATTACHMENTS, path);
}

/**
 * URL prefix handed back for a path with no seeded Attachment. Nothing serves
 * it, so the `<img>` fires `error` and the widget shows its error placeholder —
 * which is exactly the contract: `attachmentUrl` builds a URL and never throws
 * for a missing file. The path stays visible in the URL so a failure is
 * debuggable in devtools.
 */
const MISSING_ATTACHMENT_PREFIX = '/__fake-attachment/';

/**
 * The fake's Attachment URL for a bundle-relative path: the seeded `data:` URL,
 * or a deliberately unservable URL when nothing is seeded there.
 *
 * Synchronous and total — see `Backend.attachmentUrl`.
 */
export function fakeAttachmentUrl(path: string): string {
  return ATTACHMENTS[path] ?? `${MISSING_ATTACHMENT_PREFIX}${encodeURIComponent(path)}`;
}
