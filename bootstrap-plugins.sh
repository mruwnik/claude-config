#!/bin/bash
set -euo pipefail

# Locate the marketplace directory
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
MARKETPLACE_DIR="$SCRIPT_DIR/local-plugins"

# Read marketplace name and plugins from marketplace.json
MARKETPLACE_JSON="$MARKETPLACE_DIR/.claude-plugin/marketplace.json"

if [ ! -f "$MARKETPLACE_JSON" ]; then
    echo "Error: marketplace.json not found at $MARKETPLACE_JSON"
    exit 1
fi

# Parse marketplace name
MARKETPLACE_NAME=$(python3 -c "import json; print(json.load(open('$MARKETPLACE_JSON'))['name'])")

# Parse plugin names
PLUGIN_NAMES=$(python3 -c "import json; plugins = json.load(open('$MARKETPLACE_JSON'))['plugins']; print('\n'.join([p['name'] for p in plugins]))")

# Add marketplace if not already added
EXISTING_MARKETPLACES=$(claude plugin marketplace list 2>/dev/null || echo "")

if echo "$EXISTING_MARKETPLACES" | grep -q "$MARKETPLACE_NAME"; then
    echo "Marketplace '$MARKETPLACE_NAME' - skipped"
else
    claude plugin marketplace add "$MARKETPLACE_DIR"
    echo "Marketplace '$MARKETPLACE_NAME' - added"
fi

# Install each plugin
INSTALLED_PLUGINS=$(claude plugin list 2>/dev/null || echo "")

while IFS= read -r PLUGIN_NAME; do
    [ -z "$PLUGIN_NAME" ] && continue

    FULL_PLUGIN_NAME="$PLUGIN_NAME@$MARKETPLACE_NAME"

    if echo "$INSTALLED_PLUGINS" | grep -q "$FULL_PLUGIN_NAME"; then
        echo "Plugin '$FULL_PLUGIN_NAME' - skipped"
    else
        claude plugin install "$FULL_PLUGIN_NAME" --scope user
        echo "Plugin '$FULL_PLUGIN_NAME' - installed"
    fi
done <<< "$PLUGIN_NAMES"
