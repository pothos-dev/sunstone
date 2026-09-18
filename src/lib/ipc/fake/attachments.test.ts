// Unit tests for the fake backend's Attachment fixture and for the URL shapes
// the three `Backend.attachmentUrl` implementations build (slice:
// attachment-files). The URL shapes are a CONTRACT other slices build against —
// the Rust `sunstone-asset://` scheme handler and the server's `GET /api/asset`
// route both parse what is asserted here.
import { describe, expect, test } from 'bun:test';
import { ATTACHMENTS, attachmentExists, attachmentPaths, fakeAttachmentUrl } from './attachments';
import { conceptPaths } from './store';
import { httpBackend } from '../http';
import { tauriBackend } from '../tauri';

describe('the Attachment fixture', () => {
  test('seeds decodable PNG and SVG payloads as data URLs', () => {
    // A Playwright spec asserts an Embed LOADED (naturalWidth > 0), so the bytes
    // must be real images — a placeholder string would render broken.
    expect(attachmentPaths().length).toBeGreaterThanOrEqual(3);
    for (const path of attachmentPaths()) {
      expect(ATTACHMENTS[path]).toMatch(/^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/);
    }
    // The PNG magic number survives the base64 round-trip.
    const png = ATTACHMENTS['assets/dot.png'].split(',')[1];
    expect(Buffer.from(png, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const svg = ATTACHMENTS['concepts/assets/mark.svg'].split(',')[1];
    expect(Buffer.from(svg, 'base64').toString('utf8')).toContain('<svg');
  });

  test('covers a square, a landscape and a vector Attachment', () => {
    expect(attachmentExists('assets/dot.png')).toBe(true); // 16x16
    expect(attachmentExists('concepts/assets/wide.png')).toBe(true); // 64x16
    expect(attachmentExists('concepts/assets/mark.svg')).toBe(true); // 48x48
    expect(attachmentExists('concepts/editor/assets/diagram.png')).toBe(true); // 96x32
    expect(attachmentExists('nope.png')).toBe(false);
  });

  test('every path is bundle-relative and forward-slash', () => {
    for (const path of attachmentPaths()) {
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toContain('\\');
      expect(path.endsWith('.md')).toBe(false);
    }
  });

  // The separate-index decision: Attachments are NOT Concepts, so nothing that
  // enumerates the Bundle's `.md` files may ever see one.
  test('no Attachment appears among the Concept paths', () => {
    const concepts = conceptPaths();
    for (const path of attachmentPaths()) expect(concepts).not.toContain(path);
  });
});

describe('attachmentUrl — URL shapes', () => {
  test('fake: a seeded path yields its data URL', () => {
    expect(fakeAttachmentUrl('assets/dot.png')).toBe(ATTACHMENTS['assets/dot.png']);
  });

  test('fake: an unseeded path still yields a URL (never throws)', () => {
    const url = fakeAttachmentUrl('assets/missing.png');
    expect(url.startsWith('data:')).toBe(false);
    expect(url).toContain(encodeURIComponent('assets/missing.png'));
  });

  test('tauri: the custom scheme, with the whole path percent-encoded', () => {
    // Mirrors Tauri's `convertFileSrc`: one encoded segment, so the Rust scheme
    // handler decodes the URL path ONCE to recover the bundle-relative path.
    expect(tauriBackend.attachmentUrl('assets/dot.png')).toBe(
      'sunstone-asset://localhost/assets%2Fdot.png',
    );
    expect(tauriBackend.attachmentUrl('my notes/a b.png')).toBe(
      'sunstone-asset://localhost/my%20notes%2Fa%20b.png',
    );
    // No `invoke`: it is pure string construction, so it needs no live IPC.
    expect(tauriBackend.attachmentUrl('')).toBe('sunstone-asset://localhost/');
  });

  test('http: /api/asset with the path as an encoded query parameter', () => {
    expect(httpBackend.attachmentUrl('concepts/assets/wide.png')).toBe(
      '/api/asset?path=concepts%2Fassets%2Fwide.png',
    );
    // Spaces and other URL-significant characters survive intact.
    expect(httpBackend.attachmentUrl('my notes/a&b.png')).toBe(
      '/api/asset?path=my%20notes%2Fa%26b.png',
    );
  });

  test('the method is synchronous — decoration builders cannot await', () => {
    // Guards the seam's one deliberate exception to "every Backend method is
    // async"; see the doc comment on `Backend.attachmentUrl`.
    expect(typeof httpBackend.attachmentUrl('a.png')).toBe('string');
    expect(typeof fakeAttachmentUrl('a.png')).toBe('string');
  });
});
