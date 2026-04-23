import { useMemo } from "react";
import type { PredicateSuggestions } from "./PredicateBuilder";
import { useJsonFile } from "../useJsonFile";

/**
 * Aggregates autocomplete suggestions for the predicate / reward
 * builders from the loaded data registries. Each suggestion source is
 * a small JSON file; we only fetch what we need.
 */
export function useSuggestions(): PredicateSuggestions {
  const items = useJsonFile<{ items?: Array<{ id: string }> }>("src/game/data/items.json");
  const npcs = useJsonFile<{ npcs?: Array<{ id: string }> }>("src/game/data/npcs.json");
  const enemies = useJsonFile<{ defs?: Array<{ id: string }> }>("src/game/data/enemies.json");
  const nodes = useJsonFile<{ defs?: Array<{ id: string }> }>("src/game/data/nodes.json");
  const dialogues = useJsonFile<{ trees?: Array<{ id: string }> }>("src/game/data/dialogue.json");
  const cutscenes = useJsonFile<{ cutscenes?: Array<{ id: string }> }>("src/game/data/cutscenes.json");
  const quests = useJsonFile<{ quests?: Array<{ id: string }> }>("src/game/data/quests.json");

  return useMemo<PredicateSuggestions>(() => {
    const flags = new Set<string>();
    // Harvest flag keys referenced anywhere in the loaded data.
    collectFlags(items.data, flags);
    collectFlags(npcs.data, flags);
    collectFlags(enemies.data, flags);
    collectFlags(nodes.data, flags);
    collectFlags(dialogues.data, flags);
    collectFlags(cutscenes.data, flags);
    collectFlags(quests.data, flags);
    return {
      items: (items.data?.items ?? []).map((i) => i.id),
      jobs: ["lumberjack", "miner", "fishing", "blacksmith", "chef", "farmer"],
      maps: ["world", "cabin", "starter_dungeon"],
      npcs: (npcs.data?.npcs ?? []).map((n) => n.id),
      enemies: (enemies.data?.defs ?? []).map((e) => e.id),
      nodes: (nodes.data?.defs ?? []).map((n) => n.id),
      dialogues: (dialogues.data?.trees ?? []).map((d) => d.id),
      cutscenes: (cutscenes.data?.cutscenes ?? []).map((c) => c.id),
      quests: (quests.data?.quests ?? []).map((q) => q.id),
      flags: [...flags].sort(),
    };
  }, [items.data, npcs.data, enemies.data, nodes.data, dialogues.data, cutscenes.data, quests.data]);
}

function collectFlags(obj: unknown, out: Set<string>) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const v of obj) collectFlags(v, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "key" && typeof v === "string") out.add(v);
    if (k === "flagKey" && typeof v === "string") out.add(v);
    if (k === "flag" && typeof v === "string") out.add(v);
    else collectFlags(v, out);
  }
}
