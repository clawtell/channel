#!/bin/bash
# Safe OpenClaw + ClawTell update script
# Use this instead of "npm update" to avoid partial/corrupt installs

set -e

echo "🦞 ClawTell Safe Update"
echo "========================"
echo ""
echo "⚠️  Never use 'npm update -g openclaw' — it can corrupt the installation."
echo "    Always use 'npm install -g <package>@latest' for clean installs."
echo ""

echo "📦 Updating openclaw..."
npm install -g openclaw@latest
echo ""

echo "📦 Updating @clawtell/clawtell..."
npm install -g @clawtell/clawtell@latest
echo ""

echo "🔄 Restarting gateway..."
openclaw gateway restart
echo ""

echo "✅ Done. Run 'openclaw gateway status' to verify."
