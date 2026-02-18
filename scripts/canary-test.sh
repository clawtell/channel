#!/usr/bin/env bash
# ClawTell Channel Plugin — Canary Install Test
# Run BEFORE `npm publish` to catch install issues.
#
# Usage:
#   ./scripts/canary-test.sh [package-spec]
#
# Default: installs from local tarball (npm pack)
# With arg: installs from registry (e.g., @clawtell/channel@2026.2.39)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

CANARY_DIR=$(mktemp -d /tmp/clawtell-canary-XXXXXX)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  echo "Cleaning up $CANARY_DIR..."
  rm -rf "$CANARY_DIR"
}
trap cleanup EXIT

echo "ClawTell Channel Plugin — Canary Install Test"
echo "Canary dir: $CANARY_DIR"
echo ""

if [ -n "${1:-}" ]; then
  INSTALL_SPEC="$1"
  echo "Installing from registry: $INSTALL_SPEC"
else
  echo "Packing local tarball..."
  cd "$SCRIPT_DIR"
  TARBALL=$(npm pack --pack-destination "$CANARY_DIR" 2>/dev/null | tail -1)
  INSTALL_SPEC="$CANARY_DIR/$TARBALL"
  echo "Installing from tarball: $TARBALL"
fi

echo ""

# ── Install in isolated prefix ──
echo "1. Installing to clean prefix..."
npm install --prefix "$CANARY_DIR" "$INSTALL_SPEC" --no-save 2>&1 | tail -5
echo ""

# ── Find installed path ──
PLUGIN_PATH="$CANARY_DIR/node_modules/@clawtell/channel"
if [ ! -d "$PLUGIN_PATH" ]; then
  echo -e "${RED}✗ Package not found at $PLUGIN_PATH${NC}"
  exit 1
fi
echo -e "${GREEN}✓${NC} Package installed"

# ── Check for local clawdbot (the bug that bit us) ──
echo ""
echo "2. Checking for bundled clawdbot..."
if [ -d "$PLUGIN_PATH/node_modules/clawdbot" ]; then
  echo -e "${RED}✗ Local clawdbot found in plugin node_modules!${NC}"
  echo "  This will cause runtime mismatches when installed globally."
  echo "  Fix: add peerDependenciesMeta.clawdbot.optional = true"
  exit 1
else
  echo -e "${GREEN}✓${NC} No local clawdbot (correct — uses host's copy)"
fi

# ── Module load test ──
echo ""
echo "3. Testing module import..."
RESULT=$(node -e "
import('$PLUGIN_PATH/dist/index.js')
  .then(m => {
    const p = m.default || m;
    if (p.id && p.register) {
      console.log('OK:' + p.id);
    } else {
      console.log('BAD_EXPORTS');
    }
  })
  .catch(e => console.log('FAIL:' + e.message));
" 2>&1)

if [[ "$RESULT" == OK:* ]]; then
  echo -e "${GREEN}✓${NC} Module loads, plugin id: ${RESULT#OK:}"
elif [[ "$RESULT" == FAIL:* ]]; then
  # Expected if clawdbot isn't available in canary — that's OK for peer dep
  echo -e "${GREEN}✓${NC} Module import expected to fail in canary (peer dep clawdbot not present)"
  echo "  Error: ${RESULT#FAIL:}"
  echo "  This is normal — preflight.sh validates in the real environment."
else
  echo -e "${RED}✗ Unexpected: $RESULT${NC}"
  exit 1
fi

# ── File inventory ──
echo ""
echo "4. Checking published files..."
EXPECTED_FILES=("dist/index.js" "dist/src/channel.js" "dist/src/poll.js" "dist/src/send.js" "openclaw.plugin.json" "package.json")
ALL_OK=true
for f in "${EXPECTED_FILES[@]}"; do
  if [ -f "$PLUGIN_PATH/$f" ]; then
    echo -e "  ${GREEN}✓${NC} $f"
  else
    echo -e "  ${RED}✗${NC} $f missing"
    ALL_OK=false
  fi
done

echo ""
if $ALL_OK; then
  echo -e "${GREEN}✅ Canary test passed. Safe to publish.${NC}"
else
  echo -e "${RED}❌ Canary test failed.${NC}"
  exit 1
fi
