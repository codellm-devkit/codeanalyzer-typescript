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
 * splices its source map's entries in at the CURRENT prefix (no literal ".<<." segment) — with
 * real YAML precedence (fix round 3): an explicit key always wins over a merged one regardless of
 * document order, and among multiple merge sources (`<<: [*a, *b]`) an earlier source wins over a
 * later one. `mapEntries` computes one map's own (key → winning value node) pairs — explicit keys
 * first, in one pass, so they claim their name before any merge source is even inspected — then
 * each merge source in turn, each one only filling names nobody has claimed yet, which is what
 * makes the result order-independent (a `<<` written before or after the explicit key it loses to
 * resolves the same either way). It recurses into itself for a merge source that has its own
 * nested `<<`, capped by the same depth budget `walk` uses, so a cyclic merge (a map merging
 * itself) terminates the same way a cyclic alias does.
 */
import {
  LineCounter,
  parseAllDocuments,
  isMap,
  isSeq,
  isScalar,
  isAlias,
  type Node as YamlNode,
  type YAMLMap,
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
    // walk and mapEntries are defined per-document (not hoisted above the loop) so `doc` — needed
    // to resolve this document's own aliases — is closed over correctly; parseAllDocuments may
    // yield several.
    const mapEntries = (map: YAMLMap<unknown, unknown>, depth: number): Array<[string, unknown]> => {
      const entries = new Map<string, unknown>(); // insertion order IS document order (spec-guaranteed)
      const mergeSources: unknown[] = [];
      for (const item of map.items) {
        if (isScalar(item.key) && item.key.value === "<<") {
          const resolved = isAlias(item.value) ? item.value.resolve(doc) : item.value;
          if (isSeq(resolved)) mergeSources.push(...resolved.items);
          else mergeSources.push(item.value);
          continue;
        }
        // explicit keys are collected in one pass, before any merge source is even resolved, so
        // an explicit key claims its name regardless of where "<<" sits in this same items list.
        entries.set(isScalar(item.key) ? String(item.key.value) : String(item.key), item.value);
      }
      if (depth <= 24) {
        for (const src of mergeSources) {
          const resolvedSrc = isAlias(src) ? src.resolve(doc) : src;
          if (!isMap(resolvedSrc)) continue;
          for (const [k, v] of mapEntries(resolvedSrc, depth + 1)) {
            if (!entries.has(k)) entries.set(k, v); // explicit, or an earlier source, already won
          }
        }
      }
      return [...entries];
    };
    const walk = (node: unknown, prefix: string, depth: number): void => {
      if (depth > 24) return;
      const n = isAlias(node) ? node.resolve(doc) : node;
      if (isMap(n)) {
        for (const [k, v] of mapEntries(n, depth)) {
          walk(v, prefix ? `${prefix}.${k}` : k, depth + 1);
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
