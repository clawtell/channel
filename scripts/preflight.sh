#!/usr/bin/env bash
# ClawTell Channel Plugin — Pre-flight Validation
# Run BEFORE switching plugin paths in OpenClaw config.
#
# Usage:
#   ./scripts/preflight.sh [plugin-path]
#
# Default path: /home/claw/.npm-global/lib/node_modules/@clawtell/channel
#
# Checks:
#   1. Plugin directory exists with required files
#   2. Module loads successfully (ESM import)
#   3. Plugin exports correct structure (id, name, register)
#   4. clawdbot peer dependency resolves correctly (not a broken local copy)
#   5. No duplicate/conflicting clawdbot in plugin's node_modules

set -euo pipefail

PLUGIN_PATH="${1:-/home/claw/.npm-global/lib/node_modules/@clawtell/channel}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

FAILURES=0

echo "ClawTell Channel Plugin — Pre-flight Check"
echo "Plugin path: $PLUGIN_PATH"
echo ""

# ── 1. Directory & files ──
echo "1. Checking plugin structure..."
if [ -d "$PLUGIN_PATH" ]; then
  pass "Plugin directory exists"
else
  fail "Plugin directory not found: $PLUGIN_PATH"
  echo -e "\n${RED}ABORT: Plugin not installed.${NC}"
  exit 1
fi

for f in "dist/index.js" "dist/src/channel.js" "dist/src/poll.js" "dist/src/send.js" "dist/src/runtime.js" "openclaw.plugin.json" "package.json"; do
  if [ -f "$PLUGIN_PATH/$f" ]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

# ── 2. Module loads ──
echo ""
echo "2. Testing module import..."
LOAD_RESULT=$(node -e "
import('$PLUGIN_PATH/dist/index.js')
  .then(m => {
    const p = m.default || m;
    console.log(JSON.stringify({
      ok: true,
      id: p.id || null,
      name: p.name || null,
      hasRegister: typeof p.register === 'function'
    }));
  })
  .catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  });
" 2>/dev/null)

if echo "$LOAD_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  pass "Module loads successfully"
else
  ERROR=$(echo "$LOAD_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "$LOAD_RESULT")
  fail "Module failed to load: $ERROR"
fi

# ── 3. Export structure ──
echo ""
echo "3. Validating plugin exports..."
EXPORT_CHECK=$(echo "$LOAD_RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if not d.get('ok'): print('LOAD_FAILED'); sys.exit()
    checks = []
    if d.get('id') == 'clawtell-channel': checks.append(('id', True))
    else: checks.append(('id', False, d.get('id')))
    if d.get('name'): checks.append(('name', True))
    else: checks.append(('name', False, None))
    if d.get('hasRegister'): checks.append(('register', True))
    else: checks.append(('register', False, None))
    for c in checks:
        if c[1]: print(f'PASS:{c[0]}')
        else: print(f'FAIL:{c[0]}:{c[2] if len(c)>2 else \"missing\"}')
except: print('PARSE_ERROR')
" 2>/dev/null)

while IFS= read -r line; do
  case "$line" in
    PASS:*) pass "Export: ${line#PASS:}" ;;
    FAIL:*) fail "Export: ${line#FAIL:}" ;;
    LOAD_FAILED) fail "Skipped (module didn't load)" ;;
    PARSE_ERROR) warn "Could not parse export check" ;;
  esac
done <<< "$EXPORT_CHECK"

# ── 4. clawdbot peer dependency ──
echo ""
echo "4. Checking clawdbot resolution..."
CLAWDBOT_PATH=$(node -e "
const Module = require('module');
try {
  const resolved = Module.createRequire('$PLUGIN_PATH/dist/index.js').resolve('clawdbot/plugin-sdk');
  console.log(resolved);
} catch(e) {
  console.log('RESOLVE_FAILED:' + e.message);
}
" 2>&1)

if [[ "$CLAWDBOT_PATH" == RESOLVE_FAILED* ]]; then
  fail "clawdbot/plugin-sdk cannot be resolved: ${CLAWDBOT_PATH#RESOLVE_FAILED:}"
else
  pass "clawdbot/plugin-sdk resolves to: $CLAWDBOT_PATH"
fi

# ── 5. No broken local clawdbot ──
echo ""
echo "5. Checking for duplicate clawdbot..."
if [ -d "$PLUGIN_PATH/node_modules/clawdbot" ]; then
  if [ -L "$PLUGIN_PATH/node_modules/clawdbot" ]; then
    TARGET=$(readlink -f "$PLUGIN_PATH/node_modules/clawdbot" 2>/dev/null)
    if [ -d "$TARGET" ]; then
      warn "Local clawdbot symlink → $TARGET (verify it's the correct version)"
    else
      fail "Broken symlink: $PLUGIN_PATH/node_modules/clawdbot → $TARGET"
    fi
  else
    LOCAL_VER=$(grep '"version"' "$PLUGIN_PATH/node_modules/clawdbot/package.json" 2>/dev/null | head -1)
    warn "Local clawdbot found: $LOCAL_VER — this may cause runtime mismatches"
    warn "Consider removing: rm -rf $PLUGIN_PATH/node_modules/clawdbot"
  fi
else
  pass "No local clawdbot (resolves via hoisting — correct)"
fi

# ── Summary ──
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}✅ All checks passed. Safe to switch plugin path.${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Update plugins.load.paths in openclaw.json"
  echo "  2. Run: openclaw gateway restart  (NOT config.patch — full restart required for plugin changes)"
  exit 0
else
  echo -e "${RED}❌ $FAILURES check(s) failed. Do NOT switch plugin path until fixed.${NC}"
  exit 1
fi
