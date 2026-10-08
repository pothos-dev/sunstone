import { describe, expect, test } from 'bun:test';
import { updateNoticeLink, updateNoticeText } from './updateNotice';
import type { UpdateNotice } from '$lib/types';

const notice = (kind: UpdateNotice['kind']): UpdateNotice => ({
  kind,
  version: '1.2.3',
  url: 'https://github.com/pothos-dev/sunstone/releases/tag/v1.2.3',
});

describe('updateNoticeText', () => {
  test('names the version and when it takes effect', () => {
    expect(updateNoticeText(notice('installed'))).toBe(
      'Sunstone 1.2.3 is installed. It runs from the next start.',
    );
    expect(updateNoticeText(notice('installsOnExit'))).toBe(
      'Sunstone 1.2.3 is downloaded. It installs when you close Sunstone.',
    );
    expect(updateNoticeText(notice('available'))).toBe('Sunstone 1.2.3 is available.');
  });
});

describe('updateNoticeLink', () => {
  test('only a version this install cannot take links to its download', () => {
    expect(updateNoticeLink(notice('available'))).toBe('Download');
    expect(updateNoticeLink(notice('installed'))).toBeNull();
    expect(updateNoticeLink(notice('installsOnExit'))).toBeNull();
  });
});
