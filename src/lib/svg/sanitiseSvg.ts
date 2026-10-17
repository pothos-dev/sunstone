/**
 * The sanitiser for author-controlled inline SVG (dr-2). Diagram SVG from D2
 * (dr-3) and embedded `.svg` files (af-2) pass through here before they are
 * inserted into the app document.
 *
 * Built on DOMPurify's SVG profile, which removes `<script>`, `on*`
 * attributes, `<foreignObject>`, `<iframe>`/`<embed>`/`<object>` and the
 * `javascript:` URLs it knows about. On top of that this module removes:
 *
 * - `href` / `xlink:href` that is not a `#fragment`, and the `<use>`,
 *   `<image>` and `<feImage>` left without one
 * - any attribute whose value is a `javascript:`, `vbscript:` or `data:` URL,
 *   or holds a `url(...)` that is not a `#fragment`
 * - the network reach of every `style` attribute and `<style>` element (see
 *   `sanitiseCss.ts`), keeping `data:` fonts inside `@font-face`
 * - SMIL animation elements, which can rewrite attributes after sanitising
 *
 * Ids are not namespaced here; per-diagram uniqueness is the caller's job.
 */

import createDOMPurify, { type Config, type DOMPurify, type WindowLike } from 'dompurify';

import { sanitiseCss } from './sanitiseCss';

const PURIFY_CONFIG: Config = {
	USE_PROFILES: { svg: true, svgFilters: true },
	// DOMPurify drops `<use>` by default; it is how diagrams reuse a shape, and
	// its href is held to a `#fragment` below.
	ADD_TAGS: ['use'],
	// Lower-case: DOMPurify compares lower-cased names in an HTML document.
	FORBID_TAGS: [
		'script',
		'foreignobject',
		'iframe',
		'embed',
		'object',
		'animate',
		'animatecolor',
		'animatemotion',
		'animatetransform',
		'set',
		'discard',
	],
	// A removed element takes its children with it (`<foreignObject>` content).
	KEEP_CONTENT: false,
};

/** Elements that are nothing but a pointer: without a local href they go. */
const REFERENCE_ELEMENTS = new Set(['use', 'image', 'feimage']);

/** Leading/trailing C0 controls and spaces, which URL parsing ignores. */
const URL_PADDING = /^[\u0000- ]+|[\u0000- ]+$/g;

/** The forms a browser would still read as a scheme after stripping noise. */
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data):/i;

const purifiers = new WeakMap<object, DOMPurify>();

function purifierFor(win: WindowLike | undefined): DOMPurify {
	if (!win) throw new Error('sanitiseSvg: no DOM to parse in (it runs client-side only)');
	let purifier = purifiers.get(win);
	if (!purifier) {
		purifier = createDOMPurify(win);
		purifiers.set(win, purifier);
	}
	// An unsupported DOM turns DOMPurify into a pass-through. Refuse instead.
	if (!purifier.isSupported) throw new Error('sanitiseSvg: DOMPurify is not supported in this DOM');
	return purifier;
}

function isHrefName(name: string): boolean {
	return name === 'href' || name === 'xlink:href';
}

function sanitiseAttributes(el: Element): void {
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name.toLowerCase();
		const value = attr.value;
		if (name.startsWith('on')) {
			el.removeAttribute(attr.name);
		} else if (isHrefName(name)) {
			if (!value.replace(URL_PADDING, '').startsWith('#')) el.removeAttribute(attr.name);
		} else if (name === 'style') {
			const css = sanitiseCss(value);
			if (css.trim() === '') el.removeAttribute(attr.name);
			else if (css !== value) el.setAttribute(attr.name, css);
		} else {
			const compact = value.replace(/[\u0000- ]/g, '');
			const urlsOk = !/url\s*\(/i.test(value) || sanitiseCss(value) === value;
			if (DANGEROUS_SCHEME.test(compact) || !urlsOk) el.removeAttribute(attr.name);
		}
	}
}

function hasLocalHref(el: Element): boolean {
	return Array.from(el.attributes).some((a) => isHrefName(a.name.toLowerCase()));
}

/**
 * Sanitise an SVG string for insertion into the app document. `win` is the
 * DOM to parse in; it defaults to the page's `window` and exists for tests.
 */
export function sanitiseSvg(svg: string, win: WindowLike = globalThis.window): string {
	// RETURN_DOM hands back the parse document's <body>.
	const body = purifierFor(win).sanitize(svg, { ...PURIFY_CONFIG, RETURN_DOM: true }) as HTMLElement;

	const elements = Array.from(body.getElementsByTagName('*'));
	for (const el of elements) sanitiseAttributes(el);
	for (const el of elements) {
		const tag = el.localName.toLowerCase();
		if (tag === 'style') {
			el.textContent = sanitiseCss(el.textContent ?? '', { allowFontData: true });
		} else if (REFERENCE_ELEMENTS.has(tag) && !hasLocalHref(el)) {
			el.remove();
		}
	}
	return body.innerHTML;
}
