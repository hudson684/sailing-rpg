import { get, set } from "idb-keyval";
import { metaStore } from "./store/idbShared";

const KEY = "meta:playerId";

/**
 * PlayerId is generated on first run and persisted outside any save slot. It's
 * stable across slots and across game reinstalls (until IDB is cleared). When
 * accounts / sync land, this is the local id a server-side user can claim.
 */
export async function getOrCreatePlayerId(): Promise<string> {
  const existing = await get<string>(KEY, metaStore);
  if (existing && typeof existing === "string" && existing.length > 0) return existing;
  const fresh = randomUuid();
  await set(KEY, fresh, metaStore);
  return fresh;
}

function randomUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback: RFC4122 v4 via crypto.getRandomValues.
  const bytes = new Uint8Array(16);
  (g.crypto as { getRandomValues?: (a: Uint8Array) => Uint8Array }).getRandomValues!(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** Exported so other modules (SaveManager) can mint uuids without reimporting. */
export const uuid = randomUuid;
