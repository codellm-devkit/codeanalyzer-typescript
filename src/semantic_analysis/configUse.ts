/**
 * config_use literal tier (#101 unit C3). Runs with the call graph — the L2 stage — because call
 * rules need resolved callees. Joins a read's statically-known key to declared ConfigKeys on
 * (namespace, key); a read that resolves to nothing becomes a first-class `config_reads` record.
 * Deterministic: every output list is sorted.
 *
 * Imports the schema/l1Body LEAF files directly (never the `../schema` barrel, which re-exports
 * `emit.ts` — the module that imports this one): going through the barrel here would close a
 * import cycle back on emit.ts.
 */
import type { AnalysisInternal, TSCallable, TSConfigRead, TSConfigUse } from "../schema/schema";
import { forEachCallable } from "../schema/schema";
import { callBodyKeys } from "../schema/l1Body";
import { ACCESS_RULES, CALL_RULES, type CallRule } from "./configUseRules";

/** (namespace, key) → declared ConfigKey ids, sorted. */
export function keyIndex(app: AnalysisInternal): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const art of Object.values(app.artifacts ?? {})) {
    for (const ck of art.config_keys) {
      const k = `${ck.namespace} ${ck.key}`;
      const arr = idx.get(k) ?? [];
      arr.push(ck.id);
      idx.set(k, arr);
    }
  }
  for (const arr of idx.values()) arr.sort();
  return idx;
}

export interface ConfigUseSets {
  uses: TSConfigUse[];
  reads: TSConfigRead[];
}

/**
 * `externalsById` is the ASSEMBLED root's `external_symbols` (id-keyed, homed by `homeExternals`),
 * not `AnalysisInternal.external_symbols` (signature-keyed) — a `call` node's resolved `callee` is
 * already the can:// external id, so the lookup here is a direct id hit, no signature round-trip.
 */
export function resolveLiteralConfigUses(
  app: AnalysisInternal,
  externalsById: Record<string, { module: string; name: string }>,
): ConfigUseSets {
  const idx = keyIndex(app);
  const uses: TSConfigUse[] = [];
  const reads: TSConfigRead[] = [];
  const rootNamespaces = new Map(ACCESS_RULES.map((r) => [r.root, r.namespaces]));

  for (const mod of Object.values(app.symbol_table)) {
    forEachCallable(mod, (c) => {
      for (const [local, node] of Object.entries(c.body)) {
        // CALL rules: a `call` node whose resolved callee matches module+callable, with the key
        // at `key_arg`. The key literal comes from the recorded call site's arguments; a call
        // whose key argument is not a literal is a non-literal read, same as a dynamic access.
        if (node.kind === "call") {
          const rule = matchCallRule(node.callee, externalsById);
          if (!rule) continue;
          const site = `${c.id}@${local}`;
          const callee = node.callee as string; // matchCallRule only returns non-null for a string callee
          const key = literalArgumentAt(c, local, rule.key_arg);
          if (key === undefined) {
            reads.push({ site, callee, reason: "non-literal", prov: ["literal"] });
            continue;
          }
          const dsts = rule.namespaces.flatMap((ns) => idx.get(`${ns} ${key}`) ?? []);
          if (!dsts.length) {
            reads.push({ site, callee, key, reason: "undefined-key", prov: ["literal"] });
            continue;
          }
          for (const dst of [...new Set(dsts)].sort()) uses.push({ src: site, dst, prov: ["literal"] });
          continue;
        }
        if (node.kind !== "config_access") continue;
        const site = `${c.id}@${local}`;
        const root = node.root ?? "";
        const namespaces = rootNamespaces.get(root) ?? ["env"];
        if (node.key === undefined) {
          reads.push({ site, callee: root, reason: "non-literal", prov: ["literal"] });
          continue;
        }
        const key = node.key;
        const dsts = namespaces.flatMap((ns) => idx.get(`${ns} ${key}`) ?? []);
        if (!dsts.length) {
          reads.push({ site, callee: root, key, reason: "undefined-key", prov: ["literal"] });
          continue;
        }
        for (const dst of [...new Set(dsts)].sort()) uses.push({ src: site, dst, prov: ["literal"] });
      }
    });
  }
  uses.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  reads.sort((a, b) => a.site.localeCompare(b.site) || (a.key ?? "").localeCompare(b.key ?? ""));
  return { uses, reads };
}

/**
 * A call node's resolved `callee` id names an external as
 * `can://…/@external/<module>/<member>`. Match prefix-aware on module (a rule for `config`
 * matches `config` and `config/lib/x`) and exactly on the member.
 */
export function matchCallRule(callee: unknown, externals: Record<string, { module: string; name: string }>): CallRule | null {
  if (typeof callee !== "string") return null;
  const ext = externals[callee];
  if (!ext) return null;
  for (const rule of CALL_RULES) {
    if (rule.callable !== ext.name) continue;
    if (ext.module === rule.module || ext.module.startsWith(`${rule.module}/`)) return rule;
  }
  return null;
}

/** The string literal at `argIndex` of the call site backing this body key, or undefined. */
export function literalArgumentAt(c: TSCallable, bodyKey: string, argIndex: number): string | undefined {
  for (const [key, cs] of callBodyKeys(c.call_sites)) {
    if (key !== bodyKey) continue;
    const raw = cs.arguments?.[argIndex];
    if (raw === undefined) return undefined;
    const m = /^["'`](.*)["'`]$/.exec(raw.trim());
    return m ? (m[1] as string) : undefined;
  }
  return undefined;
}
