<div align="center">

<img src="https://github.com/codellm-devkit/codeanalyzer-python/blob/main/docs/assets/logo.png?raw=true" alt="CodeLLM-DevKit" />

# codeanalyzer-typescript (`cants`)

**A TypeScript/JavaScript static-analysis toolkit — the CLDK backend that emits the canonical schema-v2 Code Property Graph (symbol table → call graph → intraprocedural dataflow → interprocedural SDG), as `analysis.json` or a Neo4j property graph.**

[![PyPI](https://img.shields.io/pypi/v/codeanalyzer-typescript?style=for-the-badge&logo=pypi&logoColor=white)](https://pypi.org/project/codeanalyzer-typescript/)
[![Python](https://img.shields.io/pypi/pyversions/codeanalyzer-typescript?style=for-the-badge&logo=python&logoColor=white)](https://pypi.org/project/codeanalyzer-typescript/)
[![Release](https://img.shields.io/github/actions/workflow/status/codellm-devkit/codeanalyzer-typescript/release.yml?style=for-the-badge&label=release&logo=github)](https://github.com/codellm-devkit/codeanalyzer-typescript/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](./LICENSE)

</div>

---

`cants` is a static analyzer for TypeScript/JavaScript built on the TypeScript compiler (via
[ts-morph](https://ts-morph.com/)). It produces the canonical CodeLLM-DevKit (CLDK) **schema v2**
— one additive Code Property Graph, built up level by level (symbol table → call graph →
intraprocedural dataflow → interprocedural SDG) — as `analysis.json` and can project that same
structure into a **Neo4j property graph**. It is the TypeScript backend behind
[CLDK](https://github.com/codellm-devkit/python-sdk), mirroring its
[Python](https://github.com/codellm-devkit/codeanalyzer-python) and
[Java](https://github.com/codellm-devkit/codeanalyzer-java) siblings.

By default the call graph is the **union** of two backends: the TypeScript compiler's resolver and
[Jelly](https://github.com/cs-au-dk/jelly) — a flow-based analyzer that resolves higher-order and
callback edges the resolver misses, embedded in the `cants` binary (no extra install). Merged edges
keep a `provenance` tag (`tsc` / `jelly`), so you can still tell the two apart. Pass `--tsc-only` to
drop Jelly and run the resolver alone, or `--call-graph-provider jelly` for Jelly alone.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Install via shell script](#install-via-shell-script)
  - [Install via Homebrew](#install-via-homebrew)
  - [Install via pip (PyPI)](#install-via-pip-pypi)
  - [Build from source](#build-from-source)
- [Usage](#usage)
  - [Options](#options)
  - [Examples](#examples)
- [Output targets](#output-targets)
  - [`analysis.json` (default)](#analysisjson-default)
  - [Neo4j graph](#neo4j-graph)
  - [Schema contract](#schema-contract)
- [Development](#development)
- [License](#license)

## Features

- **Symbol table** — modules, classes, interfaces, enums, type aliases, namespaces, functions,
  methods, variables, decorators, and JSDoc, with precise source spans.
- **Call graph** — the TypeScript compiler's resolver plus Rapid Type Analysis (RTA), with
  **phantom (external) nodes** for calls into imported libraries and Node builtins.
- **Pluggable call-graph backend** — the `union` of the `tsc` resolver and the embedded
  [Jelly](https://github.com/cs-au-dk/jelly) flow analyzer by default (`--tsc-only` for the resolver
  alone, `--call-graph-provider jelly` for Jelly alone).
- **Neo4j output** — project the analysis into a labeled property graph: a self-contained
  `graph.cypher` snapshot, or an **incremental** push to a live database over Bolt.
- **Versioned schema** — a machine-readable, version-stamped Neo4j schema contract
  (`--emit schema`), bundled in every release and enforced by a conformance test.
- **Self-contained binary** — no Bun or Node required at runtime; install via `pip`, Homebrew, or a
  one-line shell script.
- **Incremental** — content-hash caching so re-analyzing (and re-loading the graph) only touches
  what changed.

## Installation

### Prerequisites

Running a prebuilt `cants` binary requires **nothing** — it is fully self-contained. To *analyze* a
project, that project should be a normal Node/TypeScript project (so the compiler can resolve types
and imports). Building `cants` from source requires [Bun](https://bun.sh/) 1.0+.

### Install via shell script

Download and install the prebuilt binary for your platform from the latest release:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/codellm-devkit/codeanalyzer-typescript/releases/latest/download/cants-installer.sh | sh
```

The installer drops `cants` into `~/.local/bin` (override with `CANTS_INSTALL_DIR`) and can pin a
version with `CANTS_VERSION=vX.Y.Z`. Supports macOS (arm64/x86_64) and Linux (x86_64/aarch64).

### Install via Homebrew

```sh
brew install codellm-devkit/homebrew-tap/codeanalyzer-typescript
```

### Install via pip (PyPI)

The wheel bundles the prebuilt, self-contained binary for your platform (no Bun or Node required):

```sh
pip install codeanalyzer-typescript
cants --help
```

This is also the package CLDK's Python SDK depends on to locate the analyzer backend; it exposes
`codeanalyzer_typescript.bin_path()` and `schema_path()`.

### Build from source

```sh
# Install Bun, then:
git clone https://github.com/codellm-devkit/codeanalyzer-typescript
cd codeanalyzer-typescript
bun install
bun run build      # → dist/cants (standalone native binary)
```

You can also run the analyzer directly from source without compiling:

```sh
bun run start -- --input /path/to/typescript/project
```

## Usage

```sh
cants --input /path/to/typescript/project
```

With no `--output`, the analysis is printed to stdout as compact JSON; with `--output <dir>` it is
written to `analysis.json` (or `graph.cypher` for `--emit neo4j`) in that directory.

### Options

<!-- BEGIN cants-help -->

```text
Usage: cants [options]

CLDK TypeScript analyzer — emits the canonical schema-v2 CPG (symbol table →
call graph → dataflow → SDG) as analysis.json, or a Neo4j graph.

Options:
  -i, --input <path>             project root to analyze (not required for
                                 --emit schema)
  -o, --output <dir>             output directory (omit ⇒ compact output to
                                 stdout)
  --emit <target>                output target: json (analysis.json, default) |
                                 neo4j (graph.cypher or live push) | schema (the
                                 Neo4j schema.json contract) (default: "json")
  --app-name <name>              logical application name for the graph
                                 :Application anchor (default: input dir name)
  --neo4j-uri <uri>              push the graph to a live Neo4j over Bolt
                                 (incremental); omit to write graph.cypher (env:
                                 NEO4J_URI)
  --neo4j-user <user>            Neo4j username (default: "neo4j", env:
                                 NEO4J_USERNAME)
  --neo4j-password <password>    Neo4j password (prefer the env var; a flag is
                                 visible in shell history / process list)
                                 (default: "neo4j", env: NEO4J_PASSWORD)
  --neo4j-database <db>          Neo4j database name (env: NEO4J_DATABASE)
  -a, --analysis-level <n>       analysis depth: 1 = symbol table (default); 2 =
                                 + resolver call graph; 3 = + intraprocedural
                                 dataflow (cfg/cdg/ddg); 4 = + interprocedural
                                 SDG (param_in/param_out/summary) (default: "1")
  --graphs <list>                dataflow sections to emit, comma-separated: cfg
                                 | dfg | pdg (require -a 3) | sdg (requires -a
                                 4); default: all rungs at or below the level
  --graph-field-depth <k>        access-path depth bound (k-limit) for level-3
                                 dataflow (default: "3")
  -j, --jobs <n>                 worker parallelism for level-3 graphs (default:
                                 sequential; opt in with N ≥ 2 on large projects
                                 — each worker loads its own copy of the
                                 program)
  -t, --target-files <paths...>  restrict analysis to specific files
                                 (incremental)
  --skip-tests                   skip test trees (default)
  --include-tests                include test trees
  --eager                        force a clean rebuild instead of reusing the
                                 cache
  --lazy                         reuse the cache (default)
  --no-build                     skip dependency materialization (use a prepared
                                 node_modules)
  --no-phantoms                  disable phantom (external) nodes for
                                 imported/required library calls
  --call-graph-provider <name>   call-graph backend: union (default, tsc ∪
                                 jelly) | tsc | jelly | both (deprecated alias
                                 of union) (default: "union")
  --tsc-only                     use the tsc resolver only — opt out of Jelly
                                 edges (overrides --call-graph-provider)
  -f, --format <fmt>             output format: json (default) | msgpack (not
                                 yet implemented) (default: "json")
  -c, --cache-dir <dir>          cache/intermediate directory
  -v, --verbose                  increase verbosity (repeatable)
  -h, --help                     display help for command
```

<!-- END cants-help -->

### Examples

1. **Basic analysis to stdout, or to a file:**
   ```sh
   cants --input ./my-ts-project                         # compact JSON on stdout
   cants --input ./my-ts-project --output ./out          # → ./out/analysis.json
   ```

2. **Emit a Neo4j snapshot, or push to a live database:**
   ```sh
   cants --input ./my-ts-project --emit neo4j --output ./out     # → ./out/graph.cypher
   cants --input ./my-ts-project --emit neo4j \
     --neo4j-uri bolt://localhost:7687 --neo4j-user neo4j --neo4j-password secret
   ```

3. **Incremental analysis of specific files:**
   ```sh
   cants --input ./my-ts-project --target-files src/a.ts src/b.ts
   ```

4. **Resolver-only call graph (opt out of Jelly):**
   ```sh
   cants --input ./my-ts-project --tsc-only
   ```

5. **Force a clean rebuild with a custom cache directory:**
   ```sh
   cants --input ./my-ts-project --eager --cache-dir /path/to/custom-cache
   ```

6. **Program graphs (level 3): CFG/PDG/SDG in `analysis.json`:**
   ```sh
   cants --input ./my-ts-project -a 3                    # full program_graphs section
   cants --input ./my-ts-project -a 3 --graphs cfg,pdg   # scope the emitted graphs
   ```

## Output targets

`cants` builds one analysis in memory and can emit it three ways (`--emit`):

### `analysis.json` (default)

The **canonical schema v2** — one additive Code Property Graph: a containment tree of nodes
(`id` / `kind` / `span` / children) with typed edge overlays. Analysis **levels** populate it more
deeply; each level only ever *adds*.

```jsonc
{
  "schema_version": "2.0.0", "language": "typescript", "max_level": 4, "k_limit": 3,
  "application": {
    "id": "can://typescript/<app>", "kind": "application",
    "symbol_table": {                     // L1: the tree, keyed by file path
      "<file>": { "kind": "module", "source": "…",
        "types":     { /* class | interface | enum | type_alias | namespace nodes */ },
        "functions": { /* callable nodes: { id, kind, span, body{}, cfg[], cdg[], ddg[], summary[] } */ },
        "fields":    { /* module-level bindings */ } } },
    "call_graph": [ /* L2: { src, dst, prov, weight } — callable → callable, can:// ids */ ],
    "param_in":   [ /* L4: actual_in → formal_in, fully-qualified can://…@local ids */ ],
    "param_out":  [ /* L4: formal_out → actual_out */ ]
  }
}
```

Each callable's `body{}` is keyed by local id (`line:col`, or `@entry`/`@formal_in:N`/… for
synthetic vertices); intra-callable edge lists (`cfg`/`cdg`/`ddg`/`summary`) use those bare local
ids, cross-callable lists use fully-qualified `can://…@local` ids. A single signature canonicalizer
underlies every `can://` id, so call edges, dataflow edges, and tree nodes all join. The full model
is `.claude/SCHEMA_DECISIONS.md` (§ "Schema v2 migration") and the CLDK `canonical-schema.md`.

### Dataflow (`-a 3` intraprocedural, `-a 4` interprocedural)

Native dependence graphs, built in-process from the same ts-morph AST (no external engine), grown
**into the tree** (not a separate section):

- **`-a 3`** completes each callable's `body{}` with statement nodes and hangs the intra-callable
  edge lists `cfg` (exceptional control flow), `cdg` (control dependence), and `ddg` (data
  dependence via reaching-definitions, `prov:["reaching-defs"]`) on the callable.
- **`-a 4`** adds the synthetic `@formal_in:N` / `@formal_out` / `<L>/actual_in:N` / `<L>/actual_out`
  vertices, the intra-caller `summary` edges, and the application-scope `param_in` / `param_out`
  lists — the whole-program System Dependence Graph.

`-a 3` implies `-a 2`; `-a 4` implies `-a 3`. `--graphs cfg,dfg,pdg,sdg` scopes which rungs emit
(`cfg`/`dfg`/`pdg` require `-a 3`, `sdg` requires `-a 4`). `L1 ⊆ L2 ⊆ L3 ⊆ L4` is a monotonicity
gate. Every node is addressed by its `can://…@local` id, so dataflow edges, call edges, and tree
nodes all join.

**Substrate (locked in [issue #2](https://github.com/codellm-devkit/codeanalyzer-typescript/issues/2)):**
the CFG and reaching-definitions are hand-built from the ts-morph AST; the call-graph oracle is
the existing provenance-merged tsc ∪ Jelly graph; aliasing is a flow-insensitive copy-alias MVP
(Jelly points-to-backed propagation is a staged upgrade). Function summaries are composed
bottom-up over the SCC condensation of the call graph, with k-limited access paths; module
globals ride the SDG as extra parameters. The analysis is deliberately sound-leaning and
over-approximate; known unsoundness (dynamic `eval`, reflection/monkey-patching, npm-internal
effects) is recorded in `.claude/SCHEMA_DECISIONS.md`. The analyzer is a **pure graph provider**:
it emits the dependence-graph substrate (CFG/PDG/SDG + `summary` edges) and stops — backward
slicing and taint are reachability *queries* over the SDG that live in the frontend SDK, not here.

**Parallelism (`-j/--jobs`).** The pipeline implements the level-3 parallel execution model:
stage-1–4 extraction fans out per callable over a Bun worker pool (partitioned by file) and is
posted *before* the call-graph solve so the two overlap; summary composition runs as a
Kahn-style ready-queue wavefront over the SCC condensation DAG (the SCC is the atomic unit).
`--jobs N` output is **byte-identical** to `--jobs 1` (node ids are span-ordered, all edge lists
are collect-then-sorted, and the SCC fixpoint is a pure function of its inputs) — enforced by a
differential test. It is off by default and worth opting into only on large codebases: ts-morph
ASTs cannot cross the worker boundary, so each extraction worker loads its own copy of the
program, which dominates the parallelizable graph math on small/mid repos (self-analysis runs
2.5× slower at `-j 14`). Worker failure at any stage degrades to the sequential path with a
warning — never to wrong or missing output.

Levels 1/2 are unaffected: nothing in level 3 runs unless `-a 3` is requested.

### Neo4j graph

`--emit neo4j` projects the **same v2 tree** into a labeled property graph: every node keyed by its
`can://` id under a shared `:CanNode` merge label (+ a specific kind label), containment as
`HAS_MODULE`/`DECLARES`/`HAS_METHOD`/`HAS_FIELD`/`HAS_BODY_NODE` edges, and the overlays (`CALLS`,
`CFG_NEXT`, `CDG`, `DDG`, `SUMMARY`, `PARAM_IN`, `PARAM_OUT`) as typed relationships. The graph is
**always full-depth** — analysis levels gate the JSON path only, so combining `-a`/`--graphs` with
`--emit neo4j` is an error:

- **Without `--neo4j-uri`** — writes a self-contained `graph.cypher` (constraints + indexes, a
  scoped wipe, then batched `MERGE`s). Load it with `cypher-shell < graph.cypher`.
- **With `--neo4j-uri`** — pushes to a live Neo4j over Bolt **incrementally**: only modules whose
  content hash changed are rewritten, and on a full run modules whose source file vanished are
  pruned. Every graph carries a `schema_version` on its `:Application` node.

The connection options also read the standard Neo4j environment variables — `NEO4J_URI`,
`NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` — when the corresponding flag is omitted (an
explicit flag wins). Prefer the env var for the password so it doesn't land in shell history or the
process list:

```sh
export NEO4J_URI=bolt://localhost:7687
export NEO4J_PASSWORD=secret
cants --input ./my-ts-project --emit neo4j     # credentials picked up from the environment
```

### Schema contract

`--emit schema` writes the machine-readable, version-stamped Neo4j schema (`schema.json`: node
labels, relationships, properties, constraints, and indexes). It needs no project and is bundled in
every release (as a wheel asset and a GitHub Release asset), so a consumer can validate
producer/consumer compatibility without invoking the binary.

```sh
cants --emit schema                 # print to stdout
cants --emit schema --output ./out  # → ./out/schema.json
```

## Development

This project uses [Bun](https://bun.sh/) as its toolchain.

```sh
bun install
bun run start -- --input /path/to/project   # run from source
bun run typecheck                            # type-check
bun test                                     # tests (the Neo4j bolt test is opt-in; see below)
bun run test:container                       # Neo4j bolt tests — needs Docker/Podman (opt-in)
bun run gen:schema                           # regenerate schema.neo4j.json
bun run gen:readme                           # regenerate the cants --help block above
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
