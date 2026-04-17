import { z } from "zod";

export const ENVELOPE_VERSION = 1 as const;

export const SLOT_IDS = ["slot1", "slot2", "slot3", "autosave", "quicksave"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const MANUAL_SLOT_IDS: readonly SlotId[] = ["slot1", "slot2", "slot3"] as const;

export const SystemBlockSchema = z.object({
  version: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type SystemBlock = z.infer<typeof SystemBlockSchema>;

export const SaveEnvelopeSchema = z.object({
  id: z.string().min(1),
  playerId: z.string().min(1),
  slot: z.enum(SLOT_IDS),
  schemaVersion: z.literal(ENVELOPE_VERSION),
  gameVersion: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  playtimeMs: z.number().int().nonnegative(),
  sceneKey: z.string(),
  systems: z.record(z.string(), SystemBlockSchema),
});
export type SaveEnvelope = z.infer<typeof SaveEnvelopeSchema>;

export function slotKey(slot: SlotId): string {
  return `save:${slot}`;
}

export function isSlotKey(key: string): boolean {
  return key.startsWith("save:") && (SLOT_IDS as readonly string[]).includes(key.slice(5));
}
