import type { MapKind } from "./mapLoader";
import {
  loadDecorationFrame,
  loadEnemyFrame,
  loadNodeFrame,
  loadNpcFrame,
  type SpriteFrame,
} from "./spriteLoader";

export type EntityKind =
  | "npc"
  | "enemy"
  | "node"
  | "decoration"
  | "station"
  | "ship"
  | "item"
  | "spawn";

/** A placed entity instance in the editor's working copy. The
 *  `underlying` field holds the original JSON object unchanged so
 *  round-tripping preserves any fields the editor doesn't inspect. */
export interface EditorEntity {
  kind: EntityKind;
  id: string;
  tileX: number;
  tileY: number;
  /** For NPCs: the interior id if the entity lives inside one. */
  interior?: string;
  /** defId for enemies/nodes/stations/ships; itemId for items; own id for NPCs. */
  defId: string;
  /** Display label. */
  label: string;
  /** Fallback marker color when a sprite isn't available. */
  color: string;
  /** The original JSON row. */
  underlying: Record<string, unknown>;
}

export interface DefSummary {
  id: string;
  label: string;
}

export interface ParsedEntityFile {
  entities: EditorEntity[];
  defs: DefSummary[];
  /** The full raw def row keyed by defId — used for sprite rendering.
   *  For kinds where the def *is* the instance (NPCs), the underlying
   *  row is mirrored here. */
  rawDefs: Record<string, unknown>;
}

export interface EntityTypeInfo {
  kind: EntityKind;
  label: string;
  jsonPath: string;
  parseFile(raw: unknown): ParsedEntityFile;
  /** Serialize the entities back into the original file shape. The
   *  `originalFile` is the last-loaded raw JSON — used to preserve
   *  the `defs` array verbatim. */
  toFile(originalFile: unknown, entities: EditorEntity[]): unknown;
  /** Is this entity visible on the given map? */
  isOnMap(e: EditorEntity, mapId: string, mapKind: MapKind): boolean;
  /** Build a new entity for "place" tool. */
  makeNew(defId: string, tileX: number, tileY: number, existingIds: Set<string>): EditorEntity;
  /** Async sprite frame loader; null when the def can't be sprite-rendered. */
  loadSprite(def: unknown): Promise<SpriteFrame | null>;
  /** Marker fallback color (used when no sprite). */
  defaultColor: string;
}

// Helpers -----------------------------------------------------------

function nextId(prefix: string, existing: Set<string>): string {
  let i = 1;
  while (existing.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// NPCs --------------------------------------------------------------

const npcInfo: EntityTypeInfo = {
  kind: "npc",
  label: "NPC",
  jsonPath: "src/game/data/npcs.json",
  parseFile(raw) {
    const file = raw as { npcs?: Array<Record<string, unknown>> };
    const entities: EditorEntity[] = [];
    const defs: DefSummary[] = [];
    const rawDefs: Record<string, unknown> = {};
    for (const n of file.npcs ?? []) {
      const id = str(n.id);
      const spawn = (n.spawn ?? {}) as { tileX?: number; tileY?: number };
      const mapRef = (n.map ?? {}) as { interior?: string };
      entities.push({
        kind: "npc",
        id,
        tileX: num(spawn.tileX),
        tileY: num(spawn.tileY),
        interior: mapRef.interior,
        defId: id,
        label: str(n.name, id),
        color: "#44aaff",
        underlying: n,
      });
      defs.push({ id, label: str(n.name, id) });
      rawDefs[id] = n;
    }
    return { entities, defs, rawDefs };
  },
  toFile(_originalFile, entities) {
    return {
      npcs: entities.map((e) => {
        const next = { ...e.underlying };
        next.id = e.id;
        next.spawn = { tileX: e.tileX, tileY: e.tileY };
        if (e.interior) {
          next.map = { ...((next.map as object) ?? {}), interior: e.interior };
        } else {
          delete (next as Record<string, unknown>).map;
        }
        return next;
      }),
    };
  },
  isOnMap(e, mapId, mapKind) {
    if (mapKind === "interior") return e.interior === mapId;
    // NPCs without `map.interior` live on the world overworld.
    return mapKind === "world" && !e.interior;
  },
  makeNew(defId, tileX, tileY, existingIds) {
    const id = existingIds.has(defId) ? nextId(`${defId}_`, existingIds) : defId;
    return {
      kind: "npc",
      id,
      tileX,
      tileY,
      defId,
      label: defId,
      color: "#44aaff",
      underlying: { id, name: defId, spawn: { tileX, tileY } },
    };
  },
  loadSprite: loadNpcFrame,
  defaultColor: "#44aaff",
};

// Shared "defs + instances" file shape (enemies/nodes/stations/ships) -

interface DefsFile<I> {
  defs: Array<Record<string, unknown>>;
  instances: I[];
}

function parseDefsInstances(
  raw: unknown,
  kind: EntityKind,
  color: string,
): ParsedEntityFile {
  const file = raw as DefsFile<Record<string, unknown>>;
  const defList = file.defs ?? [];
  const entities: EditorEntity[] = [];
  const defs: DefSummary[] = defList.map((d) => ({
    id: str(d.id),
    label: str(d.name, str(d.id)),
  }));
  const rawDefs: Record<string, unknown> = {};
  for (const d of defList) rawDefs[str(d.id)] = d;
  for (const inst of file.instances ?? []) {
    const id = str(inst.id);
    const defId = str(inst.defId);
    const defRow = defList.find((d) => d.id === defId);
    entities.push({
      kind,
      id,
      tileX: num(inst.tileX),
      tileY: num(inst.tileY),
      defId,
      label: str(defRow?.name, defId),
      color,
      underlying: inst,
    });
  }
  return { entities, defs, rawDefs };
}

function toDefsInstancesFile(
  originalFile: unknown,
  entities: EditorEntity[],
  extraPassthrough: (e: EditorEntity) => Record<string, unknown> = () => ({}),
): unknown {
  const orig = (originalFile ?? {}) as Record<string, unknown>;
  return {
    ...orig,
    instances: entities.map((e) => {
      const next = { ...e.underlying };
      next.id = e.id;
      next.defId = e.defId;
      next.tileX = e.tileX;
      next.tileY = e.tileY;
      Object.assign(next, extraPassthrough(e));
      return next;
    }),
  };
}

// Enemies -----------------------------------------------------------

const enemyInfo: EntityTypeInfo = {
  kind: "enemy",
  label: "Enemy",
  jsonPath: "src/game/data/enemies.json",
  parseFile: (raw) => parseDefsInstances(raw, "enemy", "#d04848"),
  toFile: (orig, entities) => toDefsInstancesFile(orig, entities),
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`e_${defId}_`, existingIds);
    return {
      kind: "enemy",
      id,
      tileX,
      tileY,
      defId,
      label: defId,
      color: "#d04848",
      underlying: { id, defId, tileX, tileY },
    };
  },
  loadSprite: loadEnemyFrame,
  defaultColor: "#d04848",
};

// Nodes -------------------------------------------------------------

const nodeInfo: EntityTypeInfo = {
  kind: "node",
  label: "Node",
  jsonPath: "src/game/data/nodes.json",
  parseFile: (raw) => parseDefsInstances(raw, "node", "#3a6b2a"),
  toFile: (orig, entities) => toDefsInstancesFile(orig, entities),
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`n_${defId}_`, existingIds);
    return {
      kind: "node",
      id,
      tileX,
      tileY,
      defId,
      label: defId,
      color: "#3a6b2a",
      underlying: { id, defId, tileX, tileY },
    };
  },
  loadSprite: loadNodeFrame,
  defaultColor: "#3a6b2a",
};

// Decorations -------------------------------------------------------

const decorationInfo: EntityTypeInfo = {
  kind: "decoration",
  label: "Decoration",
  jsonPath: "src/game/data/decorations.json",
  parseFile: (raw) => parseDefsInstances(raw, "decoration", "#7ab0ff"),
  toFile: (orig, entities) => toDefsInstancesFile(orig, entities),
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`d_${defId}_`, existingIds);
    return {
      kind: "decoration",
      id,
      tileX,
      tileY,
      defId,
      label: defId,
      color: "#7ab0ff",
      underlying: { id, defId, tileX, tileY },
    };
  },
  loadSprite: loadDecorationFrame,
  defaultColor: "#7ab0ff",
};

// Stations ----------------------------------------------------------

const stationInfo: EntityTypeInfo = {
  kind: "station",
  label: "Station",
  jsonPath: "src/game/data/craftingStations.json",
  parseFile: (raw) => parseDefsInstances(raw, "station", "#e0823a"),
  toFile: (orig, entities) => toDefsInstancesFile(orig, entities),
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`s_${defId}_`, existingIds);
    return {
      kind: "station",
      id,
      tileX,
      tileY,
      defId,
      label: defId,
      color: "#e0823a",
      underlying: { id, defId, tileX, tileY },
    };
  },
  // No convenient single sprite — stations render as tile-area rectangles in-game.
  loadSprite: async () => null,
  defaultColor: "#e0823a",
};

// Ships -------------------------------------------------------------

const shipInfo: EntityTypeInfo = {
  kind: "ship",
  label: "Ship",
  jsonPath: "src/game/data/ships.json",
  parseFile(raw) {
    const parsed = parseDefsInstances(raw, "ship", "#a27040");
    for (const e of parsed.entities) {
      const h = str((e.underlying.heading as unknown) ?? "");
      if (h) e.label = `${e.defId} (${h})`;
    }
    return parsed;
  },
  toFile: (orig, entities) =>
    toDefsInstancesFile(orig, entities, (e) => {
      const h = e.underlying.heading;
      return h !== undefined ? { heading: h } : {};
    }),
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`sh_${defId}_`, existingIds);
    return {
      kind: "ship",
      id,
      tileX,
      tileY,
      defId,
      label: `${defId} (N)`,
      color: "#a27040",
      underlying: { id, defId, tileX, tileY, heading: "N" },
    };
  },
  loadSprite: async () => null,
  defaultColor: "#a27040",
};

// Items -------------------------------------------------------------

const itemInfo: EntityTypeInfo = {
  kind: "item",
  label: "Item",
  jsonPath: "src/game/data/itemInstances.json",
  parseFile(raw) {
    const file = raw as { instances?: Array<Record<string, unknown>> };
    const entities: EditorEntity[] = (file.instances ?? []).map((inst) => ({
      kind: "item" as const,
      id: str(inst.id),
      tileX: num(inst.tileX),
      tileY: num(inst.tileY),
      defId: str(inst.itemId),
      label: `${str(inst.itemId)} x${num(inst.quantity, 1)}`,
      color: "#d0c040",
      underlying: inst,
    }));
    // defs populated separately from items.json — caller merges those in.
    return { entities, defs: [], rawDefs: {} };
  },
  toFile(_orig, entities) {
    return {
      instances: entities.map((e) => {
        const next = { ...e.underlying };
        next.id = e.id;
        next.itemId = e.defId;
        next.tileX = e.tileX;
        next.tileY = e.tileY;
        if (next.quantity === undefined) next.quantity = 1;
        return next;
      }),
    };
  },
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  makeNew(defId, tileX, tileY, existingIds) {
    const id = nextId(`i_`, existingIds);
    return {
      kind: "item",
      id,
      tileX,
      tileY,
      defId,
      label: `${defId} x1`,
      color: "#d0c040",
      underlying: { id, itemId: defId, quantity: 1, tileX, tileY },
    };
  },
  loadSprite: async () => null,
  defaultColor: "#d0c040",
};

// Player spawn -----------------------------------------------------

const SPAWN_ID = "player_spawn";

const spawnInfo: EntityTypeInfo = {
  kind: "spawn",
  label: "Player Spawn",
  jsonPath: "src/game/data/playerSpawn.json",
  parseFile(raw) {
    const file = (raw ?? {}) as { instance?: { tileX?: number; tileY?: number } };
    const inst = file.instance ?? {};
    const entity: EditorEntity = {
      kind: "spawn",
      id: SPAWN_ID,
      tileX: num(inst.tileX),
      tileY: num(inst.tileY),
      defId: SPAWN_ID,
      label: "Player Spawn",
      color: "#ffcc00",
      underlying: { tileX: num(inst.tileX), tileY: num(inst.tileY) },
    };
    return { entities: [entity], defs: [], rawDefs: {} };
  },
  toFile(_orig, entities) {
    const e = entities[0];
    return { instance: { tileX: e?.tileX ?? 0, tileY: e?.tileY ?? 0 } };
  },
  isOnMap: (_e, _mapId, mapKind) => mapKind === "world",
  // Singleton — never created via "place" tool. Returns a noop entity if called.
  makeNew(_defId, tileX, tileY) {
    return {
      kind: "spawn",
      id: SPAWN_ID,
      tileX,
      tileY,
      defId: SPAWN_ID,
      label: "Player Spawn",
      color: "#ffcc00",
      underlying: { tileX, tileY },
    };
  },
  loadSprite: async () => null,
  defaultColor: "#ffcc00",
};

// Registry ----------------------------------------------------------

export const ENTITY_TYPES: EntityTypeInfo[] = [
  npcInfo,
  enemyInfo,
  nodeInfo,
  decorationInfo,
  stationInfo,
  shipInfo,
  itemInfo,
  spawnInfo,
];

export function findType(kind: EntityKind): EntityTypeInfo {
  const info = ENTITY_TYPES.find((t) => t.kind === kind);
  if (!info) throw new Error(`Unknown entity kind: ${kind}`);
  return info;
}
