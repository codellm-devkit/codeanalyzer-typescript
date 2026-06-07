#!/usr/bin/env bash
#
# Build platform-tagged Python wheels for the codeanalyzer-typescript binary.
#
# For each target: cross-compile the binary with Bun, build a (pure) wheel with
# hatchling, then retag it from `py3-none-any` to the matching platform tag with
# `wheel tags`. The binary is python-agnostic, so each platform needs exactly one
# wheel (py3-none-<platform>), not one per Python version.
#
# Requirements on the build host:
#   - bun            (https://bun.sh)  -- cross-compiles all targets from one host
#   - python -m pip install build wheel twine
#
# Usage:
#   ./build_wheels.sh           # build all targets into ./dist
#   twine upload dist/*.whl     # publish
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"          # codeanalyzer-ts repo root (has src/index.ts)
PKG_VERSION="0.1.0"
WHEEL_STEM="codeanalyzer_typescript-${PKG_VERSION}-py3-none-any.whl"
BIN_DIR="$HERE/src/codeanalyzer_typescript/_bin"

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

  rm -rf "$BIN_DIR"
  mkdir -p "$BIN_DIR"

  ( cd "$REPO_ROOT" && bun build ./src/index.ts --compile --target="$target" \
      --outfile "$BIN_DIR/codeanalyzer-typescript$ext" )

  # Build a pure wheel (py3-none-any), then retag to the platform.
  python -m build --wheel --no-isolation -o "$HERE/dist" "$HERE"
  python -m wheel tags --remove --platform-tag "$plat" "$HERE/dist/$WHEEL_STEM"
done

# Clean the working binary so the tree stays pristine.
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"

echo
echo ">>> Built wheels:"
ls -lh "$HERE/dist"/*.whl
echo
echo "Publish with:  twine upload $HERE/dist/*.whl"
