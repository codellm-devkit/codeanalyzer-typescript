# The analysis catalogue (Cypher)

Every recipe names its minimum `-a`. Bound every transitive walk — unbounded `*1..` enumerates
paths (exponential on real corpora); use `*1..N` with `DISTINCT`, or `shortestPath` for existence
questions. Every property referenced below is declared in `src/build/neo4j/schema.ts` — cross-check
`references/vocabulary.md` before trusting a query that isn't on this page.

## 1. Structure & inventory (L1)

```cypher
// modules with their classes and free functions
MATCH (m:TSModule)
OPTIONAL MATCH (m)-[:TS_DECLARES]->(k:TSClass)
OPTIONAL MATCH (m)-[:TS_DECLARES]->(f:TSCallable)
RETURN m.name, count(DISTINCT k) AS classes, count(DISTINCT f) AS functions
ORDER BY m.name LIMIT 25

// locate a callable — the graph has no source text, only file + line span (see vocabulary.md)
MATCH (c:TSCallable {name: "analyze"})
RETURN c.signature, c._module, c.start_line, c.end_line, c.cyclomatic_complexity
```

## 2. Call graph (L2)

```cypher
// direct callers / callees
MATCH (caller:TSCallable)-[:TS_CALLS]->(t:TSCallable {name: "authorize"}) RETURN caller.id
MATCH (t:TSCallable {name: "authorize"})-[:TS_CALLS]->(callee) RETURN labels(callee), callee.id

// bounded transitive reachability (who can reach the dataflow layer?)
MATCH (c:TSCallable)-[:TS_CALLS*1..8]->(t:TSCallable)
WHERE t._module STARTS WITH "src/dataflow"
RETURN DISTINCT c.id

// fan-in / fan-out hotspots
MATCH (c:TSCallable)
OPTIONAL MATCH (c)<-[i:TS_CALLS]-() WITH c, count(i) AS fan_in
OPTIONAL MATCH (c)-[o:TS_CALLS]->() RETURN c.id, fan_in, count(o) AS fan_out
ORDER BY fan_in + count(o) DESC LIMIT 20

// provenance split: edges only one resolver found (prov ⊆ {tsc, defuse, import})
MATCH ()-[e:TS_CALLS]->() WHERE e.prov = ["import"] RETURN count(e)

// per-callsite resolution (which statement calls what)
MATCH (c:TSCallable)-[:TS_HAS_BODY_NODE]->(s:TSBodyNode {kind: "call"})-[:TS_RESOLVES_TO]->(t)
RETURN c.id, s.start_line, labels(t), t.id LIMIT 50
```

**Reachability from a root set** (L2) — this schema has **no `is_entrypoint` flag**; supply the
root callable ids yourself (an HTTP handler, a CLI command, whatever your own convention is):

```cypher
MATCH (c:TSCallable) WHERE NOT c.id IN $roots
  AND NOT EXISTS { MATCH (r:TSCallable)-[:TS_CALLS*1..12]->(c) WHERE r.id IN $roots }
RETURN c.id, c._module, c.start_line
```

**Recursion cycles** (L2):

```cypher
// self-recursion
MATCH (c:TSCallable)-[:TS_CALLS]->(c) RETURN c.id
// mutual recursion up to length 6, one row per cycle instance
MATCH p = (c:TSCallable)-[:TS_CALLS*2..6]->(c)
WHERE ALL(n IN nodes(p)[1..] WHERE n.id >= c.id)   // canonical start, dedups rotations
RETURN [n IN nodes(p) | n.id] AS cycle LIMIT 50
```

## 3. Inheritance (L1)

`TS_EXTENDS`/`TS_IMPLEMENTS` are **resolved-only**: an external/library supertype never appears as
an edge target (no `TSExternal` endpoint exists for either relationship — check before writing a
query that assumes one).

```cypher
// hierarchy under a base (bounded)
MATCH (base:TSClass {name: "Disposable"})<-[:TS_EXTENDS*1..6]-(sub:TSClass) RETURN sub.signature

// overrides: subclass redefines a superclass method
MATCH (sub:TSClass)-[:TS_EXTENDS]->(sup:TSClass),
      (sub)-[:TS_HAS_METHOD]->(m:TSCallable),
      (sup)-[:TS_HAS_METHOD]->(base:TSCallable {name: m.name})
RETURN sub.signature, m.name, base.id AS overrides
```

## 4. Control flow & data dependence (L3; alias-widened at L4)

```cypher
// a callable's CFG in order
MATCH (c:TSCallable {name: "reconcile"})-[:TS_HAS_BODY_NODE]->(s:TSBodyNode)
OPTIONAL MATCH (s)-[n:TS_CFG_NEXT]->(t:TSBodyNode)
RETURN s.id, s.kind, s.start_line, collect({to: t.id, kind: n.kind}) ORDER BY s.start_line

// unreachable statements (no CFG path from @entry)
MATCH (c:TSCallable)-[:TS_HAS_BODY_NODE]->(entry:TSBodyNode {kind: "entry"})
MATCH (c)-[:TS_HAS_BODY_NODE]->(s:TSBodyNode)
WHERE s.kind IN ["statement", "call", "config_access"]
  AND NOT EXISTS { MATCH (entry)-[:TS_CFG_NEXT*1..64]->(s) }
RETURN c.id, s.id, s.start_line

// which condition guards this statement (control dependence)
MATCH (s:TSBodyNode {id: $stmt})<-[:TS_CDG]-(guard:TSBodyNode) RETURN guard.id, guard.kind, guard.start_line

// complexity hotspots (precomputed)
MATCH (c:TSCallable) RETURN c.id, c.cyclomatic_complexity ORDER BY c.cyclomatic_complexity DESC LIMIT 20

// def-use chain of one variable inside a callable
MATCH (c:TSCallable {name: "applyDiscount"})-[:TS_HAS_BODY_NODE]->(a:TSBodyNode)
MATCH (a)-[d:TS_DDG {var: "total"}]->(b:TSBodyNode)
RETURN a.start_line, b.start_line, d.prov

// syntactic-only view (drop the L4 alias-derived edges)
MATCH (a)-[d:TS_DDG]->(b) WHERE "reaching-defs" IN d.prov RETURN count(d)
```

## 5. Slicing & interprocedural reachability (L3 intra; L4 interproc)

```cypher
// backward slice from a statement (intra)
MATCH (s:TSBodyNode {id: $global_id})<-[:TS_DDG|TS_CDG*1..10]-(dep:TSBodyNode)
RETURN DISTINCT dep.id, dep.start_line
// forward slice: reverse the arrow
// interprocedural: add TS_PARAM_IN|TS_PARAM_OUT|TS_SUMMARY to the union (L4), keep the bound

// everything a chosen callable's parameters can influence (L4; pick $callable_sig yourself)
MATCH (e:TSCallable {signature: $callable_sig})-[:TS_HAS_BODY_NODE]->(src:TSBodyNode {kind: "formal_in"})
MATCH (src)-[:TS_DDG|TS_PARAM_IN|TS_PARAM_OUT|TS_SUMMARY*1..12]->(s:TSBodyNode)
WHERE s.kind IN ["statement", "call", "config_access"]
RETURN DISTINCT src.of, s.id

// source -> sink existence with witness path (shortestPath terminates where enumeration cannot)
MATCH (src:TSBodyNode {kind: "formal_in"})<-[:TS_HAS_BODY_NODE]-(e:TSCallable {signature: $callable_sig})
MATCH (sink:TSBodyNode {kind: "call"})-[:TS_RESOLVES_TO]->(x:TSExternal) WHERE x.module = "child_process"
MATCH p = shortestPath((src)-[:TS_DDG|TS_PARAM_IN|TS_PARAM_OUT|TS_SUMMARY*..40]->(sink))
RETURN e.id, x.name, [n IN nodes(p) | n.id] AS witness
```

This is graph substrate, not a taint product: the analyzer stops at the edges above and never
stores a `taint_flows` list. Composing source/sink packs over this reachability is the consuming
SDK's job.

## 6. Dependencies, SBOM & artifacts (L1)

Two different questions, two different filters — see SKILL.md's standing traps for the "why":

```cypher
// declared surface only — "what does this app declare?"
MATCH (:Artifact)-[d:DECLARES_DEPENDENCY {direct: true}]->(p:Package) RETURN p.name, d.kind, d.spec;
// full shipped set, transitives included — "what actually ships / where does CVE-XXXX live?"
MATCH (:Artifact)-[d:DECLARES_DEPENDENCY]->(p:Package)
OPTIONAL MATCH (:Artifact)-[l:LOCKS]->(p) RETURN p.name, d.direct, coalesce(l.version, d.spec);
```

More of the same layer:

```cypher
// full SBOM row: declaring manifest, spec, pin, evidence
MATCH (f:Artifact)-[d:DECLARES_DEPENDENCY]->(p:Package)
OPTIONAL MATCH (lf:Artifact)-[l:LOCKS]->(p)
RETURN p.name, d.kind, d.spec, d.direct, l.version AS locked, f.path AS declared_in, d.prov
ORDER BY p.name

// undeclared imports (dependency hygiene)
MATCH (a:TSApplication)-[u:TS_UNRESOLVED_IMPORT]->(x:TSExternal)
RETURN x.module, u.prov

// which callables reach code from a declared package (blast radius) — TS_PROVIDES and TS_CALLS
// ghosts are DIFFERENT ids on the shared :TSExternal label; join on `module` (vocabulary.md)
MATCH (p:Package {id: "pkg:npm/commander"})-[:TS_PROVIDES]->(g:TSExternal)
MATCH (x:TSExternal) WHERE x.module = g.module
MATCH (c:TSCallable)-[:TS_CALLS*1..6]->(x)
RETURN DISTINCT c.id

// declared but never imported (candidate dead dependency; heuristic — dynamic requires invisible)
MATCH (:Artifact)-[:DECLARES_DEPENDENCY]->(p:Package)
WHERE NOT (p)-[:TS_PROVIDES]->() RETURN p.name

// spec-vs-lock drift
MATCH (f:Artifact)-[d:DECLARES_DEPENDENCY]->(p:Package)<-[l:LOCKS]-(:Artifact)
WHERE d.spec <> "" AND NOT l.version STARTS WITH replace(split(d.spec, ",")[0], "^", "")
RETURN p.name, d.spec, l.version

// topology/container inventory — roles and hashes, NOT raw text (Artifact carries no `source`
// in Neo4j; read analysis.json for that, or re-open the file at `path`)
MATCH (:TSApplication)-[:HAS_ARTIFACT]->(f:Artifact)
WHERE any(r IN f.roles WHERE r IN ["service-topology", "container-image"])
RETURN f.path, f.format, f.roles, f.sha256

// cross-language SBOM join point: purl ids are shared across sibling analyzers
MATCH (p:Package) WHERE p.id STARTS WITH "pkg:" RETURN p.ecosystem, count(*)
```

## 7. Config-use bridge (L2 literal; L3/L4 widen)

```cypher
// which code reads a config key
MATCH (b:TSBodyNode)-[u:TS_USES_CONFIG]->(k:ConfigKey) RETURN b.id, k.key, k.namespace, u.prov;
// config reads nobody can trace (JSON only — not in the graph): analysis.json's
// application.config_reads[], { site, callee, key?, reason: "non-literal"|"undefined-key", prov }
```

```cypher
// blast radius of renaming a key: every reading body node + its owning callable
MATCH (k:ConfigKey {key: "PAYMENT_HOST"})<-[:TS_USES_CONFIG]-(b:TSBodyNode)
MATCH (c:TSCallable)-[:TS_HAS_BODY_NODE]->(b)
RETURN c.id, b.start_line

// declaration <-> use: who defines a key, who reads it, does anyone
MATCH (a:Artifact)-[:DEFINES_CONFIG]->(k:ConfigKey {key: "PAYMENT_HOST"})
OPTIONAL MATCH (k)<-[:TS_USES_CONFIG]-(b:TSBodyNode)
RETURN a.path, k.namespace, k.value, count(b) AS reads

// Dockerfile ARG vs ENV: which of this image's keys are build-time only (never bindable)
MATCH (a:Artifact {format: "dockerfile"})-[:DEFINES_CONFIG]->(k:ConfigKey)
RETURN k.key,
       CASE k.namespace WHEN "dockerfile" THEN "build-time only (ARG)" ELSE "runtime-bindable (ENV)" END AS binding

// literal-tier-only view (drop the dataflow-widened edges)
MATCH ()-[u:TS_USES_CONFIG]->() WHERE u.prov = ["literal"] RETURN count(u)
```

Edges never guess: the literal tier (`-a 2`) needs a statically-known key at a recognized env root
or detector-listed call; the dataflow tiers (`-a 3` intra, `-a 4` interprocedural) resolve only
chains that close over exactly one string literal. Everything else lands in `config_reads` with a
reason — see SKILL.md's standing traps for why that list shrinks as `-a` rises.

## 8. Health metrics (any level)

```cypher
// external call surface per module (free functions only — methods hang off TSClass, not TSModule)
MATCH (m:TSModule)-[:TS_DECLARES]->(:TSCallable)-[:TS_CALLS]->(x:TSExternal)
RETURN m.name, count(DISTINCT x.module) AS external_modules ORDER BY external_modules DESC LIMIT 20

// orphan ghosts (referenced by nothing after filtering)
MATCH (x:TSExternal) WHERE NOT ()-[]->(x) RETURN count(x)

// biggest callables by line span
MATCH (c:TSCallable) RETURN c.id, c.end_line - c.start_line AS lines ORDER BY lines DESC LIMIT 20
```
