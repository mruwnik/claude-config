#!/bin/sh
# Usage: to-png.sh <url-or-path> <out.png>; prints "<width> <height>" of out.png.
set -e
src=$1
out=$2
if [ ! -s "$out" ]; then
  mkdir -p "$(dirname "$out")"
  tmp="$out.src"
  case "$src" in
    http://*|https://*) curl -fsSL --max-time 20 -o "$tmp" "$src" ;;
    *) cp "$src" "$tmp" ;;
  esac
  sips -s format png "$tmp" --out "$out" >/dev/null
  rm -f "$tmp"
fi
sips -g pixelWidth -g pixelHeight "$out" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}'
