/* Keep lib/strings.js and the components honest about each other.
 *
 *   node scripts/check-strings.mjs        report
 *   node scripts/check-strings.mjs --json machine-readable
 *
 * Three checks:
 *   1. every t("id") / <T id="id"> resolves to a string in the catalog
 *   2. every catalog key is referenced somewhere
 *   3. no display text is left hard-coded in a component
 *
 * (1) is the one that matters most: a missing id is not a build error -- the
 * page renders the id itself -- so nothing else would catch it.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { parse } = require("next/dist/compiled/babel/parser");

const { strings } = await import(pathToFileURL(path.join(ROOT, "lib/strings.js")));

/* ------------------------------------------------------------ catalog ids */
function walkCatalog(node, prefix, out) {
  for (const [key, value] of Object.entries(node)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.add(id);
    else if (value && typeof value === "object") walkCatalog(value, id, out);
  }
  return out;
}
const catalog = walkCatalog(strings, "", new Set());

/* --------------------------------------------------------------- sources */
function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
const files = [
  ...jsFiles(path.join(ROOT, "app")),
  ...jsFiles(path.join(ROOT, "components")),
];

// Props whose string value reaches a reader.
const TEXT_PROPS = new Set([
  "title", "label", "placeholder", "alt", "aria-label", "sub", "caption",
  "unit", "suffix", "prefix", "heading", "subtitle", "description", "text",
]);
// Words that look like prose but are markup, ids or data.
const IGNORE = /^(https?:|\/|#|[a-z-]+$|[A-Za-z]+\d|\d)/;

const used = new Set();
const dynamic = [];
const hardcoded = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  const ast = parse(src, { sourceType: "module", plugins: ["jsx"], errorRecovery: true });

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);

    // Any string literal that is itself a catalog id counts as a reference.
    // Ids reach t() indirectly all over this codebase -- from option arrays,
    // from ternaries, as object values -- so matching only t("literal") would
    // report most of the catalog as dead.
    if (node.type === "StringLiteral" && catalog.has(node.value)) used.add(node.value);

    // A direct read of the catalog -- strings.storyMap.speedRamp -- uses
    // everything beneath that path, e.g. a whole array of ramp labels.
    if (node.type === "MemberExpression" && !node.computed) {
      const parts = [];
      let cur = node;
      while (cur?.type === "MemberExpression" && !cur.computed && cur.property?.name) {
        parts.unshift(cur.property.name);
        cur = cur.object;
      }
      if (cur?.type === "Identifier" && cur.name === "strings" && parts.length) {
        dynamic.push({ rel, line: node.loc.start.line, prefix: `${parts.join(".")}.` });
      }
    }

    // t(`dates.monthsShort.${i}`) -> everything under that prefix is in use.
    if (node.type === "CallExpression" && node.callee?.name === "t") {
      const arg = node.arguments[0];
      if (arg?.type === "TemplateLiteral" && arg.expressions.length) {
        dynamic.push({ rel, line: node.loc.start.line, prefix: arg.quasis[0].value.raw });
      }
    }
    // <T id="..." />
    if (node.type === "JSXOpeningElement" && node.name?.name === "T") {
      for (const attr of node.attributes) {
        if (attr.type === "JSXAttribute" && attr.name.name === "id") {
          const v = attr.value;
          if (v?.type === "StringLiteral") used.add(v.value);
        }
      }
    }
    // leftover display text
    if (node.type === "JSXText") {
      const text = node.value.trim();
      if (text && /[A-Za-z]{2}/.test(text) && !IGNORE.test(text)) {
        hardcoded.push({ rel, line: node.loc.start.line, kind: "jsx-text", text });
      }
    }
    if (node.type === "JSXAttribute" && TEXT_PROPS.has(node.name?.name)) {
      const v = node.value;
      const lit = v?.type === "StringLiteral" ? v
        : v?.type === "JSXExpressionContainer" && v.expression.type === "StringLiteral"
          ? v.expression : null;
      if (lit && /[A-Za-z]{2}/.test(lit.value) && !IGNORE.test(lit.value)
        && !catalog.has(lit.value)) {
        hardcoded.push({
          rel, line: node.loc.start.line, kind: `prop:${node.name.name}`, text: lit.value,
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      visit(node[key]);
    }
  };
  visit(ast.program);
}

/* --------------------------------------------------------------- results */
const missing = [...used].filter((id) => !catalog.has(id)).sort();
const prefixes = dynamic.map((d) => d.prefix);
const unused = [...catalog]
  .filter((id) => !used.has(id) && !prefixes.some((p) => id.startsWith(p)))
  .sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ missing, unused, hardcoded }, null, 1));
} else {
  const n = (x) => String(x).padStart(4);
  console.log(`catalog ids   ${n(catalog.size)}`);
  console.log(`referenced    ${n(used.size)}`);
  console.log(`missing       ${n(missing.length)}   (referenced but not in the catalog)`);
  console.log(`unused        ${n(unused.length)}   (in the catalog, never referenced)`);
  console.log(`hard-coded    ${n(hardcoded.length)}   (display text still in a component)`);

  if (missing.length) {
    console.log("\nMISSING -- these render as the id itself:");
    for (const id of missing) console.log(`  ${id}`);
  }
  if (unused.length) {
    console.log("\nUNUSED:");
    for (const id of unused) console.log(`  ${id}`);
  }
  if (hardcoded.length) {
    console.log("\nHARD-CODED:");
    for (const h of hardcoded) {
      console.log(`  ${h.rel}:${h.line} [${h.kind}] ${h.text.replace(/\s+/g, " ").slice(0, 78)}`);
    }
  }
}

process.exit(missing.length ? 1 : 0);
