/**
 * CSS half of the SVG sanitiser (dr-2): makes the text of an SVG `<style>`
 * element, or of a `style` attribute, unable to reach the network.
 *
 * Pure string work, no DOM. DOMPurify does not look inside CSS at all, so
 * `sanitiseSvg.ts` runs every stylesheet and style attribute through here.
 *
 * What survives: ordinary rules, `url(#fragment)` references, and (inside
 * `@font-face` only, when `allowFontData` is set) `data:` font URLs, which is
 * how D2 embeds its fonts. What goes: every `@import`, every other `url(...)`,
 * and the image functions that take a bare string as a URL (`image-set()`,
 * `image()`, `cross-fade()`, `element()`).
 *
 * Fails closed: CSS that holds a backslash escape (`u\72l(` spells `url(`) or a
 * `url(` this module could not parse comes back as the empty string.
 */

/** A `data:` URL whose media type is a font (`font/woff2`, `application/font-woff`, ...). */
const FONT_DATA_URL = /^data:(?:font\/|application\/(?:x-)?font-)/i;

/** Every `url(...)`, quoted or not. The groups are the double-, single- and unquoted value. */
const URL_FN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** Functions that load an image from a bare string, no `url()` needed. */
const STRING_URL_FN = /[\w-]*(?:image-set|image|cross-fade|element)\s*\(/i;

/** An `@font-face` block. Descriptors hold no nested braces. */
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;

/** An `@import` statement up to its `;`. */
const IMPORT = /@import\b[^;{}]*;?/gi;

/**
 * Replace each call of a string-URL image function, arguments and all, with
 * `none`. Returns `null` when a call's parentheses do not close.
 */
function dropStringUrlFns(css: string): string | null {
	let out = '';
	let rest = css;
	for (let m = STRING_URL_FN.exec(rest); m; m = STRING_URL_FN.exec(rest)) {
		out += rest.slice(0, m.index) + 'none';
		let i = m.index + m[0].length;
		let depth = 1;
		let quote = '';
		for (; i < rest.length && depth > 0; i++) {
			const c = rest[i];
			if (quote) {
				if (c === quote) quote = '';
			} else if (c === '"' || c === "'") quote = c;
			else if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		if (depth > 0) return null;
		rest = rest.slice(i);
	}
	return out + rest;
}

function isAllowedUrl(value: string, allowFontData: boolean): boolean {
	const v = value.trim();
	return v.startsWith('#') || (allowFontData && FONT_DATA_URL.test(v));
}

/**
 * Neutralise the `url()`s of one stretch of CSS. Returns `null` when a `url(`
 * is left over that did not parse, so the caller can fail closed.
 */
function sanitiseUrls(css: string, allowFontData: boolean): string | null {
	const out = css.replace(URL_FN, (whole, dq?: string, sq?: string, bare?: string) =>
		isAllowedUrl(dq ?? sq ?? bare ?? '', allowFontData) ? whole : 'none',
	);
	// Whatever `url(` remains must be one we just allowed; anything else is a
	// form the pattern above did not understand.
	const leftovers = out.match(/url\s*\([^)]*\)?/gi) ?? [];
	for (const fn of leftovers) {
		const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)$/i.exec(fn);
		if (!m || !isAllowedUrl(m[1] ?? m[2] ?? m[3] ?? '', allowFontData)) return null;
	}
	return out;
}

export interface SanitiseCssOptions {
	/** Keep `data:` font URLs inside `@font-face` blocks (stylesheets only). */
	allowFontData?: boolean;
}

export function sanitiseCss(css: string, { allowFontData = false }: SanitiseCssOptions = {}): string {
	// Comments first, so nothing can hide inside one; an unterminated comment
	// runs to the end, as it does in a browser.
	let text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
	if (text.includes('\\')) return '';

	// Repeat until stable, so `@im@importport` cannot reassemble an `@import`.
	for (let prev = ''; prev !== text; ) {
		prev = text;
		text = text.replace(IMPORT, '');
	}
	const withoutFns = dropStringUrlFns(text);
	if (withoutFns === null) return '';
	text = withoutFns;

	let out = '';
	let last = 0;
	for (const m of text.matchAll(FONT_FACE)) {
		const before = sanitiseUrls(text.slice(last, m.index), false);
		const block = sanitiseUrls(m[0], allowFontData);
		if (before === null || block === null) return '';
		out += before + block;
		last = m.index + m[0].length;
	}
	const rest = sanitiseUrls(text.slice(last), false);
	if (rest === null) return '';
	return out + rest;
}
