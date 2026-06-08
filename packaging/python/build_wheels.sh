#!/usr/bin/env bash
#
# Build platform-tagged Python wheels for the cants (codeanalyzer-typescript) binary.
#
# For each target: cross-compile the binary with Bun, build a (pure) wheel with
# hatchling, then retag it from `py3-none-any` to the matching platform tag with
# `wheel tags`. The binary is python-agnostic, so each platform needs exactly one
# wheel (py3-none-<platform>), not one per Python version.
#
# Requirements on the build host:
#   - bun            (https://bun.sh)  -- cross-compiles all targets from one host
#   - python -m pip install build wheel hatchling twine
#     (hatchling is the build backend; --no-isolation means it must be installed)
#
# Usage:
#   ./build_wheels.sh           # build all targets into ./dist
#   twine upload dist/*.whl     # publish
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"          # codeanalyzer-ts repo root (has src/index.ts)
# Version comes from the environment (the release workflow sets it from the git
# tag); the literal is only a local-dev fallback. It is written into __init__.py,
# which is hatch's single source of truth for the wheel version.
PKG_VERSION="${PKG_VERSION:-0.1.0}"
WHEEL_STEM="codeanalyzer_typescript-${PKG_VERSION}-py3-none-any.whl"
BIN_DIR="$HERE/src/codeanalyzer_typescript/_bin"
INIT_PY="$HERE/src/codeanalyzer_typescript/__init__.py"

# Remove built binaries from _bin/ but keep the tracked .gitignore (and the dir),
# so a local build leaves the working tree pristine.
clean_bin() { mkdir -p "$BIN_DIR"; find "$BIN_DIR" -mindepth 1 ! -name '.gitignore' -delete; }

# Stamp $PKG_VERSION into __init__.py for the build, restoring the original on
# exit so the working tree stays pristine (mirrors the _bin cleanup below).
ORIG_INIT="$(cat "$INIT_PY")"   # $(...) strips the trailing newline; restore re-adds it
restore_init() { printf '%s\n' "$ORIG_INIT" > "$INIT_PY"; }
trap restore_init EXIT
python - "$INIT_PY" "$PKG_VERSION" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path).read()
new, n = re.subn(r'__version__ = "[^"]*"', f'__version__ = "{version}"', text)
if n != 1:
    raise SystemExit(f"expected exactly one __version__ assignment in {path}, found {n}")
open(path, "w").write(new)
print(f">>> stamped __version__ = {version}")
PY

# "bun --target" : "wheel platform tag"
TARGETS=(
  "bun-darwin-arm64:macosx_11_0_arm64"
  "bun-darwin-x64:macosx_10_12_x86_64"
  "bun-linux-x64:manylinux2014_x86_64"
  "bun-linux-arm64:manylinux2014_aarch64"
  "bun-windows-x64:win_amd64"
  # Uncomment for Alpine/musl support:
  # "bun-linux-x64-musl:musllinux_1_2_x86_64"
  # "bun-linux-arm64-musl:musllinux_1_2_aarch64"
)

rm -rf "$HERE/dist"
mkdir -p "$HERE/dist"

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  plat="${entry##*:}"
  ext=""
  [[ "$target" == *windows* ]] && ext=".exe"

  echo ">>> [$target] compiling -> wheel ($plat)"

  clean_bin

  ( cd "$REPO_ROOT" && bun build ./src/index.ts --compile --target="$target" \
      --outfile "$BIN_DIR/cants$ext" )

  # Build a pure wheel (py3-none-any), then retag to the platform.
  python -m build --wheel --no-isolation -o "$HERE/dist" "$HERE"
  python -m wheel tags --remove --platform-tag "$plat" "$HERE/dist/$WHEEL_STEM"
done

# Clean the working binary so the tree stays pristine.
clean_bin

echo
echo ">>> Built wheels:"
ls -lh "$HERE/dist"/*.whl
echo
echo "Publish with:  twine upload $HERE/dist/*.whl"
