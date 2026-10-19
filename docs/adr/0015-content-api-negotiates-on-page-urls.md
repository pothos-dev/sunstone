# The content API answers on page URLs, chosen by `Accept`

Remote callers (agents, scripts, a GraphQL layer in front of a wiki) need to list, read and
search Concepts as JSON or Markdown. The `/_api/*` routes already return most of this, but they
are the frontend's private seam. Their shapes change whenever the UI needs them to, and
`/_api/concept` wraps the Markdown in a JSON string.

We considered a versioned prefix such as `/api/v1/…`. Any prefix is also a valid Bundle folder
name, so a Bundle with an `api/` folder would lose those pages. `/_api` has the same problem, but
nobody names a folder that.

Instead the content API lives on the page URLs themselves. A request for `/guide/setup` gets the
page, unless its `Accept` header asks for `application/json` or `text/markdown`:

- `/guide/setup` or `/guide/setup.md` returns the Concept. Markdown is the raw file. JSON is
  `{ path, frontmatter, body, links, backlinks }`.
- `/guide?list` lists the Concepts under `guide/`, recursively, with `title`, `description`,
  `type`, `tags` and `timestamp`. `&type=` and `&tag=` filter it.
- `/guide?q=text` runs the full-text search under `guide/`.

## Details that matter

- **Explicit types only.** The API answers when `application/json` or `text/markdown` appears
  by name with a higher q-value than `text/html`. A browser navigation, a bare `curl` (`*/*`)
  and a request without `Accept` all get the page. Callers must set the header.
- **Query parameters, not trailing slashes.** `/guide` already means `guide/index.md`, and
  SvelteKit 308-redirects `/guide/` to `/guide` before any hook runs. So folder views need
  `?list` or `?q=`.
- **`Vary: Accept` on every answer**, pages included. Without it a cache could serve JSON to a
  browser, or HTML to a caller.
- **Lists and search are JSON only.** `text/markdown` on them is a `406`. A GraphQL layer
  stringifies Markdown anyway, so JSON is the shape that matters there. Markdown is offered for
  Concepts because agents read it directly.
- **One handler.** `crates/sunstone-server/src/routes_content.rs` does the negotiation and the
  answers. Sunstone Web's SvelteKit hook forwards a page request that wants the API to
  `/_api/content/<path>`. `sunstone serve` calls the same code from its app-shell fallback,
  after built files. The hook's yes/no check (`wantsContentApi` in
  `src/lib/server/apiProxy.ts`) mirrors Rust `negotiate`, and both test files pin the same cases.
- **Reads stay open**, like the rest of the read routes. History is not part of it.

## Consequences

The URL a reader shares is the URL a caller fetches. The JSON shapes are now a public contract,
so changing them needs the same care as a breaking change. The `/_api/*` routes stay private
and free to change.
