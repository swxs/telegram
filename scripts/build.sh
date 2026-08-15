#!/bin/bash
# Build the telegram external plugin: compile src/ → lib/ (JS) and
# lib/types/ (declarations) with the dsh checkout's TypeScript.
#
# Dependency resolution mirrors mygo-panel / session-chatlog: the plugin's
# node_modules holds symlinks into the dsh checkout, so tsc type-checks
# against the same vendored/workspace packages the running dsh ships (each
# linked package's package.json resolves types to its built lib/types).
# Set DSH_CHECKOUT to the harness source tree (recommended). Falling back to
# `dsh` on PATH is stale: upstream no longer ships a root `bin/dsh`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && command -v cygpath &>/dev/null; then
  CHECKOUT="$(cygpath -u "$CHECKOUT")"
fi
if [ -z "$CHECKOUT" ] && command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
  CHECKOUT=$(dirname "$(dirname "$DSH_BIN")")
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT to the harness source tree)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

# Git Bash `ln -s` on Windows copies directories unless Developer Mode is on.
# Copies split TypeScript module identity, so cordis augmentations (agents,
# session/event) do not apply. Directory junctions keep a single identity.
unlink_dir() {
  local dest="$1"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    return 0
  fi
  if command -v cygpath &>/dev/null; then
    cmd.exe //c rmdir "$(cygpath -w "$dest")" >/dev/null 2>&1 || rm -rf "$dest"
  else
    rm -rf "$dest"
  fi
}

link_dir() {
  local target="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  unlink_dir "$dest"
  if command -v cygpath &>/dev/null; then
    cmd.exe //c mklink //J "$(cygpath -w "$dest")" "$(cygpath -w "$target")" >/dev/null
  else
    ln -sfn "$target" "$dest"
  fi
}

# Link one build-time dependency: <name> <checkout-relative target dir>.
link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  link_dir "$target" "node_modules/$1"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@standard-schema
link_dir "$CHECKOUT/node_modules/@types" node_modules/@types
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg @deepseek-ai/cosmokit vendor/cosmokit
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-brand packages/util/brand
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-scope packages/core/scope
link_pkg @deepseek-ai/dsh-session packages/core/session

# Test-only deps: the loader (plugin-shape spec) and the demo agent spine
# (plugin-apply spec); vitest + its type deps so tests/ can run against the
# same checkout if desired.
link_pkg @deepseek-ai/cordis-plugin-loader vendor/loader
link_pkg @deepseek-ai/dsh-agent-spine-demo packages/examples/agent-spine-demo
link_dir "$CHECKOUT/node_modules/@vitest" node_modules/@vitest
link_dir "$CHECKOUT/node_modules/vitest" node_modules/vitest

# @standard-schema/spec: external npm types referenced by cordis/schemastery
# declarations, hoisted only inside the pnpm store.
STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  link_dir "$STD_SCHEMA/node_modules/@standard-schema/spec" node_modules/@standard-schema/spec
else
  echo "build: @standard-schema/spec not found in pnpm store; skipLibCheck may still cover it" >&2
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/
