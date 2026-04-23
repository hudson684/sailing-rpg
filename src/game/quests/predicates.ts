import type {
  EventMatch,
  FlagKey,
  FlagValue,
  Predicate,
  QuestEventEnvelope,
} from "./types";

/** Read-only view the evaluator needs. Implemented by `QuestManager`
 *  (which reaches into the Zustand game store + FlagStore). Tests can
 *  supply a fake. Framework-free — no Phaser imports. */
export interface PredicateContext {
  flags: {
    get(key: FlagKey): FlagValue | undefined;
  };
  hasItem(itemId: string, min: number): boolean;
  jobLevel(jobId: string): number;
  activeMapId(): string;
  isQuestStatus(
    questId: string,
    status: "started" | "completed" | "notStarted" | "active",
  ): boolean;
  stepStatus(
    questId: string,
    stepId: string,
  ): "notEntered" | "entered" | "completed";
}

/** Evaluate a predicate. `event` is the current event envelope when
 *  evaluation is triggered by a bus event — it's required for the
 *  `event` kind to ever return true, and ignored by every other kind. */
export function evaluate(
  p: Predicate,
  ctx: PredicateContext,
  event?: QuestEventEnvelope,
): boolean {
  switch (p.kind) {
    case "event":
      if (!event) return false;
      if (event.name !== p.event) return false;
      return matchesEvent(p.match, event.payload);

    case "flag": {
      const have = ctx.flags.get(p.key);
      if (p.exists !== undefined) {
        const exists = have !== undefined;
        if (exists !== p.exists) return false;
      }
      if (p.equals !== undefined) return have === p.equals;
      // Bare {kind:"flag", key}: truthy check (undefined/false fails).
      if (p.exists === undefined) return Boolean(have);
      return true;
    }

    case "quest":
      return ctx.isQuestStatus(p.questId, p.status);

    case "step": {
      const s = ctx.stepStatus(p.questId, p.stepId);
      if (p.status === "entered") return s === "entered" || s === "completed";
      return s === "completed";
    }

    case "hasItem":
      return ctx.hasItem(p.itemId, p.min ?? 1);

    case "jobLevel":
      return ctx.jobLevel(p.jobId) >= p.min;

    case "sceneMap":
      return ctx.activeMapId() === p.mapId;

    case "and":
      return p.all.every((q) => evaluate(q, ctx, event));

    case "or":
      return p.any.some((q) => evaluate(q, ctx, event));

    case "not":
      return !evaluate(p.predicate, ctx, event);
  }
}

function matchesEvent(
  match: EventMatch | undefined,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  if (!match) return true;
  // Every specified field of `match` must agree with the payload.
  for (const [field, expected] of Object.entries(match)) {
    if (expected === undefined) continue;

    if (field === "minQuantity") {
      const q = numberAt(payload, "quantity") ?? numberAt(payload, "amount");
      if (q === null || q < (expected as number)) return false;
      continue;
    }

    if (field === "tile") {
      const t = expected as {
        map: string;
        x: number;
        y: number;
        radius?: number;
      };
      const pmap = stringAt(payload, "mapId");
      const px = numberAt(payload, "tileX");
      const py = numberAt(payload, "tileY");
      if (pmap !== t.map || px === null || py === null) return false;
      const r = t.radius ?? 0;
      const dx = px - t.x;
      const dy = py - t.y;
      if (r === 0) {
        if (dx !== 0 || dy !== 0) return false;
      } else if (dx * dx + dy * dy > r * r) {
        return false;
      }
      continue;
    }

    // Default: deep-equal match against same-named payload field.
    const actual = payload[field];
    if (actual !== expected) return false;
  }
  return true;
}

function numberAt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringAt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}
