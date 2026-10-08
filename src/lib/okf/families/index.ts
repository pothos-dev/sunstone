// The registered OKF key families: the language service's ONLY list of them.
//
// To extend a family (ov-9 trust, ov-10 provenance, ov-11 lifecycle): edit its
// own module here, adding `rules`, `required` keys or `completions`. To add one
// (ov-12's computation contract): write `./<family>.ts` exporting an
// `OkfFamily` (see `../family.ts`) and append it below. Neither the lint nor
// the completion engine changes.

import type { OkfFamily } from '../family';
import { core } from './core';
import { lifecycle } from './lifecycle';
import { provenance } from './provenance';
import { trust } from './trust';

export const OKF_FAMILIES: readonly OkfFamily[] = [core, provenance, trust, lifecycle];
