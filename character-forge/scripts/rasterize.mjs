import { Resvg } from "@resvg/resvg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const inDir = path.join(root, "input");
const outRoot = path.join(root, "public", "characters");

async function* walkSvgs(dir) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkSvgs(p);
    else if (ent.name.toLowerCase().endsWith(".svg")) yield p;
  }
}

async function main() {
  const exists = await fs.stat(inDir).catch(() => null);
  if (!exists) {
    console.error(`No input directory: ${inDir}`);
    console.error("Create input/<character>/<part>.svg files first.");
    process.exit(1);
  }
  let count = 0;
  for await (const svgPath of walkSvgs(inDir)) {
    const rel = path.relative(inDir, svgPath);
    const segments = rel.split(path.sep);
    const charName = segments[0];
    const partName = path.basename(rel, ".svg");
    const outPath = path.join(outRoot, charName, "parts", `${partName}.png`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const svg = await fs.readFile(svgPath, "utf8");
    const resvg = new Resvg(svg, { fitTo: { mode: "original" } });
    const png = resvg.render().asPng();
    await fs.writeFile(outPath, png);
    console.log("→", path.relative(root, outPath));
    count++;
  }
  console.log(`Rasterized ${count} parts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
