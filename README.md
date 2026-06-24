<div align="center">

<img src="https://github.com/codellm-devkit/codeanalyzer-python/blob/main/docs/assets/logo.png?raw=true" alt="CodeLLM-DevKit" />

# codeanalyzer-typescript (`cants`)

**A TypeScript/JavaScript static-analysis toolkit — the CLDK backend that emits a canonical symbol table and call graph, as `analysis.json` or a Neo4j property graph.**

[![PyPI](https://img.shields.io/pypi/v/codeanalyzer-typescript?style=for-the-badge&logo=pypi&logoColor=white)](https://pypi.org/project/codeanalyzer-typescript/)
[![Python](https://img.shields.io/pypi/pyversions/codeanalyzer-typescript?style=for-the-badge&logo=python&logoColor=white)](https://pypi.org/project/codeanalyzer-typescript/)
[![Release](https://img.shields.io/github/actions/workflow/status/codellm-devkit/codeanalyzer-typescript/release.yml?style=for-the-badge&label=release&logo=github)](https://github.com/codellm-devkit/codeanalyzer-typescript/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](./LICENSE)

</div>

---

`cants` is a static analyzer for TypeScript/JavaScript built on the TypeScript compiler (via
[ts-morph](https://ts-morph.com/)). It produces the canonical CodeLLM-DevKit (CLDK)
`analysis.json` — a symbol table plus a resolver-based call graph — and can project that same
analysis into a **Neo4j property graph**. It is the TypeScript backend behind
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

CLDK TypeScript analyzer — emits the canonical analysis.json (symbol table +
resolver call graph), or a Neo4j graph.

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
  -a, --analysis-level <n>       analysis depth: 1 = symbol table + tsc resolver
                                 call graph + RTA (default); 2 = call graph
                                 (default: "1")
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

## Output targets

`cants` builds one analysis in memory and can emit it three ways (`--emit`):

### `analysis.json` (default)

A `TSApplication` document — the canonical CLDK contract the Python SDK parses:

```jsonc
{
  "symbol_table":     { /* file path → module (classes, interfaces, enums,
                           type aliases, functions, namespaces, variables, …) */ },
  "call_graph":       [ /* CALL_DEP edges: { source, target, type, weight,
                           provenance, tags } keyed by callable signature */ ],
  "external_symbols": { /* phantom stubs for call targets outside the project */ }
}
```

Caller- and callee-side identifiers come from a single signature canonicalizer, so call-graph
`source`/`target` values byte-match the corresponding `symbol_table` / `external_symbols` keys.

### Neo4j graph

`--emit neo4j` projects the same analysis into a labeled property graph (declarations keyed by
their signature under a shared `:Symbol` label; calls, imports, inheritance, decorators, and call
sites as relationships):

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
