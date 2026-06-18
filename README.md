![logo](https://github.com/codellm-devkit/codeanalyzer-python/blob/main/docs/assets/logo.png?raw=true)

# A TypeScript Static Analysis Toolkit (and Library)

A comprehensive static analysis tool for TypeScript and JavaScript source code that
produces the canonical CodeLLM-DevKit (CLDK) `analysis.json` — a symbol table plus a
resolver-based call graph — using the TypeScript compiler via [ts-morph](https://ts-morph.com/).
It is the TypeScript backend behind [CLDK](https://github.com/codellm-devkit/python-sdk),
mirroring its [Python](https://github.com/codellm-devkit/codeanalyzer-python) and
[Java](https://github.com/codellm-devkit/codeanalyzer-java) siblings.

The call graph defaults to the TypeScript compiler's resolver, but the `cants` binary also
embeds [Jelly](https://github.com/cs-au-dk/jelly) — a flow-based analyzer that resolves
higher-order and callback edges the resolver misses — as an experimental backend. Select it
with `--call-graph-provider jelly` (or `both` to run each and log how their edge sets differ);
no extra install is needed, since Jelly ships inside the binary.

The analyzer resolves types and call targets with the TypeScript compiler, so the project
being analyzed should be a normal Node/TypeScript project. By default, the analyzer
materializes the project's dependencies (`node_modules`) so that imported library calls can
be resolved as phantom (external) nodes; pass `--no-build` to reuse an already-prepared
`node_modules`.

## Install

The quickest way to get the `cants` command is from PyPI — the wheel bundles a prebuilt,
self-contained binary for your platform (no Bun or Node required to run it):

```bash
pip install codeanalyzer-typescript
cants --help
```

This is also the package CLDK's Python SDK depends on to locate the analyzer backend.

Alternatively, install it with [Homebrew](https://brew.sh/):

```bash
brew install codellm-devkit/homebrew-tap/codeanalyzer-typescript
```

To build from source instead, see [Building `cants`](#building-cants) below.

## Building `cants`

Building from source requires [Bun](https://bun.sh/) 1.0 or higher:

```bash
curl -fsSL https://bun.sh/install | bash
```

Clone the repository and install dependencies:

```bash
git clone https://github.com/codellm-devkit/codeanalyzer-ts
cd codeanalyzer-ts
bun install
```

Compile a standalone native binary (no Bun/Node required to run it afterward):

```bash
bun run build      # → dist/cants
```

You can also run the analyzer directly from source without compiling:

```bash
bun run start -- --input /path/to/typescript/project
```

## Usage

The analyzer provides a command-line interface for performing static analysis on
TypeScript/JavaScript projects.

### Basic Usage

```bash
cants --input /path/to/typescript/project
```

### Command Line Options

To view the available options, run `cants --help`:

```text
Usage: cants [options]

CLDK TypeScript analyzer — emits the canonical analysis.json
(symbol table + resolver call graph).

Options:
  -i, --input <path>             project root to analyze
  -o, --output <dir>             output directory for analysis.json
                                 (omit ⇒ compact JSON to stdout)
  -f, --format <fmt>             output format: json | msgpack (default: "json")
  -a, --analysis-level <n>       analysis depth: 1 = symbol table + tsc resolver
                                 call graph + RTA (default); 2 = call graph
                                 (default: "1")
  -t, --target-files <paths...>  restrict analysis to specific files (incremental)
      --skip-tests               skip test trees (default)
      --include-tests            include test trees
      --eager                    force a clean rebuild instead of reusing the cache
      --lazy                     reuse the cache (default)
      --no-build                 skip dependency materialization
                                 (use a prepared node_modules)
      --no-phantoms              disable phantom (external) nodes for imported/
                                 required library calls
      --call-graph-provider <name>
                                 call-graph backend: tsc (default) | jelly | both
  -c, --cache-dir <dir>          cache/intermediate directory
  -v, --verbose                  increase verbosity (repeatable)
  -h, --help                     display help for command
```

### Examples

1. **Basic analysis (symbol table + call graph):**
   ```bash
   cants --input ./my-ts-project
   ```

   This prints the analysis to stdout as compact JSON. To save it instead, use `--output`:

   ```bash
   cants --input ./my-ts-project --output /path/to/analysis-results
   ```

   The results are written to `analysis.json` in the specified directory.

2. **Change output format to msgpack:**
   ```bash
   cants --input ./my-ts-project --output /path/to/analysis-results --format msgpack
   ```

   This saves the results to `analysis.msgpack`, a binary format that is more compact for
   storage and transmission.

3. **Selecting an analysis level:**
   ```bash
   cants --input ./my-ts-project --analysis-level 2
   ```

   Every run produces a symbol table **and** a call graph. Edges come from the TypeScript
   compiler's resolver plus Rapid Type Analysis (RTA), with phantom nodes for calls into
   imported libraries.

4. **Incremental analysis of specific files:**
   ```bash
   cants --input ./my-ts-project --target-files src/a.ts src/b.ts
   ```

   Restricts the analysis to the named files, reusing the cached analysis for the rest of
   the project.

5. **Force a clean rebuild with a custom cache directory:**
   ```bash
   cants --input ./my-ts-project --eager --cache-dir /path/to/custom-cache
   ```

   `--eager` rebuilds the analysis cache from scratch. If `--cache-dir` is omitted, the cache
   defaults to `.codeanalyzer` inside the project root.

## Output

By default, analysis results are printed to stdout as compact JSON. When `--output` is given,
results are saved to `analysis.json` (or `analysis.msgpack` with `--format msgpack`) in the
specified directory.

The output document is a `TSApplication` with the following top-level shape:

```jsonc
{
  "symbol_table":     { /* file path → module (classes, interfaces, enums,
                           type aliases, functions, namespaces, variables, …) */ },
  "call_graph":       [ /* CALL_DEP edges: { source, target, type, weight,
                           provenance, tags } keyed by callable signature */ ],
  "external_symbols": { /* phantom stubs for call targets outside the project
                           (imported libraries / Node builtins) */ }
}
```

Framework-detected entrypoints are embedded on the owning callables and classes
(an `entrypoints` array on each), not collected in a top-level map.

Caller- and callee-side identifiers are produced by a single signature canonicalizer, so call
graph `source`/`target` values byte-match the corresponding `symbol_table` (or
`external_symbols`) keys.

## Development

This project uses [Bun](https://bun.sh/) as its toolchain.

### Development Setup

```bash
git clone https://github.com/codellm-devkit/codeanalyzer-ts
cd codeanalyzer-ts
bun install
```

### Running from Source

```bash
bun run start -- --input /path/to/typescript/project
```

### Type Checking

```bash
bun run typecheck
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
