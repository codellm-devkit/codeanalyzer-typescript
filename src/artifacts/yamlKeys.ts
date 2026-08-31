/**
 * YAML config-key flattening (#101 unit B). Uses the `yaml` package's document AST so spans are
 * real offsets and anchors/flow style/multiline scalars parse correctly — a hand-rolled subset
 * would silently mis-parse them. Returns [] on a parse error (overlay posture).
 */
import { LineCounter, parseDocument, isMap, isSeq, isScalar, type Node as YamlNode } from "yaml";
import { keyNode } from "./configKeys";
import type { TSConfigKey, TSSpan } from "../schema";

export function parseYamlKeys(text: string): TSConfigKey[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false });
  if (doc.errors.length) return [];
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
  walk(doc.contents, "", 0);
  return out;
}
