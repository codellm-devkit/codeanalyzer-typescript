/**
 * Call graph — the tsc (ts-morph checker) resolver. The same type checker that typed the
 * symbol table resolves each recorded call site to a callee declaration; we backfill
 * `callee_signature` in place and emit identity-only edges whose endpoints are guaranteed to be
 * real symbol-table signatures (no dangling edges). This is the always-on base graph.
 *
 * Dispatch precision: declared-type resolution (what the checker returns) PLUS RTA-style subtype
 * expansion — for a method call whose declared target lives on an interface/base type, we also
 * emit edges to every *instantiated*, concrete subtype's override of that method. RTA edges carry
 * a `ts.dispatch=rta` tag so consumers can tell them apart from the exact declared-type edge.
 */
import { Node, type Project } from "ts-morph";
import {
  CALL_DEP,
  type TSCallEdge,
  type TSCallable,
  type TSExternalSymbol,
  type TSModule,
  type TSSynthesizedCallable,
  type TSType,
  forEachCallable,
} from "../schema";
import { resolveCalleeSignature } from "../schema";
import type { Logger } from "../utils";
import { type ExternalIndex, buildExternalIndex, resolvePhantom } from "./phantoms";

interface ClassMeta {
  is_abstract: boolean;
  methods: Set<string>; // simple method names declared directly on this class
}

export interface CallGraphResult {
  edges: TSCallEdge[];
  external_symbols: Record<string, TSExternalSymbol>;
  // Anonymous callbacks resolved as edge endpoints that the symbol table doesn't name. Empty for
  // the tsc resolver (its edges are gated to real symbol-table signatures); a residual-fallback net.
  synthesized_callables: Record<string, TSSynthesizedCallable>;
}

export function buildCallGraph(
  project: Project,
  symbol_table: Record<string, TSModule>,
  root: string,
  log: Logger,
  phantoms: boolean,
  only?: Set<string>,
): CallGraphResult {
  // 1. The node universe: every callable signature in the WHOLE symbol table. Edges may only target
  //    these, and gating uses the full (merged) table so a cross-program in-project call resolves.
  const allSignatures = new Set<string>();
  for (const mod of Object.values(symbol_table)) {
    forEachCallable(mod, (c) => allSignatures.add(c.signature));
  }
  // Callables to ITERATE: only this program's modules (all modules when `only` is undefined), so a
  // multi-program build attributes each call site to the program whose options actually resolve it.
  const callables: TSCallable[] = [];
  for (const [key, mod] of Object.entries(symbol_table)) {
    if (only && !only.has(key)) continue;
    forEachCallable(mod, (c) => callables.push(c));
  }

  // 2. Index call/new expression AST nodes by full span so we can match recorded call sites.
  const callExprIndex = indexCallExpressions(project);

  // 3. Class metadata + subtype index (for RTA expansion), built from the symbol table.
  const classMeta = new Map<string, ClassMeta>();
  const childrenOf = new Map<string, Set<string>>(); // parent signature → direct subtype class signatures
  indexClasses(symbol_table, classMeta, childrenOf);

  // 4. Instantiated classes — RTA restricts expansion to types actually `new`'d in the program.
  const instantiated = new Set<string>();
  for (const node of callExprIndex.values()) {
    if (Node.isNewExpression(node)) {
      const r = resolveCalleeSignature(node, root, allSignatures);
      // External constructors are never project subtypes, so they never feed RTA expansion; their
      // signature (`${module}.${member}`) also doesn't carry the `.constructor` suffix a dot-split
      // below would assume.
      if (r?.isConstructor && !r.external) instantiated.add(r.signature.slice(0, -".constructor".length));
    }
  }

  // 5. Resolve each recorded call site → backfill → accumulate edges (+ RTA expansion).
  const edges = new Map<string, TSCallEdge>();
  const addEdge = (source: string, target: string, rta: boolean): void => {
    const k = `${source} ${target}`;
    const ex = edges.get(k);
    if (ex) {
      ex.weight++;
      if (rta) ex.tags["ts.dispatch"] = "rta";
    } else {
      edges.set(k, {
        source,
        target,
        type: CALL_DEP,
        weight: 1,
        provenance: ["tsc"],
        tags: rta ? { "ts.dispatch": "rta" } : {},
      });
    }
  };

  // Phantom (external) symbols + a per-file import/require index, built lazily.
  const external_symbols: Record<string, TSExternalSymbol> = {};
  const extIndexCache = new Map<string, ExternalIndex>();
  const extIndexFor = (sf: Node): ExternalIndex => {
    const key = sf.getSourceFile().getFilePath();
    let idx = extIndexCache.get(key);
    if (!idx) {
      idx = buildExternalIndex(sf.getSourceFile() as unknown as Node);
      extIndexCache.set(key, idx);
    }
    return idx;
  };
  const addPhantomEdge = (source: string, target: string, module: string): void => {
    const k = `${source} ${target}`;
    const ex = edges.get(k);
    if (ex) ex.weight++;
    else
      edges.set(k, {
        source,
        target,
        type: CALL_DEP,
        weight: 1,
        provenance: ["import"],
        tags: { "ts.external": "true", "ts.module": module },
      });
  };

  let resolved = 0;
  let rtaCount = 0;
  let phantomCount = 0;
  let unresolved = 0;
  for (const caller of callables) {
    for (const site of caller.call_sites) {
      const node = callExprIndex.get(
        `${caller.abs_path}#${site.start_line}:${site.start_column}-${site.end_line}:${site.end_column}`,
      );
      if (!node) {
        unresolved++;
        continue;
      }
      const r = resolveCalleeSignature(node, root, allSignatures);
      if (r?.external) {
        // Checker-known external target (a node_modules package or the TS stdlib) — same gate as
        // the import-index fallback below: phantom edges are opt-in via `phantoms`.
        if (phantoms) {
          if (!external_symbols[r.signature]) {
            external_symbols[r.signature] = { name: r.external.member, module: r.external.module };
          }
          site.callee_signature = r.signature;
          addPhantomEdge(caller.signature, r.signature, r.external.module);
          phantomCount++;
        } else {
          unresolved++;
        }
        continue; // never RTA-expand an external target: no dot-split on a ${module}.${member} id.
      }
      if (!r) {
        // Phantom fallback: attribute the call to an imported/required external member.
        if (phantoms) {
          const ph = resolvePhantom(node, extIndexFor(node));
          if (ph) {
            if (!external_symbols[ph.signature]) {
              external_symbols[ph.signature] = { name: ph.member, module: ph.module };
            }
            site.callee_signature = ph.signature;
            addPhantomEdge(caller.signature, ph.signature, ph.module);
            phantomCount++;
            continue;
          }
        }
        unresolved++;
        continue;
      }
      site.callee_signature = r.signature; // backfill in place (the exact declared-type target)
      addEdge(caller.signature, r.signature, false);
      resolved++;

      // RTA: method calls (receiver present, not constructors) expand to instantiated overrides.
      if (!r.isConstructor && site.receiver_expr !== null) {
        const dot = r.signature.lastIndexOf(".");
        if (dot > 0) {
          const declType = r.signature.slice(0, dot);
          const methodName = r.signature.slice(dot + 1);
          for (const ovr of concreteOverrides(declType, methodName, childrenOf, classMeta, instantiated, allSignatures)) {
            if (ovr !== r.signature) {
              addEdge(caller.signature, ovr, true);
              rtaCount++;
            }
          }
        }
      }
    }
  }
  log.info(
    `call graph (tsc): ${resolved} resolved, ${rtaCount} RTA-expanded, ${phantomCount} phantom (external), ` +
      `${unresolved} unresolved, ${edges.size} unique edges, ${Object.keys(external_symbols).length} external symbols`,
  );
  return { edges: [...edges.values()], external_symbols, synthesized_callables: {} };
}

/** Concrete, instantiated subtypes of `declType` that declare an override of `methodName`. */
function concreteOverrides(
  declType: string,
  methodName: string,
  childrenOf: Map<string, Set<string>>,
  classMeta: Map<string, ClassMeta>,
  instantiated: Set<string>,
  allSignatures: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...(childrenOf.get(declType) ?? [])];
  while (queue.length) {
    const child = queue.shift() as string;
    if (seen.has(child)) continue;
    seen.add(child);
    for (const grand of childrenOf.get(child) ?? []) queue.push(grand);
    const meta = classMeta.get(child);
    if (!meta) continue;
    if (instantiated.has(child) && !meta.is_abstract && meta.methods.has(methodName)) {
      const target = `${child}.${methodName}`;
      if (allSignatures.has(target)) out.push(target);
    }
  }
  return out;
}

function indexClasses(
  symbol_table: Record<string, TSModule>,
  classMeta: Map<string, ClassMeta>,
  childrenOf: Map<string, Set<string>>,
): void {
  // RTA reach: module- and namespace-scoped classes only — classes local to a callable body are
  // deliberately outside the dispatch universe (the historical reach, kept bit-for-bit).
  const visitType = (t: TSType): void => {
    if (t.kind === "class") {
      classMeta.set(t.signature, {
        is_abstract: t.is_abstract ?? false,
        methods: new Set(Object.values(t.callables ?? {}).map((m) => m.name)),
      });
      for (const base of t.base_classes ?? []) {
        if (!childrenOf.has(base)) childrenOf.set(base, new Set());
        childrenOf.get(base)!.add(t.signature);
      }
    } else if (t.kind === "namespace") {
      for (const nt of Object.values(t.types ?? {})) visitType(nt);
    }
  };
  for (const mod of Object.values(symbol_table)) {
    for (const t of Object.values(mod.types)) visitType(t);
  }
}

function indexCallExpressions(project: Project): Map<string, Node> {
  const idx = new Map<string, Node>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (sf.isDeclarationFile() || fp.includes("/node_modules/")) continue;
    sf.forEachDescendant((n) => {
      if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
        const s = sf.getLineAndColumnAtPos(n.getStart());
        const e = sf.getLineAndColumnAtPos(n.getEnd());
        // Full span (start AND end) keys the node uniquely; chained calls like `f(x).g(y)`
        // share a start position, so a start-only key would collide and mis-resolve.
        idx.set(`${fp}#${s.line}:${s.column}-${e.line}:${e.column}`, n);
      }
    });
  }
  return idx;
}
