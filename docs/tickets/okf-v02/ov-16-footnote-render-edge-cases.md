---
status: captured
priority: 1
---

# ov-16: Footnote render edge cases

**What to build:** close the gaps left after ov-14 between what the editor and the web viewer show for footnotes. The 2026-10-07 nightly review found these:

- A `[^1]` indented four spaces is an indented code block to comrak, but the shared scanner only skips fenced and inline code, so the native render puts `<sup>` markup inside `<pre><code>`.
- Two definitions of the same label (in any case) both emit `id="fn-<label>"`, so the HTML has duplicate ids.
- The fake backend's `renderTextWithFootnotes` works one line at a time and does not know about fences, so it renders `[^1]: x` inside a fenced block as a definition. The native render leaves it alone.
- A definition directly under a paragraph line (`Text.\n[^1]: note`) merges into that paragraph in the native render. The editor shows it on its own line.
