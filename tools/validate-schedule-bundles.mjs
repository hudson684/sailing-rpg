// Validate every `src/game/sim/data/schedules/*.json` bundle:
//  - has a `default` variant
//  - every alias resolves to a real key without cycling (depth ≤ 4)
//  - keys conform to the recognized shapes (day name, season, weather,
//    `<season>_<dayOfMonth>`, `<weather>_<dayOfWeek>`, `<season>_<dayOfWeek>`,
//    `flag_<name>`, `friendship_<npc>_<n>`, `festival_<id>`)
//  - no unknown weather strings beyond the allow-list
//  - every variant body has either `templates` or `alias` (not both, not neither)
//  - templates with `mustStartAt` do NOT also have `windowMinute` (Phase 3 mutual exclusivity)
//  - `when` predicates use only known predicate kinds (Phase 2)
//
// Standalone CLI: `node tools/validate-schedule-bundles.mjs`. Also exported
// (`validateScheduleBundles`) for use from `tools/build-maps.mjs`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const schedulesDir = path.join(repoRoot, "src", "game", "sim", "data", "schedules");
const calendarPath = path.join(repoRoot, "src", "game", "sim", "calendar", "calendar.json");

// Keep this allow-list small. Expanding it is a deliberate authoring decision.
const KNOWN_WEATHER = new Set(["clear", "rain", "storm", "snow", "fog"]);
const ALIAS_MAX_DEPTH = 4;

const KNOWN_PREDICATE_KEYS = new Set([
  "flag",
  "notFlag",
  "agentFlag",
  "friendship",
  "season",
  "dayOfWeek",
  "weather",
  "all",
  "any",
  "not",
]);

function loadCalendarShape() {
  if (!existsSync(calendarPath)) {
    return { dayNames: new Set(), seasons: new Set() };
  }
  const cal = JSON.parse(readFileSync(calendarPath, "utf8"));
  const dayNames = new Set((cal.week?.days ?? []));
  const seasons = new Set((cal.months ?? []).map((m) => m.season));
  return { dayNames, seasons };
}

function listScheduleFiles() {
  if (!existsSync(schedulesDir)) return [];
  return readdirSync(schedulesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(schedulesDir, f));
}

function classifyKey(key, dayNames, seasons) {
  if (key === "default") return "default";
  if (KNOWN_WEATHER.has(key)) return "weather";
  if (dayNames.has(key)) return "dayOfWeek";
  if (seasons.has(key)) return "season";
  if (key.startsWith("flag_")) return "flag";
  if (key.startsWith("festival_")) return "festival";
  if (key.startsWith("friendship_")) return "friendship";
  // Compound forms: <weather>_<dayOfWeek>, <season>_<dayOfWeek>, <season>_<dayOfMonth>.
  const parts = key.split("_");
  if (parts.length === 2) {
    const [a, b] = parts;
    if (KNOWN_WEATHER.has(a) && dayNames.has(b)) return "weather_dayOfWeek";
    if (seasons.has(a) && dayNames.has(b)) return "season_dayOfWeek";
    if (seasons.has(a) && /^\d+$/.test(b)) return "season_dayOfMonth";
  }
  return null;
}

function validatePredicate(node, errors, ctx) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${ctx}: predicate must be an object`);
    return;
  }
  const keys = Object.keys(node);
  for (const k of keys) {
    if (!KNOWN_PREDICATE_KEYS.has(k)) {
      errors.push(`${ctx}: unknown predicate key '${k}' (known: ${[...KNOWN_PREDICATE_KEYS].join(", ")})`);
    }
  }
  if ("all" in node) {
    if (!Array.isArray(node.all)) errors.push(`${ctx}.all: must be an array`);
    else node.all.forEach((c, i) => validatePredicate(c, errors, `${ctx}.all[${i}]`));
  }
  if ("any" in node) {
    if (!Array.isArray(node.any)) errors.push(`${ctx}.any: must be an array`);
    else node.any.forEach((c, i) => validatePredicate(c, errors, `${ctx}.any[${i}]`));
  }
  if ("not" in node) validatePredicate(node.not, errors, `${ctx}.not`);
  if ("friendship" in node) {
    const f = node.friendship;
    if (!f || typeof f !== "object" || typeof f.npc !== "string" || typeof f.gte !== "number") {
      errors.push(`${ctx}.friendship: must be { npc: string, gte: number }`);
    }
  }
}

function validateTemplate(t, errors, ctx) {
  if (typeof t.id !== "string" || !t.id) errors.push(`${ctx}: template missing id`);
  if (typeof t.kind !== "string") errors.push(`${ctx}: template '${t.id}' missing kind`);
  if (!t.target || typeof t.target !== "object") errors.push(`${ctx}: template '${t.id}' missing target`);
  // Phase 3: mustStartAt and windowMinute are mutually exclusive.
  if (t.mustStartAt != null && t.windowMinute != null) {
    errors.push(`${ctx}: template '${t.id}' may not declare both 'mustStartAt' and 'windowMinute' (Phase 3 mutual exclusivity)`);
  }
  if (t.mustStartAt != null) {
    if (typeof t.mustStartAt !== "number" || t.mustStartAt < 0 || t.mustStartAt >= 1440) {
      errors.push(`${ctx}: template '${t.id}' mustStartAt must be a sim-minute in [0, 1440)`);
    }
  }
}

function validateBundle(filePath, raw, calendarShape, errors) {
  const ctx = path.relative(repoRoot, filePath);
  if (!raw || typeof raw !== "object") {
    errors.push(`${ctx}: bundle must be an object`);
    return;
  }
  if (typeof raw.id !== "string" || !raw.id) {
    errors.push(`${ctx}: missing or invalid 'id'`);
  }
  if (!raw.variants || typeof raw.variants !== "object") {
    errors.push(`${ctx}: missing 'variants' object`);
    return;
  }
  if (!("default" in raw.variants)) {
    errors.push(`${ctx}: 'variants' must include a 'default' key`);
  }
  for (const [key, body] of Object.entries(raw.variants)) {
    const kind = classifyKey(key, calendarShape.dayNames, calendarShape.seasons);
    if (!kind) {
      errors.push(`${ctx}: variant key '${key}' is not a recognized shape (default | <dayOfWeek> | <season> | <weather> | <season>_<dayOfWeek> | <season>_<dayOfMonth> | <weather>_<dayOfWeek> | flag_<name> | festival_<id> | friendship_<npc>_<n>)`);
    }
    if (!body || typeof body !== "object") {
      errors.push(`${ctx}: variant '${key}' must be an object`);
      continue;
    }
    const hasAlias = typeof body.alias === "string";
    const hasTemplates = Array.isArray(body.templates);
    if (hasAlias && hasTemplates) {
      errors.push(`${ctx}: variant '${key}' may not have both 'alias' and 'templates'`);
    }
    if (!hasAlias && !hasTemplates) {
      errors.push(`${ctx}: variant '${key}' must have either 'alias' or 'templates'`);
    }
    if (hasTemplates) {
      body.templates.forEach((t, i) => validateTemplate(t, errors, `${ctx} variant '${key}' templates[${i}]`));
    }
    if (body.when != null) validatePredicate(body.when, errors, `${ctx} variant '${key}' when`);
  }
  // Resolve aliases — detect cycles and missing targets.
  for (const [startKey, body] of Object.entries(raw.variants)) {
    if (typeof body?.alias !== "string") continue;
    let key = startKey;
    let cur = body;
    let depth = 0;
    const seen = new Set([key]);
    while (cur && typeof cur.alias === "string") {
      if (depth >= ALIAS_MAX_DEPTH) {
        errors.push(`${ctx}: alias chain at '${startKey}' exceeds depth ${ALIAS_MAX_DEPTH}`);
        break;
      }
      const target = cur.alias;
      if (seen.has(target)) {
        errors.push(`${ctx}: alias cycle at '${startKey}' → '${target}'`);
        break;
      }
      const next = raw.variants[target];
      if (!next) {
        errors.push(`${ctx}: alias on '${key}' targets unknown key '${target}'`);
        break;
      }
      seen.add(target);
      key = target;
      cur = next;
      depth += 1;
    }
  }
}

export function validateScheduleBundles() {
  const errors = [];
  const calendarShape = loadCalendarShape();
  for (const f of listScheduleFiles()) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      errors.push(`${path.relative(repoRoot, f)}: invalid JSON — ${e.message}`);
      continue;
    }
    validateBundle(f, raw, calendarShape, errors);
  }
  return errors;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-schedule-bundles.mjs")
) {
  const errors = validateScheduleBundles();
  if (errors.length === 0) {
    console.log("validate-schedule-bundles: ok");
    process.exit(0);
  }
  console.error(`validate-schedule-bundles failed:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
