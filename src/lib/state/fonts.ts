/**
 * User font overrides (pure logic; combined with the colours by `appearance.ts`).
 *
 * Three roles, each with an optional family, size and font files, set by hand
 * under `fonts` in `config.json` (desktop: `~/.config/sunstone/config.json`;
 * web: the file `SUNSTONE_CONFIG` names):
 *
 *   { "fonts": {
 *       "ui":      { "family": "Inter, sans-serif", "size": 15, "files": ["Inter.woff2"] },
 *       "content": { "family": "Charter, Georgia, serif", "size": 16 },
 *       "code":    { "family": "JetBrains Mono", "size": 0.85,
 *                    "files": [{ "src": "fonts/JBM.woff2", "weight": "100 800" }] } } }
 *
 * `ui` and `content` sizes are px at 100% zoom; `code`'s is a factor of the
 * surrounding text. Files sit next to the config and are registered with
 * `@font-face` under the role's private family (`'Sunstone UI'`, …), which the
 * override puts first in the role's stack — so a file wins over an installed
 * font, and a role with files but no `family` still uses them. The private name
 * appears only when the role has files: WebKitGTK (the Linux desktop) asks
 * fontconfig for an unknown family and takes its substitute, so a stack led by
 * a name with no `@font-face` would never reach Jost.
 *
 * Everything is validated syntactically here, with no DOM (the web SSR emits
 * the same stylesheet): a value that could break out of its declaration is
 * dropped, as is anything out of range.
 */

const SANS = "'Jost Variable', 'Jost', system-ui, -apple-system, sans-serif";

/**
 * Role → its family token, size token, private `@font-face` family, size range,
 * and the default stack `app.css` declares (the fallback behind a file-backed
 * face when no `family` is set; a test keeps the two in step).
 */
export const FONT_ROLES = {
  ui: { family: '--font-ui', size: '--font-ui-size', face: 'Sunstone UI', unit: 'px', min: 8, max: 32, stack: SANS },
  content: {
    family: '--font-content',
    size: '--font-content-size',
    face: 'Sunstone Content',
    unit: 'px',
    min: 8,
    max: 48,
    stack: SANS,
  },
  code: {
    family: '--font-mono',
    size: '--font-code-scale',
    face: 'Sunstone Code',
    unit: '',
    min: 0.5,
    max: 2,
    stack: "ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace",
  },
} as const;

export type FontRoleName = keyof typeof FONT_ROLES;

export interface FontFile {
  /** Path relative to the config's directory, as written in the config. */
  src: string;
  /** `font-weight` descriptor: `"400"`, `"100 900"`, `"bold"`, … */
  weight?: string;
  /** `font-style` descriptor. */
  style?: 'normal' | 'italic' | 'oblique';
}

export interface FontRole {
  family?: string;
  size?: number;
  files: FontFile[];
}

export type Fonts = Partial<Record<FontRoleName, FontRole>>;

/** File extension → `format()` hint. Mirrors `appearance::font_content_type` in Rust. */
const FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * One family name: a quoted string, or space-separated identifiers. Quoted
 * names exclude `<>{};` too — the stylesheet is also inlined into SSR HTML.
 */
const FAMILY_NAME = /^(?:"[^"\\\n<>{};]*"|'[^'\\\n<>{};]*'|-?[\p{L}_][\p{L}\p{N}_-]*(?:\s+-?[\p{L}_][\p{L}\p{N}_-]*)*)$/u;

/** Whether `value` is a `font-family` list — comma-separated names, nothing else. */
export function isFontFamily(value: string): boolean {
  if (value.length > 500) return false;
  const names = value.split(',').map((n) => n.trim());
  // A comma inside a quoted name would split it; such names are vanishingly rare.
  return names.every((n) => FAMILY_NAME.test(n));
}

function fileExtension(src: string): string {
  const dot = src.lastIndexOf('.');
  return dot < 0 || src.lastIndexOf('/') > dot ? '' : src.slice(dot + 1).toLowerCase();
}

/**
 * A config-relative font path: a font extension, no absolute path, no `..` or
 * hidden segment (the server refuses those anyway), nothing CSS-significant.
 */
function isFontPath(src: string): boolean {
  if (src === '' || src.length > 300 || /["'\\\n\r]/.test(src)) return false;
  if (src.startsWith('/') || /^[A-Za-z]:/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg.startsWith('.'))) return false;
  return fileExtension(src) in FORMATS;
}

const WEIGHT = /^(?:normal|bold|\d{1,4}(?: \d{1,4})?)$/;
const STYLES = ['normal', 'italic', 'oblique'] as const;

function parseFile(raw: unknown): FontFile | null {
  const entry = typeof raw === 'string' ? { src: raw } : raw;
  if (!isRecord(entry) || typeof entry.src !== 'string') return null;
  const src = entry.src.trim();
  if (!isFontPath(src)) return null;
  const file: FontFile = { src };
  const weight = typeof entry.weight === 'number' ? String(entry.weight) : entry.weight;
  if (typeof weight === 'string' && WEIGHT.test(weight.trim())) file.weight = weight.trim();
  const style = STYLES.find((s) => s === entry.style);
  if (style) file.style = style;
  return file;
}

function parseRole(raw: unknown, name: FontRoleName): FontRole | null {
  if (!isRecord(raw)) return null;
  const role: FontRole = { files: [] };
  if (typeof raw.family === 'string' && isFontFamily(raw.family.trim()) && raw.family.trim() !== '') {
    role.family = raw.family.trim();
  }
  const { min, max } = FONT_ROLES[name];
  if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= min && raw.size <= max) {
    role.size = raw.size;
  }
  if (Array.isArray(raw.files)) {
    role.files = raw.files.map(parseFile).filter((f): f is FontFile => f !== null);
  }
  return role.family || role.size !== undefined || role.files.length > 0 ? role : null;
}

/** Parse the opaque `fonts` value; unknown roles and invalid fields are dropped. */
export function parseFonts(raw: unknown): Fonts {
  const out: Fonts = {};
  if (!isRecord(raw)) return out;
  for (const name of Object.keys(FONT_ROLES) as FontRoleName[]) {
    const role = parseRole(raw[name], name);
    if (role) out[name] = role;
  }
  return out;
}

function fontFace(face: string, file: FontFile, fontUrl: (src: string) => string): string {
  const lines = [
    `  font-family: '${face}';`,
    `  src: url("${fontUrl(file.src)}") format('${FORMATS[fileExtension(file.src)]}');`,
  ];
  if (file.weight) lines.push(`  font-weight: ${file.weight};`);
  if (file.style) lines.push(`  font-style: ${file.style};`);
  lines.push('  font-display: swap;');
  return `@font-face {\n${lines.join('\n')}\n}\n`;
}

/**
 * The font stylesheet: one `@font-face` per file, then one `:root` rule with
 * the overridden tokens. `''` when nothing is set. `fontUrl` turns a config-relative
 * file into the URL its shell serves it at (`Backend.fontUrl`).
 */
export function fontsCss(fonts: Fonts, fontUrl: (src: string) => string): string {
  const faces: string[] = [];
  const decls: string[] = [];
  for (const name of Object.keys(FONT_ROLES) as FontRoleName[]) {
    const role = fonts[name];
    if (!role) continue;
    const spec = FONT_ROLES[name];
    for (const file of role.files) faces.push(fontFace(spec.face, file, fontUrl));
    const family = role.files.length > 0 ? `'${spec.face}', ${role.family ?? spec.stack}` : role.family;
    if (family) decls.push(`  ${spec.family}: ${family};`);
    if (role.size !== undefined) decls.push(`  ${spec.size}: ${role.size}${spec.unit};`);
  }
  const root = decls.length > 0 ? `:root {\n${decls.join('\n')}\n}\n` : '';
  return faces.join('') + root;
}
