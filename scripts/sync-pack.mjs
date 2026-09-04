// Copy the generated data bundles from the build pipeline into public/.
//
// This replaced a build step that used to *transform* the corridors on the way
// in, merging the ones that the old grid-based builder had split apart. The
// corridors now arrive already correct -- `vis/build_corridor_graph.py` matches
// every shape to the road network, so routes sharing a street share edges and
// merge there -- and nothing is left for the app to fix up. It only copies.
//
// section_geom_* is skipped: it exists for the standalone vis app, and it is
// several megabytes this client never asks for.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TARGET = resolve(ROOT, "public/data/pack");
const SOURCE = resolve(process.env.SOURCE_PACK || resolve(ROOT, "../vis/data/pack"));
const SKIP = /^section_geom_/;

let names;
try {
  names = await readdir(SOURCE);
} catch {
  // A deployment checkout has the bundles committed and no pipeline beside it.
  console.log(`sync-pack: no source pack at ${SOURCE}, keeping public/data/pack`);
  process.exit(0);
}

await mkdir(TARGET, { recursive: true });
let copied = 0;
for (const name of names) {
  if (SKIP.test(name)) continue;
  await copyFile(resolve(SOURCE, name), resolve(TARGET, name));
  copied += 1;
}
console.log(`sync-pack: ${copied} files from ${SOURCE}`);
