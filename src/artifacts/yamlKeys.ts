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
 *
 * Aliases (`*name`) are resolved against their OWNING document before the isMap/isSeq/isScalar
 * dispatch, so an aliased map/seq/scalar flattens exactly like an inline one instead of vanishing
 * silently — the whole reason for taking this dependency instead of hand-rolling was that
 * anchors/aliases parse correctly (fix round 2). A merge key (`<<: *defaults` or `<<: [*a, *b]`)
 * splices its source map's entries in at the CURRENT prefix (no literal ".<<." segment), matching
 * what the merge key means once the document is actually loaded — implemented by re-walking each
 * source at the unchanged prefix, so nested merges fall out of the existing recursion for free. A
 * cyclic alias (a map aliasing itself) resolves without error — YAML permits it — so termination
 * relies on the existing depth cap rather than a separate visited-set: resolving an alias is just
 * another step through the same depth-limited walk.
 */
import {
  LineCounter,
  parseAllDocuments,
  isMap,
  isSeq,
  isScalar,
  isAlias,
  type Node as YamlNode,
} from "yaml";
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
  const multi = docs.length > 1;
  for (const [i, doc] of docs.entries()) {
    // Defined per-document (not hoisted above the loop) so `doc` — needed to resolve this
    // document's own aliases — is closed over correctly; `parseAllDocuments` may yield several.
    const walk = (node: unknown, prefix: string, depth: number): void => {
      if (depth > 24) return;
      const n = isAlias(node) ? node.resolve(doc) : node;
      if (isMap(n)) {
        for (const item of n.items) {
          if (isScalar(item.key) && item.key.value === "<<") {
            const resolved = isAlias(item.value) ? item.value.resolve(doc) : item.value;
            const sources = isSeq(resolved) ? resolved.items : [item.value];
            for (const s of sources) walk(s, prefix, depth + 1); // same prefix — splice, don't nest
            continue;
          }
          const k = isScalar(item.key) ? String(item.key.value) : String(item.key);
          walk(item.value, prefix ? `${prefix}.${k}` : k, depth + 1);
        }
      } else if (isSeq(n)) {
        n.items.forEach((item, idx) => walk(item, `${prefix}.${idx}`, depth + 1));
      } else if (isScalar(n)) {
        const v = n.value;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out.push(keyNode(prefix, "yaml", v, spanOf(n as YamlNode)));
        }
      }
    };
    walk(doc.contents, multi ? String(i) : "", 0);
  }
  return out;
}
