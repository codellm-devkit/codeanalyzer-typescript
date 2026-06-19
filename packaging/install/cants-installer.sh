#!/bin/sh
# cants installer — downloads the prebuilt codeanalyzer-typescript (`cants`) binary for your
# platform from the GitHub Release and installs it. Mirrors the cargo-dist installer pattern.
#
# Usage:
#   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/codellm-devkit/codeanalyzer-typescript/releases/latest/download/cants-installer.sh | sh
#
# Environment overrides:
#   CANTS_INSTALL_DIR   install location           (default: ~/.local/bin)
#   CANTS_VERSION       release tag, e.g. v0.3.0   (default: latest)
set -eu

REPO="codellm-devkit/codeanalyzer-typescript"
INSTALL_DIR="${CANTS_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CANTS_VERSION:-latest}"

os="$(uname -s)"
arch="$(uname -m)"

# Map the host platform to the published Release asset name (see packaging/python/build_wheels.sh
# targets and packaging/homebrew/generate_formula.sh).
case "$os" in
  Darwin)
    case "$arch" in
      arm64 | aarch64) asset="cants-macosx_11_0_arm64" ;;
      x86_64) asset="cants-macosx_10_12_x86_64" ;;
      *) echo "cants: unsupported macOS architecture: $arch" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64) asset="cants-manylinux2014_x86_64" ;;
      aarch64 | arm64) asset="cants-manylinux2014_aarch64" ;;
      *) echo "cants: unsupported Linux architecture: $arch" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "cants: unsupported OS '$os'. Try: pip install codeanalyzer-typescript" >&2
    exit 1
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "cants: downloading $asset ($VERSION)..."
if command -v curl >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fLsS "$url" -o "$tmp/cants"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$tmp/cants"
else
  echo "cants: need curl or wget to download" >&2
  exit 1
fi

chmod +x "$tmp/cants"
mkdir -p "$INSTALL_DIR"
mv "$tmp/cants" "$INSTALL_DIR/cants"
echo "cants: installed to $INSTALL_DIR/cants"

# PATH hint when the install dir isn't already on PATH.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "cants: add it to your PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
