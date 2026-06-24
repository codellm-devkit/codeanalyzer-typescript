/**
 * Jelly call-graph provider. Shells out to `@cs-au-dk/jelly` (CLI/JSON only — no library API),
 * then maps each Jelly function node back onto a symbol-table signature by source span:
 *
 *   jelly id "fileIdx:sl:sc:el:ec"  ->  files[fileIdx] + (sl,sc)  ->  ts-morph node  ->  signature
 *
 * Named declarations reuse the existing canonicalizer (computeSignatureForDecl); anonymous inline
 * callbacks — which the canonicalizer returns null for — get a SYNTHESIZED signature of the form
 * `<nearest-named-enclosing-signature>:<startLine:startCol>`, mirroring how Jelly itself identifies
 * anonymous functions purely by location. Jelly's columns are 1-based (it exports column+1), which
 * lines up with ts-morph's 1-based columns, so (file,startLine,startColumn) is a direct join key.
 *
 * This provider is read-only w.r.t. the symbol table: it emits edges over its own node universe
 * (real signatures ∪ synthesized) for diffing. Materializing synthesized callables into the symbol
 * table is a later step, only needed when jelly is promoted to authoritative.
 *
 * Whole-program, scoped to declared deps: Jelly follows imports into node_modules, but we exclude
 * every installed package NOT listed in the project's package.json `dependencies`. This keeps the
 * directly-used library surface (the deps that actually matter for edge resolution) while cutting
 * transitive bloat — critically `@ts-morph/common`, which bundles the entire ~8.7MB TypeScript
 * compiler and makes unbounded whole-program analysis OOM.
 *
 * Tier 2 — dependency functions are materialized as external symbols so edges crossing the
 * first-party↔library boundary are KEPT in both directions, tagged `ts.external`/`ts.module` (like
 * the tsc phantom mechanism). Keying differs by direction because Jelly carries no function names:
 *   • first-party → dep: keyed `module.member` via the first-party call site (resolvePhantom),
 *     matching the tsc phantom keys so the two providers' external symbols are comparable.
 *   • dep → first-party: no first-party call site to read, so keyed by package + location. This is
 *     the entrypoint signal — a framework invoking your handler.
 * Only dep→dep edges (neither endpoint first-party) are dropped.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Node, type SourceFile } from "ts-morph";
import {
  CALL_DEP,
  computeSignatureForDecl,
  fileKeyOf,
  type TSCallEdge,
  type TSExternalSymbol,
  type TSSynthesizedCallable,
} from "../schema";
import type { CallGraphResult } from "./callGraph";
import { type ExternalIndex, buildExternalIndex, resolvePhantom } from "./phantoms";
import type { CallGraphContext, CallGraphProvider } from "./provider";

const requireFrom = createRequire(import.meta.url);

interface JellyJson {
  files: string[];
  functions: Record<string, string>; // id -> "fileIdx:startLine:startCol:endLine:endCol"
  fun2fun: [number, number][]; // [callerId, calleeId]
  call2fun: [number, number][]; // [callSiteId, calleeId]
  calls: Record<string, string>; // callSiteId -> "fileIdx:sl:sc:el:ec" (span in the CALLER file)
}

/** Locate Jelly's entry script: explicit override, else the installed package. */
function resolveJellyMain(): string {
  if (process.env.JELLY_BIN) return process.env.JELLY_BIN;
  try {
    return requireFrom.resolve("@cs-au-dk/jelly/lib/main.js");
  } catch {
    throw new Error("@cs-au-dk/jelly not installed and JELLY_BIN unset");
  }
}

/** The project's declared runtime dependencies — the packages we want Jelly to descend into. */
function declaredDeps(root: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.dependencies ?? {}));
  } catch {
    return new Set();
  }
}

/** Every installed package name under node_modules (descending one level into @scope dirs). */
function installedPackages(root: string): string[] {
  const nm = path.join(root, "node_modules");
  let top: string[];
  try {
    top = fs.readdirSync(nm);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of top) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      try {
        for (const sub of fs.readdirSync(path.join(nm, e))) if (!sub.startsWith(".")) out.push(`${e}/${sub}`);
      } catch {
        /* unreadable scope dir */
      }
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Installed packages NOT declared as dependencies — excluded so whole-program stays tractable. */
function excludedPackages(root: string): string[] {
  const keep = declaredDeps(root);
  return installedPackages(root).filter((p) => !keep.has(p));
}

function runJelly(ctx: CallGraphContext, entryFiles: string[]): JellyJson {
  const out = path.join(os.tmpdir(), `cants-jelly-${process.pid}.json`);
  const excluded = excludedPackages(ctx.root);
  ctx.log.debug(`call graph (jelly): excluding ${excluded.length} non-declared packages from whole-program scope`);
  // Whole-program over first-party + declared deps only (no --ignore-dependencies, but exclude the
  // rest). `--` terminates the variadic --exclude-packages list before the positional entry files.
  const jellyArgs = ["-j", out];
  if (excluded.length) jellyArgs.push("--exclude-packages", ...excluded, "--");
  jellyArgs.push(...entryFiles);

  // Two launch modes. Compiled single-binary (CANTS_SELF_JELLY set by src/main.ts): re-exec THIS
  // executable with the hidden `__jelly` subcommand — the Jelly CLI is bundled in, so no external
  // `node` or node_modules is needed. Dev/source or explicit JELLY_BIN override: shell out to
  // `node @cs-au-dk/jelly/lib/main.js` as before.
  const self = process.env.CANTS_SELF_JELLY && !process.env.JELLY_BIN ? process.env.CANTS_SELF_JELLY : null;
  const cmd = self ?? "node";
  const args = self ? ["__jelly", ...jellyArgs] : [resolveJellyMain(), ...jellyArgs];
  try {
    execFileSync(cmd, args, {
      cwd: ctx.root,
      stdio: ["ignore", "ignore", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 600_000,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim() },
    });
    return JSON.parse(fs.readFileSync(out, "utf8")) as JellyJson;
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** getDescendantAtPos lands on the token at the span start; climb to the enclosing function node. */
function climbToFunctionLike(node: Node | undefined): Node | undefined {
  let n = node;
  while (
    n &&
    !(
      Node.isArrowFunction(n) ||
      Node.isFunctionExpression(n) ||
      Node.isFunctionDeclaration(n) ||
      Node.isMethodDeclaration(n) ||
      Node.isConstructorDeclaration(n) ||
      Node.isGetAccessorDeclaration(n) ||
      Node.isSetAccessorDeclaration(n)
    )
  ) {
    n = n.getParent();
  }
  return n;
}

/** Climb from the token at a call-site span to the enclosing call/new expression. */
function climbToCallExpr(node: Node | undefined): Node | undefined {
  let n = node;
  while (n && !(Node.isCallExpression(n) || Node.isNewExpression(n))) n = n.getParent();
  return n;
}

/** Synthetic signature for an anonymous callback: nearest signed enclosing scope + location suffix. */
function synthesize(fnNode: Node, root: string): string {
  let host: Node | undefined = fnNode.getParent();
  while (host && computeSignatureForDecl(host, root) === null) host = host.getParent();
  const hostSig = host ? computeSignatureForDecl(host, root) : null;
  const { line, column } = fnNode.getSourceFile().getLineAndColumnAtPos(fnNode.getStart());
  return `${hostSig ?? "<module>"}:<${line}:${column}>`;
}

/**
 * If a Jelly file path lives under node_modules, split it into the owning package name and the
 * path within that package. Uses the LAST `node_modules/` so nested deps resolve to the innermost
 * package, and handles `@scope/name`.
 */
function depPackage(rel: string): { pkg: string; inPkg: string } | null {
  const marker = "node_modules/";
  const idx = rel.lastIndexOf(marker);
  if (idx < 0) return null;
  const parts = rel.slice(idx + marker.length).split("/");
  if (parts[0].startsWith("@")) {
    if (parts.length < 2) return null;
    return { pkg: `${parts[0]}/${parts[1]}`, inPkg: parts.slice(2).join("/") };
  }
  return { pkg: parts[0], inPkg: parts.slice(1).join("/") };
}

/**
 * Map a function node to its signature. A `const foo = () => …` arrow is named by its
 * VariableDeclaration in the symbol table, so normalize to that parent before deciding
 * real-vs-synthesized — otherwise every named const-arrow would wrongly synthesize.
 */
function signatureFor(fn: Node, root: string): { sig: string; synth: boolean } {
  const parent = fn.getParent();
  const decl = parent && Node.isVariableDeclaration(parent) ? parent : fn;
  const real = computeSignatureForDecl(decl, root);
  if (real) return { sig: real, synth: false };
  return { sig: synthesize(fn, root), synth: true };
}

export const jellyProvider: CallGraphProvider = {
  name: "jelly",
  build(ctx): CallGraphResult {
    const entryFiles = ctx.project
      .getSourceFiles()
      .map((sf) => sf.getFilePath() as string)
      .filter((fp) => !fp.includes("/node_modules/") && !fp.endsWith(".d.ts"))
      .map((fp) => path.relative(ctx.root, fp))
      .filter((rel) => rel.length > 0 && !rel.startsWith(".."));

    if (entryFiles.length === 0) {
      ctx.log.info("call graph (jelly): no first-party source files to analyze");
      return { edges: [], external_symbols: {}, synthesized_callables: {} };
    }

    const cg = runJelly(ctx, entryFiles);

    // Phase 1: classify each Jelly function. First-party functions round-trip to a ts-morph node and
    // reuse the canonicalizer (real or synthesized). Dependency functions are recorded by package +
    // location; an external symbol is minted for them lazily, when an edge reveals how they connect.
    const id2sig = new Map<string, string>(); // first-party id -> signature
    const firstPartyIds = new Set<string>();
    const depMeta = new Map<string, { pkg: string; inPkg: string; sl: number; sc: number }>();
    let synthesized = 0;
    let unresolved = 0;

    // Anonymous callbacks get a synthesized signature with no symbol-table node; remember their
    // location so the projection can materialize a node and the edge won't dangle (issue #13).
    const synthesizedCallables: Record<string, TSSynthesizedCallable> = {};
    const recordIfSynth = (fn: Node, sig: string, synth: boolean): void => {
      if (!synth || synthesizedCallables[sig]) return;
      const { line, column } = fn.getSourceFile().getLineAndColumnAtPos(fn.getStart());
      synthesizedCallables[sig] = {
        name: "<anonymous>",
        path: fileKeyOf(fn.getSourceFile().getFilePath(), ctx.root).fileKey,
        start_line: line,
        start_column: column,
      };
    };
    for (const [id, loc] of Object.entries(cg.functions)) {
      const [fileIdx, sl, sc] = loc.split(":").map(Number);
      const rel = cg.files[fileIdx];
      if (rel === undefined) {
        unresolved++;
        continue;
      }
      const dep = depPackage(rel);
      if (dep) {
        depMeta.set(id, { pkg: dep.pkg, inPkg: dep.inPkg, sl, sc });
        continue;
      }
      const sf = ctx.project.getSourceFile(path.resolve(ctx.root, rel));
      if (!sf) {
        unresolved++;
        continue;
      }
      let offset: number;
      try {
        offset = sf.compilerNode.getPositionOfLineAndCharacter(sl - 1, sc - 1);
      } catch {
        unresolved++;
        continue;
      }
      const fn = climbToFunctionLike(sf.getDescendantAtPos(offset));
      if (!fn) {
        unresolved++; // module-level node and other non-function spans
        continue;
      }
      const { sig, synth } = signatureFor(fn, ctx.root);
      id2sig.set(id, sig);
      firstPartyIds.add(id);
      if (synth) synthesized++;
      recordIfSynth(fn, sig, synth);
    }

    const external_symbols: Record<string, TSExternalSymbol> = {};
    const edges = new Map<string, TSCallEdge>();
    let boundary = 0;
    let dropped = 0;
    const addEdge = (source: string, target: string, tags: Record<string, string>): void => {
      const k = `${source} ${target}`;
      const ex = edges.get(k);
      if (ex) ex.weight++;
      else edges.set(k, { source, target, type: CALL_DEP, weight: 1, provenance: ["jelly"], tags });
    };
    // Location-keyed fallback signature for a dep function — used when no call-site member name is
    // available (the dep→first-party direction, where the call site is inside the library).
    const depLocSig = (d: { pkg: string; inPkg: string; sl: number; sc: number }): string => {
      const sig = `${d.pkg}:${d.inPkg}:<${d.sl}:${d.sc}>`;
      if (!external_symbols[sig]) external_symbols[sig] = { name: `${d.inPkg}:${d.sl}:${d.sc}`, module: d.pkg };
      return sig;
    };
    // Per-file import/require index, for naming a library member at a first-party call site.
    const extIndexCache = new Map<string, ExternalIndex>();
    const extIndexFor = (sf: SourceFile): ExternalIndex => {
      const key = sf.getFilePath();
      let idx = extIndexCache.get(key);
      if (!idx) {
        idx = buildExternalIndex(sf as unknown as Node);
        extIndexCache.set(key, idx);
      }
      return idx;
    };

    // Phase 2a — first-party → dependency, NAMED via the call site. call2fun maps call-site → callee;
    // we resolve the site in first-party source to (caller function, library member) and key the
    // external symbol as `module.member`, matching the tsc phantom path so the two are comparable.
    for (const [callId, calleeId] of cg.call2fun) {
      const dep = depMeta.get(String(calleeId));
      if (!dep) continue; // callee is first-party (via fun2fun) or unresolved
      const cloc = cg.calls[String(callId)];
      if (!cloc) continue;
      const [cFileIdx, csl, csc] = cloc.split(":").map(Number);
      const crel = cg.files[cFileIdx];
      if (crel === undefined || depPackage(crel)) continue; // the call site must be first-party
      const sf = ctx.project.getSourceFile(path.resolve(ctx.root, crel));
      if (!sf) continue;
      let coff: number;
      try {
        coff = sf.compilerNode.getPositionOfLineAndCharacter(csl - 1, csc - 1);
      } catch {
        continue;
      }
      const callNode = climbToCallExpr(sf.getDescendantAtPos(coff));
      if (!callNode) continue;
      const callerFn = climbToFunctionLike(callNode);
      if (!callerFn) continue; // top-level call, no enclosing function
      const { sig: callerSig, synth: callerSynth } = signatureFor(callerFn, ctx.root);
      recordIfSynth(callerFn, callerSig, callerSynth);
      const ph = resolvePhantom(callNode, extIndexFor(sf));
      let sig: string;
      if (ph) {
        sig = ph.signature; // module.member
        if (!external_symbols[sig]) external_symbols[sig] = { name: ph.member, module: ph.module };
      } else {
        sig = depLocSig(dep); // unresolved import — fall back to the location key
      }
      addEdge(callerSig, sig, { "ts.external": "true", "ts.module": external_symbols[sig].module });
      boundary++;
    }

    // Phase 2b — fun2fun for first-party→first-party (internal) and dependency→first-party (the
    // entrypoint signal: a library invoking your code). first-party→dep is named in 2a; dep→dep and
    // edges with an unresolved endpoint are dropped.
    for (const [callerId, calleeId] of cg.fun2fun) {
      const cid = String(callerId);
      const tid = String(calleeId);
      const srcFP = firstPartyIds.has(cid);
      const tgtFP = firstPartyIds.has(tid);
      if (srcFP && tgtFP) {
        addEdge(id2sig.get(cid)!, id2sig.get(tid)!, {});
        continue;
      }
      if (!srcFP && tgtFP) {
        const dep = depMeta.get(cid);
        if (!dep) {
          dropped++; // unresolved caller
          continue;
        }
        addEdge(depLocSig(dep), id2sig.get(tid)!, { "ts.external": "true", "ts.module": dep.pkg });
        boundary++;
        continue;
      }
      if (!(srcFP && !tgtFP)) dropped++; // dep→dep / unresolved (first-party→dep is counted in 2a)
    }

    // Keep only synthesized callables that an edge actually references — no orphan nodes.
    const referenced = new Set<string>();
    for (const e of edges.values()) {
      referenced.add(e.source);
      referenced.add(e.target);
    }
    const synthesized_callables: Record<string, TSSynthesizedCallable> = {};
    for (const [sig, sc] of Object.entries(synthesizedCallables)) if (referenced.has(sig)) synthesized_callables[sig] = sc;

    ctx.log.info(
      `call graph (jelly): ${Object.keys(cg.functions).length} jelly funcs, ${firstPartyIds.size} first-party ` +
        `(${synthesized} synthesized, ${Object.keys(synthesized_callables).length} materialized), ` +
        `${Object.keys(external_symbols).length} external symbols, ${unresolved} unresolved, ` +
        `${edges.size} edges (${boundary} library-boundary), ${dropped} dropped`,
    );
    return { edges: [...edges.values()], external_symbols, synthesized_callables };
  },
};
