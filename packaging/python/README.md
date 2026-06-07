# codeanalyzer-typescript (Python distribution)

This directory packages the compiled `codeanalyzer-typescript` binary as a set of
platform-specific Python wheels, published to PyPI as **`codeanalyzer-typescript`**.

The CLDK Python SDK depends on this package and calls `codeanalyzer_typescript.bin_path()`
to locate the analyzer binary — the same way it imports `codeanalyzer-python` for the
Python backend. The binary itself is built from this repo's `src/` with
`bun build --compile`, so it is fully self-contained (no Node/Bun needed at runtime).

## Why platform wheels?

Unlike the Java backend (one cross-platform `.jar`), a `bun --compile` binary is
platform-specific and large (~70 MB). So we ship **one wheel per OS/arch**, tagged
`py3-none-<platform>` (the binary is Python-agnostic — no per-Python-version matrix),
and let pip resolve the correct one at install time. There is intentionally no usable
sdist: the binary cannot be built without Bun.

## Building & publishing

```bash
python -m pip install build wheel twine
./build_wheels.sh            # cross-compiles every target via Bun, emits ./dist/*.whl
twine upload dist/*.whl
```

`build_wheels.sh` loops over the Bun targets, compiles each binary into
`src/codeanalyzer_typescript/_bin/`, builds a pure wheel, and retags it to the platform.
Bun cross-compiles all targets from a single host, so this does not need a CI runner
matrix.

## Versioning

Keep the version in lockstep across three places:

- this repo's `package.json` (`version`)
- `packaging/python/pyproject.toml` (`project.version`) and `__init__.py` (`__version__`)
- the python-sdk pin in `pyproject.toml`: `[tool.backend-versions] codeanalyzer-typescript`
  and the `dependencies` entry `codeanalyzer-typescript==<version>`

## SDK integration

In the python-sdk, `TSCodeanalyzer._get_codeanalyzer_exec()` resolves the binary in
this order: `analysis_backend_path` → `$CODEANALYZER_TS_BIN` → **this package** →
in-tree bundled `bin/`. Adding `codeanalyzer-typescript` to the SDK's `dependencies`
makes the binary available automatically on install.
