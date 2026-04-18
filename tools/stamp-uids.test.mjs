import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stampUidsInFile, stampUidsInDir } from "./stamp-uids.mjs";

// Minimal TMX shape that the parser will recognize. Only the objectgroup +
// object bits matter; the surrounding map/tileset elements aren't touched.
function tmx(objectsXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.11.2" orientation="orthogonal" renderorder="right-down" width="32" height="32" tilewidth="16" tileheight="16" infinite="0" nextlayerid="2" nextobjectid="10">
 <objectgroup id="1" name="spawns" type="item_spawn">
${objectsXml}
 </objectgroup>
</map>
`;
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "stamp-uids-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("stampUidsInFile", () => {
  it("stamps a uid into a self-closing object with no properties", () => {
    const file = path.join(dir, "a.tmx");
    writeFileSync(file, tmx(`  <object id="1" type="item_spawn" x="0" y="0" width="16" height="16"/>`));
    const rep = stampUidsInFile(file);
    expect(rep.stamped).toBe(1);
    const after = readFileSync(file, "utf8");
    expect(after).toMatch(/<property name="uid" value="[0-9a-f-]{36}"\/>/);
  });

  it("stamps into an existing <properties> block", () => {
    const file = path.join(dir, "b.tmx");
    writeFileSync(
      file,
      tmx(`  <object id="2" type="item_spawn" x="16" y="16" width="16" height="16">
   <properties>
    <property name="itemId" value="rope"/>
   </properties>
  </object>`),
    );
    stampUidsInFile(file);
    const after = readFileSync(file, "utf8");
    expect(after).toMatch(/<property name="itemId" value="rope"\/>/);
    expect(after).toMatch(/<property name="uid" value="[0-9a-f-]{36}"\/>/);
  });

  it("is idempotent — already-stamped files are not modified", () => {
    const file = path.join(dir, "c.tmx");
    writeFileSync(
      file,
      tmx(`  <object id="3" type="item_spawn" x="0" y="0" width="16" height="16">
   <properties>
    <property name="uid" value="already-here"/>
   </properties>
  </object>`),
    );
    const before = readFileSync(file, "utf8");
    const rep = stampUidsInFile(file);
    expect(rep.stamped).toBe(0);
    expect(rep.existingUids).toEqual(["already-here"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("check mode throws (does not write) when stamps are needed", () => {
    const file = path.join(dir, "d.tmx");
    writeFileSync(file, tmx(`  <object id="4" type="item_spawn" x="0" y="0" width="16" height="16"/>`));
    const before = readFileSync(file, "utf8");
    expect(() => stampUidsInFile(file, { check: true })).toThrow(/missing uid/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("throws on intra-file duplicate uids (copy-paste mistake)", () => {
    const file = path.join(dir, "e.tmx");
    writeFileSync(
      file,
      tmx(`  <object id="5" type="item_spawn" x="0" y="0" width="16" height="16">
   <properties><property name="uid" value="dup"/></properties>
  </object>
  <object id="6" type="item_spawn" x="16" y="0" width="16" height="16">
   <properties><property name="uid" value="dup"/></properties>
  </object>`),
    );
    expect(() => stampUidsInFile(file)).toThrow(/duplicate uid 'dup'/);
  });

  it("ignores objects whose type is not a spawn layer", () => {
    const file = path.join(dir, "f.tmx");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" orientation="orthogonal" renderorder="right-down" width="1" height="1" tilewidth="16" tileheight="16" infinite="0" nextlayerid="2" nextobjectid="2">
 <objectgroup id="1" name="other" type="enemy_spawn">
  <object id="1" type="enemy_spawn" x="0" y="0" width="16" height="16"/>
 </objectgroup>
</map>
`;
    writeFileSync(file, content);
    const rep = stampUidsInFile(file);
    expect(rep.stamped).toBe(0);
    expect(rep.existingUids).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("stampUidsInDir", () => {
  it("detects cross-file duplicate uids", () => {
    writeFileSync(
      path.join(dir, "0_0.tmx"),
      tmx(`  <object id="1" type="item_spawn" x="0" y="0" width="16" height="16">
   <properties><property name="uid" value="shared"/></properties>
  </object>`),
    );
    writeFileSync(
      path.join(dir, "1_0.tmx"),
      tmx(`  <object id="1" type="item_spawn" x="0" y="0" width="16" height="16">
   <properties><property name="uid" value="shared"/></properties>
  </object>`),
    );
    expect(() => stampUidsInDir(dir)).toThrow(/Duplicate uid 'shared' across chunks/);
  });

  it("stamps across multiple files and returns unique uids", () => {
    writeFileSync(
      path.join(dir, "0_0.tmx"),
      tmx(`  <object id="1" type="item_spawn" x="0" y="0" width="16" height="16"/>`),
    );
    writeFileSync(
      path.join(dir, "1_0.tmx"),
      tmx(`  <object id="1" type="item_spawn" x="0" y="0" width="16" height="16"/>`),
    );
    const reports = stampUidsInDir(dir);
    const all = reports.flatMap((r) => r.existingUids);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(2);
  });
});
