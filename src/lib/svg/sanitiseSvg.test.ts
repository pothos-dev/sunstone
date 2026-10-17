import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';

import { sanitiseCss } from './sanitiseCss';
import { sanitiseSvg } from './sanitiseSvg';

// `bun test` has no DOM. jsdom is the DOM DOMPurify's own suite runs on;
// happy-dom was tried and DOMPurify silently mis-sanitises under it (it kept
// `onerror`), which is exactly the failure the first test below guards against.
const win = new JSDOM('').window as unknown as WindowLike & Window;

const XLINK = 'http://www.w3.org/1999/xlink';
const svg = (inner: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="${XLINK}" viewBox="0 0 10 10">${inner}</svg>`;

/** Sanitise, then parse the result back so assertions can query it. */
function clean(input: string): { html: string; root: HTMLElement } {
	const html = sanitiseSvg(input, win);
	const root = win.document.createElement('div');
	root.innerHTML = html;
	return { html, root };
}

const all = (root: Element, tag: string) =>
	Array.from(root.getElementsByTagName('*')).filter((e) => e.localName.toLowerCase() === tag.toLowerCase());

describe('the test DOM', () => {
	test('DOMPurify is supported under it and is not a pass-through', () => {
		expect(createDOMPurify(win).isSupported).toBe(true);
		const input = svg('<script>alert(1)</script><rect width="1" onload="alert(2)"/>');
		const { html, root } = clean(input);
		expect(html).not.toBe(input);
		expect(html).not.toContain('alert');
		expect(all(root, 'rect')).toHaveLength(1);
	});

	test('refuses to run in a DOM DOMPurify does not support, rather than passing input through', () => {
		expect(() => sanitiseSvg(svg('<script>alert(1)</script>'), {} as WindowLike)).toThrow(/not supported/);
		// `bun test` itself has no window: the default must throw, not pass through.
		expect(() => sanitiseSvg(svg('<script>alert(1)</script>'))).toThrow(/no DOM/);
	});
});

describe('stripped constructs', () => {
	test('<script>, inline or by href', () => {
		const { html } = clean(
			svg(`<script>alert(1)</script><script href="https://evil/x.js"/><script xlink:href="data:,alert(1)"/>`),
		);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toContain('alert');
		expect(html).not.toContain('evil');
	});

	test('every on* attribute, whatever its case', () => {
		const { html, root } = clean(
			`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g onclick="alert(2)" ONMOUSEOVER="alert(3)"><rect onfocusin="alert(4)" width="1"/></g></svg>`,
		);
		expect(html).not.toMatch(/\son\w+=/i);
		expect(html).not.toContain('alert');
		expect(all(root, 'rect')).toHaveLength(1);
	});

	test('<iframe>, <embed> and <object>', () => {
		const { html } = clean(
			svg(
				`<iframe src="https://evil/frame"></iframe><embed src="https://evil/e.swf"/><object data="https://evil/o">fallback</object>`,
			) + `<iframe src="https://evil/top"></iframe>`,
		);
		expect(html).not.toMatch(/<(iframe|embed|object)/i);
		expect(html).not.toContain('evil');
		expect(html).not.toContain('fallback');
	});

	test('<foreignObject> and everything inside it', () => {
		const { html, root } = clean(
			svg(
				`<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><p>SECRET label</p><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="1"/>`,
			),
		);
		expect(html).not.toMatch(/foreignObject/i);
		expect(html).not.toContain('SECRET');
		expect(html).not.toMatch(/<(div|p|img)\b/i);
		expect(all(root, 'rect')).toHaveLength(1);
	});

	test('javascript: URLs in any attribute, however disguised', () => {
		const { html } = clean(
			svg(
				`<a href="javascript:alert(1)"><text>a</text></a>` +
					`<a xlink:href="  JaVaScRiPt:alert(2)"><text>b</text></a>` +
					`<a href="java&#9;script:alert(3)"><text>c</text></a>` +
					`<rect width="1" filter="javascript:alert(4)" mask="vbscript:msgbox(5)"/>`,
			),
		);
		expect(html).not.toMatch(/script:/i);
		expect(html).not.toContain('alert');
		expect(html).not.toContain('msgbox');
	});

	test('data: URLs in any attribute', () => {
		const { html, root } = clean(
			svg(
				`<image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/>` +
					`<a xlink:href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"><text>x</text></a>` +
					`<rect width="1" fill="data:image/png;base64,AAAA"/>`,
			),
		);
		expect(html).not.toContain('data:');
		expect(all(root, 'image')).toHaveLength(0);
		expect(all(root, 'rect')).toHaveLength(1);
		expect(all(root, 'text')).toHaveLength(1);
	});

	test('href and xlink:href that are not #fragments; links keep their shapes', () => {
		const { html, root } = clean(
			svg(
				`<a href="https://example.com" xlink:href="https://example.com"><rect width="1"/></a>` +
					`<a href="//evil.example/x"><text>p</text></a>` +
					`<a href="relative/page.html"><text>q</text></a>` +
					`<image href="https://icons.example/i.svg" width="5" height="5"/>` +
					`<image xlink:href="//evil.example/i.png" width="5" height="5"/>` +
					`<filter id="f"><feImage href="https://evil.example/f.png"/></filter>`,
			),
		);
		expect(html).not.toMatch(/href=/i);
		expect(html).not.toContain('example');
		expect(all(root, 'image')).toHaveLength(0);
		expect(all(root, 'feImage')).toHaveLength(0);
		expect(all(root, 'a')).toHaveLength(3);
		expect(all(root, 'rect')).toHaveLength(1);
	});

	test('<use> that points outside the document', () => {
		const { html, root } = clean(
			svg(
				`<use href="https://evil.example/sprite.svg#icon"/>` +
					`<use xlink:href="other.svg#shape"/>` +
					`<use href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E#x"/>` +
					`<use/>`,
			),
		);
		expect(all(root, 'use')).toHaveLength(0);
		expect(html).not.toContain('sprite');
		expect(html).not.toContain('other.svg');
	});

	test('url(...) in a style attribute that is not a #fragment', () => {
		const { root } = clean(
			svg(
				`<rect id="a" width="1" style="fill:url(https://evil.example/p.svg#g);stroke:red"/>` +
					`<rect id="b" width="1" style="fill:url('data:image/png;base64,AAAA')"/>` +
					`<rect id="c" width="1" style="background-image:image-set('https://evil.example/i.png' 1x)"/>` +
					`<rect id="d" width="1" style="fill:u\\72l(https://evil.example/e)"/>`,
			),
		);
		const style = (id: string) => root.querySelector(`#${id}`)?.getAttribute('style') ?? null;
		expect(style('a')).toBe('fill:none;stroke:red');
		expect(style('b')).toBe('fill:none');
		expect(style('c')).not.toContain('evil');
		expect(style('d')).toBeNull();
	});

	test('url(...) in presentation attributes that is not a #fragment', () => {
		const { html, root } = clean(
			svg(`<rect width="1" fill="url(https://evil.example/p.svg#g)" mask="url( 'data:image/svg+xml,x' )"/>`),
		);
		expect(html).not.toContain('evil');
		expect(html).not.toContain('data:');
		expect(all(root, 'rect')).toHaveLength(1);
	});

	test('SMIL animation, which could rewrite an href after sanitising', () => {
		const { html } = clean(
			svg(
				`<a href="#x"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(2)"/><text>t</text></a>` +
					`<rect width="1"><animateTransform attributeName="transform" type="rotate" from="0" to="1" dur="1s"/><animateMotion dur="1s" path="M0 0"/></rect>`,
			),
		);
		expect(html).not.toMatch(/<(set|animate)/i);
		expect(html).not.toContain('alert');
	});
});

describe('inside <style>', () => {
	const style = (css: string) => {
		const { root } = clean(svg(`<style>${css}</style><rect class="a" width="1"/>`));
		const el = all(root, 'style')[0];
		return el?.textContent ?? '';
	};

	test('every @import goes, however it is written', () => {
		const css = style(
			`@import url("https://evil.example/a.css");\n@import 'https://evil.example/b.css' screen;\n@IMPORT "c.css";\n@im@import "x";port "https://evil.example/d.css";\n.a{fill:red}`,
		);
		expect(css).not.toMatch(/@import/i);
		expect(css).not.toContain('evil');
		expect(css).toContain('.a{fill:red}');
	});

	test('external and data: url() outside @font-face goes', () => {
		const css = style(
			`.a{fill:url(https://evil.example/p.svg#g)} .b{background:url("data:image/png;base64,AAAA")} .c{mask:url('//evil.example/m')} .d{background:image-set("https://evil.example/i.png" 1x)} .e{background:url("data:font/woff2;base64,AAAA")}`,
		);
		expect(css).not.toContain('evil');
		expect(css).not.toContain('data:');
		expect(css).toContain('.a{fill:none}');
	});

	test('inside @font-face, external and non-font data: urls go and font data stays', () => {
		const css = style(
			`@font-face{font-family:x;src:url("data:application/font-woff;base64,d09GRgAB")}` +
				`@font-face{font-family:y;src:url(https://evil.example/f.woff)}` +
				`@font-face{font-family:z;src:url("data:image/svg+xml;base64,PHN2Zy8+")}`,
		);
		expect(css).toContain('src:url("data:application/font-woff;base64,d09GRgAB")');
		expect(css).not.toContain('evil');
		expect(css).not.toContain('image/svg+xml');
	});

	test('CSS escapes that could spell url( or @import empty the stylesheet', () => {
		expect(style(`.a{background:\\75 rl(https://evil.example/x)}`)).toBe('');
		expect(style(`@\\69mport "https://evil.example/x.css";`)).toBe('');
	});

	test('a url( the parser cannot read empties the stylesheet', () => {
		expect(style(`.a{background:url("https://evil.example/x)}`)).toBe('');
	});

	test('comments cannot smuggle anything past', () => {
		const css = style(`.a{fill:red} /* } @font-face{src:url(data:font/woff;base64,AA)} */ .b{background:url(https://evil.example/x)}`);
		expect(css).not.toContain('evil');
		expect(css).not.toContain('data:');
		expect(css).toContain('.a{fill:red}');
	});
});

describe('what survives', () => {
	test('<style> keeps its ordinary rules and @font-face data fonts, minus @import and external url()', () => {
		const { root } = clean(
			svg(
				`<style><![CDATA[@import url(https://evil.example/a.css);
.d2-1 .fill-N1{fill:#0A0F25;}
.d2-1 > .stroke-B1{stroke:#0D32B2;}
@font-face{font-family:d2-1-font-regular;src:url("data:application/font-woff;base64,d09GRgABAAAA");}
.x{background:url(https://evil.example/bg.png)}]]></style><rect class="fill-N1" width="1"/>`,
			),
		);
		const css = all(root, 'style')[0]?.textContent ?? '';
		expect(css).toContain('.d2-1 .fill-N1{fill:#0A0F25;}');
		expect(css).toContain('.d2-1 > .stroke-B1{stroke:#0D32B2;}');
		expect(css).toContain(
			'@font-face{font-family:d2-1-font-regular;src:url("data:application/font-woff;base64,d09GRgABAAAA");}',
		);
		expect(css).not.toMatch(/@import/i);
		expect(css).not.toContain('evil');
		expect(all(root, 'rect')[0]?.getAttribute('class')).toBe('fill-N1');
	});

	test('#fragment references: gradients, markers, clip paths, masks and <use>', () => {
		const { root } = clean(
			svg(
				`<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>` +
					`<marker id="m"><path d="M0 0L1 1"/></marker><clipPath id="c"><rect width="5"/></clipPath>` +
					`<mask id="k"><rect width="5" fill="white"/></mask><symbol id="s"><circle r="1"/></symbol></defs>` +
					`<style>.f{fill:url(#g)}</style>` +
					`<rect id="r1" width="1" fill="url(#g)" clip-path="url(#c)" mask="url(#k)"/>` +
					`<path id="p1" d="M0 0L5 5" marker-end="url(#m)" style="stroke:url(#g)"/>` +
					`<use id="u1" href="#s"/><use id="u2" xlink:href="#s"/><a id="a1" href="#r1"><text>t</text></a>`,
			),
		);
		const attr = (id: string, name: string) => root.querySelector(`#${id}`)?.getAttribute(name);
		expect(attr('r1', 'fill')).toBe('url(#g)');
		expect(attr('r1', 'clip-path')).toBe('url(#c)');
		expect(attr('r1', 'mask')).toBe('url(#k)');
		expect(attr('p1', 'marker-end')).toBe('url(#m)');
		expect(attr('p1', 'style')).toBe('stroke:url(#g)');
		expect(attr('u1', 'href')).toBe('#s');
		expect(root.querySelector('#u2')?.getAttributeNS(XLINK, 'href')).toBe('#s');
		expect(attr('a1', 'href')).toBe('#r1');
		expect(all(root, 'style')[0]?.textContent).toBe('.f{fill:url(#g)}');
		expect(all(root, 'linearGradient')).toHaveLength(1);
		expect(all(root, 'marker')).toHaveLength(1);
		expect(all(root, 'symbol')).toHaveLength(1);
	});
});

describe('a real D2 diagram', () => {
	// Generated by @terrastruct/d2 0.1.33 (D2 v0.7): containers, a cylinder, a
	// dashed connection, an author-coloured shape, an `icon:` URL and a `link`.
	const fixture = readFileSync(new URL('./fixtures/d2-diagram.svg', import.meta.url), 'utf8');
	const parse = (html: string) => {
		const root = win.document.createElement('div');
		root.innerHTML = html;
		return root;
	};

	test('keeps its fonts, slot classes, styles and fragment references', () => {
		const { html, root } = clean(fixture);
		const css = all(root, 'style')
			.map((s) => s.textContent)
			.join('\n');
		expect(css).toMatch(/\.d2-\d+ \.fill-N1\{fill:#0A0F25;\}/);
		expect(css.match(/@font-face/g)).toHaveLength(3);
		expect(css.match(/src: url\("data:application\/font-woff;base64,/g)).toHaveLength(3);
		expect(all(root, 'svg')).toHaveLength(3);
		expect(root.querySelectorAll('.fill-N1').length).toBeGreaterThan(0);
		expect(html).toMatch(/marker-end="url\(#mk-d2-\d+-\d+\)"/);
		expect(html).not.toContain('https://');
	});

	test('passes through unchanged apart from the external icon and link', () => {
		const before = parse(fixture);
		const after = clean(fixture).root;

		// What the sanitiser is expected to drop: the `icon:` image and the link's hrefs.
		const isIcon = (e: Element) => e.localName === 'image';
		const beforeEls = Array.from(before.getElementsByTagName('*')).filter((e) => !isIcon(e));
		const afterEls = Array.from(after.getElementsByTagName('*'));
		expect(Array.from(before.getElementsByTagName('*')).filter(isIcon)).toHaveLength(1);
		expect(afterEls.map((e) => e.localName)).toEqual(beforeEls.map((e) => e.localName));

		const attrs = (e: Element) =>
			Object.fromEntries(
				Array.from(e.attributes)
					.filter((a) => !(e.localName === 'a' && a.localName === 'href'))
					// DOMPurify trims attribute values (D2 writes `class=" fill-N7"`).
					.map((a) => [a.name, a.value.trim()]),
			);
		afterEls.forEach((el, i) => {
			expect(attrs(el)).toEqual(attrs(beforeEls[i]));
			if (el.localName === 'style') expect(el.textContent).toBe(beforeEls[i].textContent);
		});
		expect(all(after, 'a')[0]?.attributes.length).toBe(0);
	});
});

describe('sanitiseCss', () => {
	test('leaves CSS with nothing to strip byte-identical', () => {
		const css = `.a > .b{fill:#fff;stroke:url(#g)} @media (prefers-color-scheme: dark){.a{fill:#000}}`;
		expect(sanitiseCss(css)).toBe(css);
	});

	test('keeps data: fonts only when asked, and only inside @font-face', () => {
		const css = `@font-face{src:url(data:font/woff2;base64,AA)}`;
		expect(sanitiseCss(css, { allowFontData: true })).toBe(css);
		expect(sanitiseCss(css)).toBe('@font-face{src:none}');
	});
});
