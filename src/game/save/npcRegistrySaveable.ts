import { z } from "zod";
import type { Saveable } from "./Saveable";
import { npcRegistry, type RegistrySnapshot } from "../sim/npcRegistry";

// Activity payloads (`{ kind, data }`) carry arbitrary per-activity state and
// re-validate at hydrate time via the kind→deserializer table. We don't
// re-validate `data` shape here — each activity's deserializer is the
// authoritative gate. Schema is intentionally permissive so a
// freshly-introduced activity kind doesn't require schema bumps.
const ActivitySchema = z.object({
  kind: z.string().min(1),
  data: z.unknown(),
});

const FacingSchema = z.enum(["up", "down", "left", "right"]);

const SceneKeySchema = z.string().refine(
  (s) => s.startsWith("chunk:") || s.startsWith("interior:"),
  { message: "sceneKey must be 'chunk:*' or 'interior:*'" },
);

const WorldLocationSchema = z.object({
  sceneKey: SceneKeySchema,
  tileX: z.number().int(),
  tileY: z.number().int(),
  facing: FacingSchema,
});

const BodySchema = z.object({
  px: z.number(),
  py: z.number(),
  facing: FacingSchema,
  anim: z.string(),
  spriteKey: z.string(),
});

const ItemStackSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().positive(),
});

const AgentSchema = z.object({
  id: z.string().min(1),
  archetypeId: z.string().min(1),
  location: WorldLocationSchema,
  body: BodySchema,
  dayPlan: z.array(ActivitySchema),
  currentActivityIndex: z.number().int().nonnegative(),
  currentActivityState: ActivitySchema.nullable(),
  traits: z.record(z.string(), z.unknown()),
  flags: z.record(z.string(), z.boolean()),
  inventory: z.array(ItemStackSchema),
});

const RegistrySnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  agents: z.array(AgentSchema),
});

/** Wires the global `npcRegistry` into the save system. The registry itself
 *  owns serialize/hydrate; this saveable just funnels the snapshot through
 *  the SaveManager. Treat a missing block as "no NPCs" so old saves load
 *  cleanly — the spawn dispatcher will refill on the next midnight tick. */
export function npcRegistrySaveable(): Saveable<RegistrySnapshot> {
  return {
    id: "npcRegistry",
    version: 1,
    schema: RegistrySnapshotSchema as unknown as z.ZodType<RegistrySnapshot>,
    serialize: () => npcRegistry.serialize(),
    hydrate: (data) => {
      // Empty agents array is a valid "fresh world" hydrate — the activity
      // registry doesn't need to look up any kinds and we leave the registry
      // empty so the spawn dispatcher repopulates from scratch.
      npcRegistry.hydrate(data);
    },
  };
}
