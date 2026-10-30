// The registered OKF key families: completion's ONLY list of them.
//
// To extend a family's completions, edit its own module here. To add a family,
// write `./<family>.ts` exporting an `OkfFamily` (see `../family.ts`) and
// append it below; its lint rules go in `sunstone_shared::okf_lint` (Rust),
// under the same id.

import type { OkfFamily } from '../family';
import { computation } from './computation';
import { core } from './core';
import { lifecycle } from './lifecycle';
import { provenance } from './provenance';
import { trust } from './trust';

export const OKF_FAMILIES: readonly OkfFamily[] = [core, provenance, trust, lifecycle, computation];
