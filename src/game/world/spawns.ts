import * as Phaser from "phaser";
import type { ItemId } from "../inventory/items";

export interface ItemSpawn {
  kind: "item_spawn";
  /** Stable cross-session identity. Stamped into source TMX by the map
   *  build pipeline — never reassign. */
  uid: string;
  tileX: number;
  tileY: number;
  itemId: ItemId;
  quantity: number;
}

/** A door painted in a world chunk. Pressing E (or stepping on, depending on
 *  variant) enters the named interior, placing the player at (entryTx, entryTy)
 *  in interior-local tile coords. The door's own tile is the player's
 *  return spot when leaving the interior. */
export interface DoorSpawn {
  kind: "door";
  uid: string;
  tileX: number;
  tileY: number;
  interiorKey: string;
  entryTx: number;
  entryTy: number;
}

/** A tile in an interior map that, when stepped on (or interacted with), exits
 *  back to the world at the door's saved return position. */
export interface InteriorExitSpawn {
  kind: "interior_exit";
  uid: string;
  tileX: number;
  tileY: number;
  /** When true, requires E-press instead of auto-triggering on step. */
  promptOnly: boolean;
}

/** A tile in an interior map where the player is placed when entering through
 *  any door that links to this interior. Authored in the interior's `objects`
 *  layer as a Tiled object of type `interior_entry`. */
export interface InteriorEntrySpawn {
  kind: "interior_entry";
  uid: string;
  tileX: number;
  tileY: number;
  /** Optional override for the player's facing on entry. When omitted, the
   *  scene picks a sensible default (up — i.e. facing into the interior). */
  facing?: string;
}

/** A static light source (torch, lantern, campfire) painted into a chunk's
 *  `torches` object layer. The lighting system reads these on chunk-ready and
 *  registers a fixed point light at the tile center. */
export interface TorchSpawn {
  kind: "torch";
  uid: string;
  tileX: number;
  tileY: number;
  /** Light radius in tiles. Defaults to 2. */
  radiusTiles: number;
  /** Hex color (0xRRGGBB) of the warm tint over the lit area. */
  color: number;
  /** 0–1 strength of the carve through the darkness. Default 0.95. */
  intensity: number;
  /** 0–1 strength of the warm color overlay. Default 0.45. */
  tintStrength: number;
}

/** A `npcResidence` Tiled object — pins a hired staff member's home tile to
 *  a world location. Phase 8's WorkAt+Sleep schedule walks the staffer here
 *  outside their shift. The `hireableId` property links to the
 *  `hireables.json` candidate id that was hired into a business; one
 *  residence per hireable. */
export interface NpcResidenceSpawn {
  kind: "npc_residence";
  uid: string;
  tileX: number;
  tileY: number;
  /** Resolves to a `HireableDef.id` in `hireables.json`. */
  hireableId: string;
}

/** A `npcSpawnPoint` Tiled object — anchors a sim-layer spawn group at a world
 *  tile. The dispatcher (sim/planner/spawnDispatcher.ts) consumes these on
 *  chunk-ready and turns scheduled arrivals into NPC agents at this tile. */
export interface NpcSpawnPointSpawn {
  kind: "npc_spawn_point";
  uid: string;
  tileX: number;
  tileY: number;
  /** Resolves to an entry in `src/game/sim/data/spawnGroups.json`. Validated
   *  at build time by `tools/validate-spawn-refs.mjs`. */
  spawnGroupId: string;
}

export type Spawn =
  | ItemSpawn
  | DoorSpawn
  | InteriorExitSpawn
  | InteriorEntrySpawn
  | TorchSpawn
  | NpcSpawnPointSpawn
  | NpcResidenceSpawn;

export interface ParsedSpawns {
  items: ItemSpawn[];
  doors: DoorSpawn[];
  torches: TorchSpawn[];
  npcSpawnPoints: NpcSpawnPointSpawn[];
  npcResidences: NpcResidenceSpawn[];
}

/** A `repair_target` object placed inside an interior map. Stands in for a
 *  broken-but-fixable feature (the bar, the kitchen, a door). When the player
 *  presses E nearby and confirms, the linked upgrade node is unlocked which
 *  in turn flips layer visibility (see `interiorTilemap.ts`). */
export interface RepairTargetSpawn {
  kind: "repair_target";
  uid: string;
  tileX: number;
  tileY: number;
  /** Business this repair belongs to. Lets one interior host multiple
   *  businesses (e.g. shared building) without the engine having to guess. */
  businessId: string;
  /** Upgrade-node id in the kind's `upgradeTree`. */
  nodeId: string;
}

/** A `seat` object placed inside an interior map. The customer sim picks a
 *  free seat (one not already in its claimed-set) for each arriving customer
 *  to walk to. Seats are interchangeable for now — no per-seat configuration
 *  beyond the tile position. */
export interface SeatSpawn {
  kind: "seat";
  uid: string;
  tileX: number;
  tileY: number;
}

/** A `workstation` object placed inside an interior map. Anchors hired-staff
 *  NPC spawns: each `RoleDef.workstationTag` matches one or more
 *  `WorkstationSpawn.tag` values. Hired staff with that role wander a short
 *  radius around the matching workstation tile. */
export interface WorkstationSpawn {
  kind: "workstation";
  uid: string;
  tileX: number;
  tileY: number;
  /** Maps to `RoleDef.workstationTag` in `businessKinds.json`. */
  tag: string;
}

/** A `npcBrowseWaypoint` Tiled object placed inside a shop interior. The
 *  `BrowseActivity` samples one of these per visit and pathfinds to it,
 *  giving NPCs visible variation while loitering. Multi-zone shops may tag
 *  waypoints with `browseGroupId`; un-tagged waypoints default to `"all"`. */
export interface NpcBrowseWaypointSpawn {
  kind: "npc_browse_waypoint";
  uid: string;
  tileX: number;
  tileY: number;
  /** Optional sub-zone id; defaults to `"all"` when omitted in Tiled. */
  browseGroupId: string;
}

/** A `npcStandingSpot` Tiled object placed inside a shop interior. Patrons
 *  running `StandAroundActivity` claim one of these (atomically reserving it),
 *  walk there, dwell ~20s wallclock, release, and pick another. The
 *  reservation prevents two patrons from selecting the same spot while one is
 *  still walking to it. Multi-zone shops may tag spots with `standingGroupId`;
 *  un-tagged spots default to `"all"`. */
export interface NpcStandingSpotSpawn {
  kind: "npc_standing_spot";
  uid: string;
  tileX: number;
  tileY: number;
  /** Optional sub-zone id; defaults to `"all"` when omitted in Tiled. */
  standingGroupId: string;
}

/** Spawns parsed from a standalone interior map. */
export interface InteriorParsedSpawns {
  exits: InteriorExitSpawn[];
  entries: InteriorEntrySpawn[];
  items: ItemSpawn[];
  repairTargets: RepairTargetSpawn[];
  workstations: WorkstationSpawn[];
  seats: SeatSpawn[];
  browseWaypoints: NpcBrowseWaypointSpawn[];
  standingSpots: NpcStandingSpotSpawn[];
}

export interface ParseSpawnsOptions {
  /** Global tile X of the chunk's top-left — added to each object's local tile. */
  offsetTx?: number;
  offsetTy?: number;
}

interface TiledObjectLike {
  x?: number;
  y?: number;
  type?: string;
  properties?: TiledProperty[];
}

function collectSpawns(
  objects: TiledObjectLike[],
  tw: number,
  th: number,
  offsetTx: number,
  offsetTy: number,
): ParsedSpawns {
  const items: ItemSpawn[] = [];
  const doors: DoorSpawn[] = [];
  const torches: TorchSpawn[] = [];
  const npcSpawnPoints: NpcSpawnPointSpawn[] = [];
  const npcResidences: NpcResidenceSpawn[] = [];

  for (const raw of objects) {
    const props = propMap(raw.properties);
    const tileX = Math.floor((raw.x ?? 0) / tw) + offsetTx;
    const tileY = Math.floor((raw.y ?? 0) / th) + offsetTy;
    switch (raw.type) {
      case "item_spawn": {
        const itemId = String(props.itemId ?? "") as ItemId;
        const quantity = Number(props.quantity ?? 1);
        const uid = String(props.uid ?? "");
        if (!itemId) throw new Error(`item_spawn at (${tileX},${tileY}) missing itemId`);
        if (!uid) {
          throw new Error(
            `item_spawn at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        items.push({ kind: "item_spawn", uid, tileX, tileY, itemId, quantity });
        break;
      }
      case "door": {
        const interiorKey = String(props.interiorKey ?? "");
        const uid = String(props.uid ?? "");
        if (!interiorKey) {
          throw new Error(`door at (${tileX},${tileY}) missing interiorKey property.`);
        }
        if (!uid) {
          throw new Error(
            `door at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        const entryTx = Number(props.entryTx ?? 0);
        const entryTy = Number(props.entryTy ?? 0);
        doors.push({
          kind: "door",
          uid,
          tileX,
          tileY,
          interiorKey,
          entryTx,
          entryTy,
        });
        break;
      }
      case "npcSpawnPoint": {
        const uid = String(props.uid ?? "");
        if (!uid) {
          throw new Error(
            `npcSpawnPoint at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        const spawnGroupId = String(props.spawnGroupId ?? "");
        if (!spawnGroupId) {
          throw new Error(
            `npcSpawnPoint at (${tileX},${tileY}) missing spawnGroupId property.`,
          );
        }
        npcSpawnPoints.push({ kind: "npc_spawn_point", uid, tileX, tileY, spawnGroupId });
        break;
      }
      case "npcResidence": {
        const uid = String(props.uid ?? "");
        if (!uid) {
          throw new Error(
            `npcResidence at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        const hireableId = String(props.hireableId ?? "");
        if (!hireableId) {
          throw new Error(
            `npcResidence at (${tileX},${tileY}) missing hireableId property.`,
          );
        }
        npcResidences.push({ kind: "npc_residence", uid, tileX, tileY, hireableId });
        break;
      }
      case "torch": {
        const uid = String(props.uid ?? "");
        if (!uid) {
          throw new Error(
            `torch at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        torches.push({
          kind: "torch",
          uid,
          tileX,
          tileY,
          radiusTiles: Number(props.radiusTiles ?? 2),
          color: parseHexColor(props.color, 0xfdc878),
          intensity: Number(props.intensity ?? 0.95),
          tintStrength: Number(props.tintStrength ?? 0.45),
        });
        break;
      }
      default:
        break;
    }
  }

  return { items, doors, torches, npcSpawnPoints, npcResidences };
}

function parseHexColor(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const hex = value.replace(/^#/, "").replace(/^0x/i, "");
    const n = parseInt(hex, 16);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

/** Parse the `objects` layer of a (chunk) tilemap into typed, global-tile spawns. */
export function parseSpawns(
  tilemap: Phaser.Tilemaps.Tilemap,
  opts: ParseSpawnsOptions = {},
): ParsedSpawns {
  const { offsetTx = 0, offsetTy = 0 } = opts;
  const layer = tilemap.getObjectLayer("objects");
  const objectLayerObjects = (layer?.objects ?? []) as TiledObjectLike[];
  // Torches live in their own object layer so map authors can toggle their
  // visibility independently in Tiled.
  const torchLayer = tilemap.getObjectLayer("torches");
  const torchObjects = (torchLayer?.objects ?? []) as TiledObjectLike[];
  return collectSpawns(
    [...objectLayerObjects, ...torchObjects],
    tilemap.tileWidth,
    tilemap.tileHeight,
    offsetTx,
    offsetTy,
  );
}

/** Parse the `objects` layer of an interior tilemap. Interior maps live in
 *  their own coordinate space (no global offset) and are loaded one at a time. */
export function parseInteriorSpawns(
  tilemap: Phaser.Tilemaps.Tilemap,
): InteriorParsedSpawns {
  const layer = tilemap.getObjectLayer("objects");
  const tw = tilemap.tileWidth;
  const th = tilemap.tileHeight;
  const exits: InteriorExitSpawn[] = [];
  const entries: InteriorEntrySpawn[] = [];
  const items: ItemSpawn[] = [];
  const repairTargets: RepairTargetSpawn[] = [];
  const workstations: WorkstationSpawn[] = [];
  const seats: SeatSpawn[] = [];
  const browseWaypoints: NpcBrowseWaypointSpawn[] = [];
  const standingSpots: NpcStandingSpotSpawn[] = [];
  if (!layer)
    return {
      exits,
      entries,
      items,
      repairTargets,
      workstations,
      seats,
      browseWaypoints,
      standingSpots,
    };

  for (const raw of layer.objects) {
    const props = propMap(raw.properties as TiledProperty[] | undefined);
    const tileX = Math.floor((raw.x ?? 0) / tw);
    const tileY = Math.floor((raw.y ?? 0) / th);
    if (raw.type === "interior_exit") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `interior_exit at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      exits.push({
        kind: "interior_exit",
        uid,
        tileX,
        tileY,
        promptOnly: Boolean(props.promptOnly ?? false),
      });
    } else if (raw.type === "interior_entry") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `interior_entry at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      const facingProp = props.facing;
      entries.push({
        kind: "interior_entry",
        uid,
        tileX,
        tileY,
        ...(typeof facingProp === "string" && facingProp.length > 0
          ? { facing: facingProp }
          : {}),
      });
    } else if (raw.type === "repair_target") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `repair_target at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      const businessId = String(props.businessId ?? "");
      const nodeId = String(props.nodeId ?? "");
      if (!businessId) {
        throw new Error(
          `repair_target at (${tileX},${tileY}) missing businessId property.`,
        );
      }
      if (!nodeId) {
        throw new Error(
          `repair_target at (${tileX},${tileY}) missing nodeId property.`,
        );
      }
      repairTargets.push({
        kind: "repair_target",
        uid,
        tileX,
        tileY,
        businessId,
        nodeId,
      });
    } else if (raw.type === "seat") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `seat at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      seats.push({ kind: "seat", uid, tileX, tileY });
    } else if (raw.type === "workstation") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `workstation at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      const tag = String(props.tag ?? "");
      if (!tag) {
        throw new Error(
          `workstation at (${tileX},${tileY}) missing tag property.`,
        );
      }
      workstations.push({
        kind: "workstation",
        uid,
        tileX,
        tileY,
        tag,
      });
    } else if (raw.type === "npcBrowseWaypoint") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `npcBrowseWaypoint at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      const browseGroupId = String(props.browseGroupId ?? "all") || "all";
      browseWaypoints.push({
        kind: "npc_browse_waypoint",
        uid,
        tileX,
        tileY,
        browseGroupId,
      });
    } else if (raw.type === "npcStandingSpot") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `npcStandingSpot at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      const standingGroupId = String(props.standingGroupId ?? "all") || "all";
      standingSpots.push({
        kind: "npc_standing_spot",
        uid,
        tileX,
        tileY,
        standingGroupId,
      });
    } else if (raw.type === "item_spawn") {
      const itemId = String(props.itemId ?? "") as ItemId;
      const quantity = Number(props.quantity ?? 1);
      const uid = String(props.uid ?? "");
      if (!itemId) throw new Error(`interior item_spawn at (${tileX},${tileY}) missing itemId`);
      if (!uid) {
        throw new Error(
          `interior item_spawn at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      items.push({ kind: "item_spawn", uid, tileX, tileY, itemId, quantity });
    }
  }

  return {
    exits,
    entries,
    items,
    repairTargets,
    workstations,
    seats,
    browseWaypoints,
    standingSpots,
  };
}

interface TiledProperty {
  name: string;
  type?: string;
  value: unknown;
}

function propMap(props: TiledProperty[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const p of props) out[p.name] = p.value;
  return out;
}
