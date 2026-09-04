// Download the packed data bundle into public/data/pack for local development.
//
// The bundle is not committed -- it is 55 MB of derived binary, and the
// deployed app reads it straight from the public GCS bucket. This pulls the
// same objects down so `npm run dev` works against a local copy, which is
// what PACK falls back to when NEXT_PUBLIC_PACK_BASE is unset.
//
// Files are stored gzipped in the bucket; fetch() decodes them transparently,
// so what lands on disk is the plain bundle.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE =
  process.env.PACK_BASE ||
  "https://storage.googleapis.com/ac-transit-ridership-pack/pack";
const TARGET = resolve(import.meta.dirname, "..", "public", "data", "pack");

// meta.json names every other file the client can ask for, but the bundle is
// small and flat enough that an explicit manifest is clearer than crawling it.
const MANIFEST = `${BASE}/manifest.json`;

async function names() {
  const response = await fetch(MANIFEST);
  if (response.ok) return (await response.json()).files;
  throw new Error(
    `no manifest at ${MANIFEST} (${response.status}) -- is PACK_BASE right?`,
  );
}

await mkdir(TARGET, { recursive: true });
const files = await names();
let bytes = 0;
await Promise.all(
  files.map(async (name) => {
    const response = await fetch(`${BASE}/${name}`);
    if (!response.ok) {
      throw new Error(`${name}: ${response.status} ${response.statusText}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    bytes += body.length;
    await writeFile(resolve(TARGET, name), body);
  }),
);
console.log(
  `fetch-pack: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB -> ${TARGET}`,
);
