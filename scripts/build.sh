#!/bin/bash
# Build the telegram external plugin: compile src/ → lib/ (JS) and
# lib/types/ (declarations) with the dsh checkout's TypeScript.
#
# Dependency resolution mirrors mygo-panel / session-chatlog: the plugin's
# node_modules holds symlinks into the dsh checkout, so tsc type-checks
# against the same vendored/workspace packages the running dsh ships (each
# linked package's package.json resolves types to its built lib/types).
# Requires `dsh` on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Resolve the dsh checkout from PATH: dsh → bin/dsh → checkout root
CHECKOUT=""
if command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
  CHECKOUT=$(dirname "$(dirname "$DSH_BIN")")
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (dsh not on PATH?)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

# Link one build-time dependency: <name> <checkout-relative target dir>.
link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  mkdir -p "$(dirname "node_modules/$1")"
  ln -sfn "$target" "node_modules/$1"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@standard-schema
ln -sfn "$CHECKOUT/node_modules/@types" node_modules/@types
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
ln -sfn "$CHECKOUT/node_modules/@vitest" node_modules/@vitest
ln -sfn "$CHECKOUT/node_modules/vitest" node_modules/vitest

# @standard-schema/spec: external npm types referenced by cordis/schemastery
# declarations, hoisted only inside the pnpm store.
STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  ln -sfn "$STD_SCHEMA/node_modules/@standard-schema/spec" node_modules/@standard-schema/spec
else
  echo "build: @standard-schema/spec not found in pnpm store; skipLibCheck may still cover it" >&2
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/
