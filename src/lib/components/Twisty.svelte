<!-- Disclosure triangle for twisties and section chevrons, drawn as SVG in
     `currentColor`. A text glyph (`▸`) is not in Jost, so each OS drew it from
     its own fallback font at a different size (tiny on macOS). Sized to the
     surrounding font; the wrapper span owns colour and the open rotation. -->
<svg class="twisty-glyph" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
  <path d="M4.5 3.5 L12.5 8 L4.5 12.5 Z" fill="currentColor" />
</svg>

<style>
  .twisty-glyph {
    display: block;
  }
</style>
