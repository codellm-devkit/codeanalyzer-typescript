/**
 * YAML config-key flattening (#101 unit B). Uses the `yaml` package's document AST so spans are
 * real offsets and anchors/flow style/multiline scalars parse correctly — a hand-rolled subset
 * would silently mis-parse them. `parseAllDocuments` (not `parseDocument`) so a `---`-separated
 * multi-document stream — the standard shape of a Kubernetes manifest — is covered instead of
 * silently truncated to its first document: a single-document file keeps today's unprefixed key
 * shape exactly, a multi-document file prefixes each document's keys with its zero-based index
 * (`0.services.web.image`). One `LineCounter` spans the WHOLE parse (not one per document) since
 * `Node.range` offsets are absolute into the full source text, not reset per document. Throws
 * when any document has errors — the caller's existing catch records `extraction: "partial"` and
 * keeps the artifact node (overlay posture): a parse failure is a different fact from "nothing to
 * extract", which a silent [] can't distinguish.
 */
import { LineCounter, parseAllDocuments, isMap, isSeq, isScalar, type Node as YamlNode } from "yaml";
import { keyNode } from "./configKeys";
import type { TSConfigKey, TSSpan } from "../schema";

export function parseYamlKeys(text: string): TSConfigKey[] {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, keepSourceTokens: false });
  const bad = docs.find((d) => d.errors.length);
  if (bad) throw bad.errors[0];
  const out: TSConfigKey[] = [];
  const spanOf = (n: YamlNode): TSSpan | undefined => {
    const r = n.range;
    if (!r) return undefined;
    const s = lc.linePos(r[0]);
    const e = lc.linePos(r[1]);
    return { start: [s.line, s.col], end: [e.line, e.col], bytes: [r[0], r[1]] };
  };
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 24) return;
    if (isMap(node)) {
      for (const item of node.items) {
        const k = isScalar(item.key) ? String(item.key.value) : String(item.key);
        walk(item.value, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, `${prefix}.${i}`, depth + 1));
    } else if (isScalar(node)) {
      const v = node.value;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.push(keyNode(prefix, "yaml", v, spanOf(node as YamlNode)));
      }
    }
  };
  const multi = docs.length > 1;
  docs.forEach((doc, i) => walk(doc.contents, multi ? String(i) : "", 0));
  return out;
}
