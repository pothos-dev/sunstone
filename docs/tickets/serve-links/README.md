# Serve links

Deep links under `sunstone serve` ([ADR 0012](/adr/0012-sunstone-serve-runs-the-desktop-spa-over-http.md)):
the page URL names the Concept the served desktop SPA opens, and the address bar
follows the active Tile so a copied URL or a reload lands back on it.

Binding for every ticket here: a URL the address bar writes must resolve back to
the same Concept on reload. Sunstone Web's routing (SSR `load`) is out of scope.
