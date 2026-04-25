// UID stamping for Tiled object-layer spawns.
//
// Each spawn object (types listed in SPAWN_LAYER_TYPES) must carry a `uid`
// custom string property. UIDs are the canonical runtime identity — Tiled's
// numeric `id` is per-file, reassigned on delete+recreate, and collides across
// chunks, so it can't be used for save-state keys.
//
// - `npm run maps` auto-stamps missing uids into source TMX, commits happen via
//   git as normal.
// - `npm run maps:check` runs the same scan but fails if any would be stamped
//   or duplicated (for CI).
// - Duplicate uids across the whole set of chunks fail loud always.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export const SPAWN_LAYER_TYPES = ["item_spawn", "door", "interior_exit", "interior_entry"];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

/**
 * Scan a single TMX file; inject `uid` properties for any matching objects
 * missing one. Returns a report.
 *
 * @param {string} tmxPath absolute path to a .tmx file
 * @param {{ check?: boolean }} opts
 */
export function stampUidsInFile(tmxPath, opts = {}) {
  const { check = false } = opts;
  const original = readFileSync(tmxPath, "utf8");
  const tree = parser.parse(original);

  const objects = collectSpawnObjects(tree);
  const existing = new Map(); // uid → object id (for dupe detection within file)
  const missing = [];

  for (const obj of objects) {
    const uid = obj.uid;
    if (uid) {
      if (existing.has(uid)) {
        throw new Error(
          `${path.basename(tmxPath)}: duplicate uid '${uid}' on objects ${existing.get(uid)} and ${obj.id} (copy-paste mistake?)`,
        );
      }
      existing.set(uid, obj.id);
    } else {
      missing.push(obj);
    }
  }

  if (missing.length === 0) {
    return { file: tmxPath, stamped: 0, existingUids: [...existing.keys()] };
  }

  if (check) {
    const list = missing.map((m) => `id=${m.id} type=${m.type}`).join(", ");
    throw new Error(
      `${path.basename(tmxPath)}: ${missing.length} spawn object(s) missing uid — run \`npm run maps\` to stamp. (${list})`,
    );
  }

  let content = original;
  const newlyStamped = [];
  for (const obj of missing) {
    const uid = randomUUID();
    content = injectUidProperty(content, obj.id, uid);
    newlyStamped.push(uid);
  }

  writeFileSync(tmxPath, content);
  return {
    file: tmxPath,
    stamped: newlyStamped.length,
    existingUids: [...existing.keys(), ...newlyStamped],
  };
}

/**
 * Stamp every TMX under a directory and cross-check for duplicate uids across
 * the whole set.
 */
export function stampUidsInDir(tmxDir, opts = {}) {
  let files = [];
  try {
    files = readdirSync(tmxDir)
      .filter((f) => f.endsWith(".tmx"))
      .map((f) => path.join(tmxDir, f))
      .sort();
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const reports = files.map((f) => stampUidsInFile(f, opts));

  const globalUids = new Map(); // uid → first file
  for (const r of reports) {
    for (const uid of r.existingUids) {
      if (globalUids.has(uid)) {
        throw new Error(
          `Duplicate uid '${uid}' across chunks: ${path.basename(globalUids.get(uid))} and ${path.basename(r.file)}`,
        );
      }
      globalUids.set(uid, r.file);
    }
  }
  return reports;
}

// ─── internals ────────────────────────────────────────────────────────────

/**
 * Walk the parsed (preserveOrder) tree, collecting objects on any objectgroup
 * whose type is in SPAWN_LAYER_TYPES. Returns { id, type, uid, hasProperties }.
 */
function collectSpawnObjects(tree) {
  const out = [];
  walk(tree);
  return out;

  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.objectgroup !== undefined) {
        for (const child of node.objectgroup) {
          if (child.object === undefined) continue;
          const attrs = child[":@"] ?? {};
          const type = attrs["@_type"] ?? "";
          if (!SPAWN_LAYER_TYPES.includes(type)) continue;
          const id = attrs["@_id"];
          let uid = null;
          let hasProps = false;
          const props = (child.object ?? []).find((c) => c.properties !== undefined);
          if (props) {
            hasProps = true;
            for (const p of props.properties) {
              if (p.property === undefined) continue;
              const pa = p[":@"] ?? {};
              if (pa["@_name"] === "uid") uid = String(pa["@_value"] ?? "");
            }
          }
          out.push({ id: String(id), type, uid, hasProperties: hasProps });
        }
      }
      // Descend into every named child array that looks like a sub-tree.
      for (const k of Object.keys(node)) {
        if (k === ":@") continue;
        if (Array.isArray(node[k])) walk(node[k]);
      }
    }
  }
}

/**
 * Inject `<property name="uid" value="${uid}"/>` into the given object's
 * `<properties>` block, inserting the block if absent. Preserves surrounding
 * XML verbatim (targeted edit only).
 */
function injectUidProperty(content, objectId, uid) {
  // Match the opening tag. Either self-closing or with body.
  const openRe = new RegExp(`(<object\\b[^>]*\\bid="${escapeRegex(String(objectId))}"[^>]*?)(/>|>)`, "m");
  const match = openRe.exec(content);
  if (!match) throw new Error(`Could not locate <object id="${objectId}"> in TMX`);
  const openEnd = match.index + match[0].length;
  const closer = match[2];
  const beforeOpen = content.slice(0, match.index);
  const openTag = match[1];

  if (closer === "/>") {
    // Self-closing — expand into a full block with inline <properties>.
    const replacement = `${openTag}>\n   <properties>\n    <property name="uid" value="${uid}"/>\n   </properties>\n  </object>`;
    return beforeOpen + replacement + content.slice(openEnd);
  }

  // With body — find matching </object>.
  const after = content.slice(openEnd);
  const closeIdx = after.indexOf("</object>");
  if (closeIdx < 0) throw new Error(`No </object> after id="${objectId}"`);
  const body = after.slice(0, closeIdx);

  // If <properties>...</properties> exists, insert before </properties>.
  const propsEndIdx = body.indexOf("</properties>");
  if (propsEndIdx >= 0) {
    // Preserve the indentation of the existing closing tag.
    const lineStart = body.lastIndexOf("\n", propsEndIdx) + 1;
    const indent = body.slice(lineStart, propsEndIdx);
    const propLine = `${indent} <property name="uid" value="${uid}"/>\n${indent}`;
    const newBody = body.slice(0, propsEndIdx) + propLine + body.slice(propsEndIdx);
    return beforeOpen + openTag + ">" + newBody + after.slice(closeIdx);
  }

  // No <properties> block — insert one at the top of the body.
  const propsBlock = `\n   <properties>\n    <property name="uid" value="${uid}"/>\n   </properties>`;
  const newBody = propsBlock + body;
  return beforeOpen + openTag + ">" + newBody + after.slice(closeIdx);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
