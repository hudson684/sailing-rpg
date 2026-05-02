import { createRegistry } from "../data/createRegistry";
import kindData from "../data/businessKinds.json";
import bizData from "../data/businesses.json";
import type { BusinessDef, BusinessKindDef } from "./businessTypes";

const RAW_KINDS = (kindData as unknown as { kinds: BusinessKindDef[] }).kinds;
const RAW_BIZ = (bizData as unknown as { businesses: BusinessDef[] }).businesses;

export const businessKinds = createRegistry<BusinessKindDef>(RAW_KINDS, {
  label: "businessKind",
});

export const businesses = createRegistry<BusinessDef>(RAW_BIZ, {
  label: "business",
});

// Sanity: every business references a known kind.
for (const b of RAW_BIZ) {
  if (!businessKinds.has(b.kindId)) {
    throw new Error(
      `business "${b.id}" references unknown kindId "${b.kindId}"`,
    );
  }
}

export const ALL_BUSINESS_IDS: string[] = RAW_BIZ.map((b) => b.id);

/** Reverse index: interiorKey → businessId. Lets the interior tilemap discover
 *  which business "owns" the layer-gating context for a given map without the
 *  scene having to plumb that through the launch payload. */
const BUSINESS_BY_INTERIOR_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const b of RAW_BIZ) {
    if (!b.interiorKey) continue;
    if (map.has(b.interiorKey)) {
      throw new Error(
        `Two businesses share interiorKey "${b.interiorKey}": "${map.get(b.interiorKey)}" and "${b.id}"`,
      );
    }
    map.set(b.interiorKey, b.id);
  }
  return map;
})();

export function businessIdForInteriorKey(key: string): string | null {
  return BUSINESS_BY_INTERIOR_KEY.get(key) ?? null;
}
