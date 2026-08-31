/**
 * L1 body population — python's `l1_body.py`: materialize each callable's `body{}` `call` nodes
 * from the INTERNAL `call_sites`, `callee: null` (the sanctioned null→id refinement happens at
 * L2, l2Callees.ts). Also materializes `config_access` nodes from `config_accesses` (#101 unit
 * C1) — a TS-native addition: the dominant env-read idiom (`process.env.FOO`) is a property
 * access, not a call, so python's call-based detector table has nothing to mirror here.
 *
 * Rebuilds `body{}` WHOLESALE every run and deletes the derived edge lists — body, cfg/cdg/ddg/
 * summary, and callee resolution are per-run projections (they embed per-run ids and per-level
 * depth), while `call_sites`/`config_accesses` are the cached source of truth. That wholesale
 * rebuild is what makes the whole pass chain idempotent across repeated emissions at different
 * levels.
 */

import type { AnalysisInternal, TSBodyNode, TSCallable, TSCallsite, TSModule } from "./schema";
import { forEachCallable } from "./schema";

/**
 * The body key of each call site, in recording order: `line:col`, disambiguated `/2`, `/3`, …
 * when chained calls share a start position. The SINGLE definition of the key sequence — l1Body
 * builds with it and l2Callees re-derives the same pairing from it.
 */
export function* callBodyKeys(sites: TSCallsite[]): Generator<[string, TSCallsite]> {
  const used = new Set<string>();
  for (const cs of sites) {
    const base = `${cs.start_line}:${cs.start_column}`;
    let key = base;
    for (let k = 2; used.has(key); k++) key = `${base}/${k}`;
    used.add(key);
    yield [key, cs];
  }
}

function callNodeOf(cs: TSCallsite): TSBodyNode {
  return {
    kind: "call",
    span: {
      start: [cs.start_line, cs.start_column],
      end: [cs.end_line, cs.end_column],
      bytes: cs.bytes ?? [0, 0],
    },
    callee: null,
    method_name: cs.method_name,
    ...(cs.receiver_expr != null ? { receiver_expr: cs.receiver_expr } : {}),
    ...(cs.receiver_type != null ? { receiver_type: cs.receiver_type } : {}),
    argument_types: cs.argument_types,
    type_arguments: cs.type_arguments,
    ...(cs.return_type != null ? { return_type: cs.return_type } : {}),
    is_constructor_call: cs.is_constructor_call,
    is_optional_chain: cs.is_optional_chain,
  };
}

function resetCallable(c: TSCallable): void {
  const body: Record<string, TSBodyNode> = {};
  // Defensive reads: a warm .codeanalyzer cache written by an earlier build of the SAME
  // analyzer_version (loadCache invalidates on version change, not shape) can hand this a
  // TSCallable that predates a field added mid-version — `config_accesses` (#101 unit C1) is
  // exactly that case. `?? []` is the whole fix; it does not change the cache format or the
  // invalidation rule, only tolerates data narrower than today's contract.
  for (const [key, cs] of callBodyKeys(c.call_sites ?? [])) body[key] = callNodeOf(cs);
  // config_access nodes share the body key space with calls: allocate AFTER them, disambiguating
  // against keys already present so a read and a call on one line never collide.
  for (const ca of c.config_accesses ?? []) {
    const base = `${ca.start_line}:${ca.start_column}`;
    let key = base;
    for (let k = 2; key in body; k++) key = `${base}/${k}`;
    body[key] = {
      kind: "config_access",
      span: { start: [ca.start_line, ca.start_column], end: [ca.end_line, ca.end_column], bytes: ca.bytes },
      root: ca.root,
      ...(ca.key !== undefined ? { key: ca.key } : {}),
    };
  }
  c.body = body;
  delete c.cfg;
  delete c.cdg;
  delete c.ddg;
  delete c.summary;
}

export function populateL1Body(app: AnalysisInternal): void {
  for (const mod of Object.values(app.symbol_table) as TSModule[]) {
    forEachCallable(mod, resetCallable);
  }
}
