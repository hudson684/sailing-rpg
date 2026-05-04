import type {
  ChatDef,
  ChatIndex,
  IndexEntry,
  ParticipantMatch,
} from "./chatTypes";

// Eager Vite glob — every JSON in `data/chats/` is bundled at build time.
// Each file's default export is the parsed JSON; we validate shape on
// load and throw author errors with the offending path.
const modules = import.meta.glob<{ default: unknown }>(
  "../data/chats/*.json",
  { eager: true },
);

function fail(path: string, msg: string): never {
  throw new Error(`[chatIndex] ${path}: ${msg}`);
}

function isParticipantMatch(v: unknown): v is ParticipantMatch {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.npcId === "string") return true;
  if (typeof o.archetype === "string") return true;
  return false;
}

function validate(path: string, raw: unknown): ChatDef {
  if (!raw || typeof raw !== "object") fail(path, "root is not an object");
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string" || o.id.length === 0)
    fail(path, "missing/empty `id`");

  if (!o.participants || typeof o.participants !== "object")
    fail(path, "missing `participants`");
  const slots = Object.keys(o.participants as object);
  if (slots.length !== 2)
    fail(path, `participants must have exactly 2 slots, got ${slots.length}`);
  for (const slot of slots) {
    const p = (o.participants as Record<string, unknown>)[slot];
    if (!p || typeof p !== "object") fail(path, `participants.${slot} not an object`);
    const ps = p as Record<string, unknown>;
    if (!isParticipantMatch(ps.match))
      fail(path, `participants.${slot}.match must be { npcId } or { archetype }`);
    if (ps.requires !== undefined && (typeof ps.requires !== "object" || ps.requires === null))
      fail(path, `participants.${slot}.requires must be an object if present`);
  }

  if (o.where !== undefined) {
    const w = o.where as Record<string, unknown> | null;
    if (!w || typeof w !== "object" || typeof w.scene !== "string")
      fail(path, "`where` must be { scene: string } if present");
  }

  if (typeof o.proximityTiles !== "number" || o.proximityTiles < 1)
    fail(path, "`proximityTiles` must be >= 1");
  if (typeof o.cooldownDays !== "number" || o.cooldownDays < 0)
    fail(path, "`cooldownDays` must be >= 0");
  if (o.weight !== undefined && (typeof o.weight !== "number" || o.weight <= 0))
    fail(path, "`weight` must be a positive number if present");

  if (!Array.isArray(o.lines) || o.lines.length === 0)
    fail(path, "`lines` must be a non-empty array");
  for (let i = 0; i < o.lines.length; i++) {
    const l = o.lines[i] as Record<string, unknown> | null;
    if (!l || typeof l !== "object")
      fail(path, `lines[${i}] not an object`);
    if (typeof l.by !== "string" || !slots.includes(l.by))
      fail(path, `lines[${i}].by '${l.by}' is not a participant slot`);
    if (typeof l.text !== "string" || l.text.length === 0)
      fail(path, `lines[${i}].text must be non-empty string`);
  }

  return raw as ChatDef;
}

function build(): ChatIndex {
  const byNpcId = new Map<string, IndexEntry[]>();
  const byArchetype = new Map<string, IndexEntry[]>();
  const byScene = new Map<string | null, ChatDef[]>();
  const all: ChatDef[] = [];
  const seenIds = new Set<string>();

  for (const [path, mod] of Object.entries(modules)) {
    const def = validate(path, mod.default);
    if (seenIds.has(def.id))
      fail(path, `duplicate chat id '${def.id}'`);
    seenIds.add(def.id);
    all.push(def);

    const sceneKey = def.where?.scene ?? null;
    let bucket = byScene.get(sceneKey);
    if (!bucket) {
      bucket = [];
      byScene.set(sceneKey, bucket);
    }
    bucket.push(def);

    for (const [slot, spec] of Object.entries(def.participants)) {
      const entry: IndexEntry = { def, matchedSlot: slot };
      if ("npcId" in spec.match) {
        const k = spec.match.npcId;
        let list = byNpcId.get(k);
        if (!list) { list = []; byNpcId.set(k, list); }
        list.push(entry);
      } else {
        const k = spec.match.archetype;
        let list = byArchetype.get(k);
        if (!list) { list = []; byArchetype.set(k, list); }
        list.push(entry);
      }
    }
  }

  return { byNpcId, byArchetype, byScene, all };
}

export const chatIndex: ChatIndex = build();

/** Return all `IndexEntry`s where `(npcId, archetype)` matches one slot
 *  of a chat that's also allowed in `sceneKey`. The director (phase 4)
 *  iterates pairs and uses this to narrow candidates by the first NPC
 *  in the pair, then verifies the partner against the other slot. */
export function candidatesFor(
  npcId: string,
  archetype: string,
  sceneKey: string,
): IndexEntry[] {
  const byId = chatIndex.byNpcId.get(npcId);
  const byArch = chatIndex.byArchetype.get(archetype);
  if (!byId && !byArch) return [];

  const out: IndexEntry[] = [];
  const push = (e: IndexEntry) => {
    if (!e.def.where || e.def.where.scene === sceneKey) out.push(e);
  };
  if (byId) for (const e of byId) push(e);
  if (byArch) for (const e of byArch) push(e);
  return out;
}
