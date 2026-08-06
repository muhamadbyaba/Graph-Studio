import type { JurisdictionPack } from './types.ts';
import { GULF_V1 } from './gulf.ts';
import { US_V1 } from './us.ts';

/** Available jurisdiction packs. A project pins one; switching re-validates the whole model. */
export const JURISDICTIONS: Record<string, JurisdictionPack> = {
  GULF: GULF_V1,
  US: US_V1,
};

export function jurisdictionList(): { id: string; name: string }[] {
  return Object.entries(JURISDICTIONS).map(([id, p]) => ({ id, name: `${id} — ${p.standardRef.split(' — ')[0]}` }));
}
