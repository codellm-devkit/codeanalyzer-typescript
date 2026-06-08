![logo](https://github.com/codellm-devkit/codeanalyzer-python/blob/main/docs/assets/logo.png?raw=true)

# A TypeScript Static Analysis Toolkit (and Library)

A comprehensive static analysis tool for TypeScript and JavaScript source code that
produces the canonical CodeLLM-DevKit (CLDK) `analysis.json` — a symbol table plus a
resolver-based call graph — using the TypeScript compiler via [ts-morph](https://ts-morph.com/).
It is the TypeScript backend behind [CLDK](https://github.com/codellm-devkit/python-sdk),
mirroring its [Python](https://github.com/codellm-devkit/codeanalyzer-python) and
[Java](https://github.com/codellm-devkit/codeanalyzer-java) siblings.

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
  "call_graph":       [ /* CALL_DEP edges: { source, target, weight,
                           provenance, tags } keyed by callable signature */ ],
  "external_symbols": { /* phantom stubs for call targets outside the project
                           (imported libraries / Node builtins) */ },
  "entrypoints":      { /* framework-detected entrypoints (empty at level 1) */ }
}
```

Caller- and callee-side identifiers are produced by a single signature canonicalizer, so call
graph `source`/`target` values byte-match the corresponding `symbol_table` (or
`external_symbols`) keys.

## License

Apache 2.0 — see [LICENSE](./LICENSE).

---

<!-- The sections below document this Python distribution itself; they have no
     equivalent in the main repository README. -->

## About this package

This distributes the compiled `cants` binary as a set of
platform-specific Python wheels, published to PyPI as **`codeanalyzer-typescript`**.
The CLDK Python SDK depends on this package and calls
`codeanalyzer_typescript.bin_path()` to locate the analyzer binary. The binary is
built from this repo's `src/` with `bun build --compile`, so it is fully
self-contained (no Node/Bun needed at runtime).

### Why platform wheels?

A `bun --compile` binary is platform-specific and large (~70 MB) — there is no single
cross-platform artifact (the way a JVM backend could ship one `.jar`). So we ship **one
wheel per OS/arch**, tagged `py3-none-<platform>` (the binary is Python-agnostic — no
per-Python-version matrix), and let pip resolve the correct one at install time. There
is intentionally no usable sdist: the binary cannot be built without Bun.

### Building & publishing

```bash
python -m pip install build wheel hatchling twine
./build_wheels.sh            # cross-compiles every target via Bun, emits ./dist/*.whl
twine upload dist/*.whl
```

`build_wheels.sh` loops over the Bun targets, compiles each binary into
`src/codeanalyzer_typescript/_bin/`, builds a pure wheel, and retags it to the platform.
Bun cross-compiles all targets from a single host, so this does not need a CI runner
matrix.

### Versioning

The released version comes from the **git tag**. A push of `vX.Y.Z` triggers the
release workflow, which derives `X.Y.Z` from the tag, verifies it matches this
repo's `package.json` `version` (failing fast on mismatch), and stamps it into
`__init__.py` via `$PKG_VERSION` — hatch reads `__version__` as the wheel version
(`pyproject.toml` declares `dynamic = ["version"]`). So the GitHub Release tag, the
PyPI wheel version, and the npm `package.json` version are always in lockstep.

To cut a release: bump `package.json` `version`, then push the matching tag, e.g.

```bash
npm version 0.2.0 --no-git-tag-version   # or edit package.json
git commit -am "Release v0.2.0" && git tag v0.2.0 && git push --tags
```

For a **local** wheel build, override the fallback version explicitly:
`PKG_VERSION=0.2.0 ./build_wheels.sh`.

One thing still tracked by hand: the python-sdk pin — `[tool.backend-versions]
codeanalyzer-typescript` and the `dependencies` entry
`codeanalyzer-typescript==<version>` — must be bumped to consume a new release.

### SDK integration

In the python-sdk, `TSCodeanalyzer._get_codeanalyzer_exec()` resolves the binary in
this order: `analysis_backend_path` → `$CODEANALYZER_TS_BIN` → **this package** →
in-tree bundled `bin/`. Adding `codeanalyzer-typescript` to the SDK's `dependencies`
makes the binary available automatically on install.
