#!/bin/bash
# Install CESP sound packs from the openpeon registry: install.sh <pack>...
# Every installed pack joins the per-session rotation; delete its dir to remove it.
set -euo pipefail

PACKS_DIR="$(dirname "$0")/packs"
REGISTRY=$(curl -fsSL https://peonping.github.io/registry/index.json)

for NAME in "$@"; do
    ENTRY=$(jq -c --arg n "$NAME" '.packs[] | select(.name == $n)' <<< "$REGISTRY")
    [[ -z "$ENTRY" ]] && { echo "$NAME: not in registry" >&2; continue; }
    BASE="https://raw.githubusercontent.com/$(jq -r '"\(.source_repo)/\(.source_ref)/\(.source_path)"' <<< "$ENTRY")"
    BASE="${BASE%/.}"

    TMP=$(mktemp -d)
    curl -fsSL "$BASE/openpeon.json" -o "$TMP/openpeon.json"
    # Manifests are third-party: refuse paths that could escape the pack dir.
    if jq -r '.categories[].sounds[].file' "$TMP/openpeon.json" | grep -qE '(^/|\.\.)'; then
        echo "$NAME: unsafe file path in manifest, skipped" >&2; rm -rf "$TMP"; continue
    fi
    jq -r '.categories[].sounds[] | "\(.file)\t\(.sha256 // "")"' "$TMP/openpeon.json" | sort -u |
    while IFS=$'\t' read -r FILE SHA; do
        mkdir -p "$TMP/$(dirname "$FILE")"
        curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
        [[ -z "$SHA" || $(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1) == "$SHA" ]] || { echo "$NAME: checksum mismatch on $FILE" >&2; exit 1; }
    done
    rm -rf "${PACKS_DIR:?}/$NAME"; mkdir -p "$PACKS_DIR"; mv "$TMP" "$PACKS_DIR/$NAME"
    echo "$NAME: $(jq -r '.display_name' "$PACKS_DIR/$NAME/openpeon.json")"
done
