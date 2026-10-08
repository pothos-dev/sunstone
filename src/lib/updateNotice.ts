/**
 * User-facing copy for the desktop updater's notice (`UpdateNotice`), kept in
 * plain `.ts` so the wording is unit-tested and `UpdateNotice.svelte` stays a
 * thin view over it.
 */

import type { UpdateNotice } from '$lib/types';

/** The notice's sentence. */
export function updateNoticeText(notice: UpdateNotice): string {
  const name = `Sunstone ${notice.version}`;
  switch (notice.kind) {
    case 'installed':
      return `${name} is installed. It runs from the next start.`;
    case 'installsOnExit':
      return `${name} is downloaded. It installs when you close Sunstone.`;
    case 'available':
      return `${name} is available.`;
  }
}

/**
 * The label of the link to the version's release page, or `null` for no link.
 * Only an install that cannot update itself (`available`) needs one: it is
 * where the new package is downloaded.
 */
export function updateNoticeLink(notice: UpdateNotice): string | null {
  return notice.kind === 'available' ? 'Download' : null;
}
