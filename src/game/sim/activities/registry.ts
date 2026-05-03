import type { Activity } from "./activity";
import { deserializeNoop, NoopActivity } from "./noop";
import { deserializeWander } from "./wander";
import { deserializePatrol } from "./patrol";
import { deserializeGoTo } from "./goTo";
import { deserializePatronTavern } from "./patronTavern";
import { deserializeIdle } from "./idle";
import { deserializeBrowse } from "./browse";
import { deserializeStandAround } from "./standAround";
import { deserializeWorkAt } from "./workAt";
import { deserializeSleep } from "./sleep";

type Deserializer = (data: unknown) => Activity;

const DESERIALIZERS = new Map<string, Deserializer>();

export function registerActivityKind(kind: string, deserialize: Deserializer): void {
  DESERIALIZERS.set(kind, deserialize);
}

export function deserializeActivity(kind: string, data: unknown): Activity {
  const fn = DESERIALIZERS.get(kind);
  if (!fn) throw new Error(`Unknown activity kind '${kind}' — register it via registerActivityKind`);
  return fn(data);
}

// Built-ins.
registerActivityKind(new NoopActivity({ totalMinutes: 0, remainingMinutes: 0 }).kind, deserializeNoop);
registerActivityKind("wander", deserializeWander);
registerActivityKind("patrol", deserializePatrol);
registerActivityKind("goTo", deserializeGoTo);
registerActivityKind("patronTavern", deserializePatronTavern);
registerActivityKind("idle", deserializeIdle);
registerActivityKind("browse", deserializeBrowse);
registerActivityKind("standAround", deserializeStandAround);
registerActivityKind("workAt", deserializeWorkAt);
registerActivityKind("sleep", deserializeSleep);
