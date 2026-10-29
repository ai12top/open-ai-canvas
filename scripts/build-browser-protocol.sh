#!/bin/sh
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$root/web/public/browser-protocol}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cd "$root/backend"

go="${GO:-go}"
module_version="$(awk '$1 == "go" { print $2; exit }' go.mod)"
# Pin the module toolchain even when an outer workspace selects a newer Go.
# Docker's matching Go image may set GOTOOLCHAIN=local to avoid downloading.
export GOTOOLCHAIN="${GOTOOLCHAIN:-go$module_version}"
version="$("$go" env GOVERSION)"
case "$version" in
  "go${module_version%.*}."*) ;;
  *)
    printf 'browser protocol requires Go %s.x from backend/go.mod; got %s\n' "${module_version%.*}" "$version" >&2
    exit 1
    ;;
esac

goroot="$("$go" env GOROOT)"
wasm_exec="$goroot/lib/wasm/wasm_exec.js"
if [ ! -f "$wasm_exec" ]; then
  wasm_exec="$goroot/misc/wasm/wasm_exec.js"
fi
GOOS=js GOARCH=wasm "$go" build -trimpath -ldflags='-s -w' -o "$output/protocol.wasm" ./cmd/browser-protocol
# Toolchain downloads live in a read-only module cache; keep rebuilds writable.
cp -f "$wasm_exec" "$output/wasm_exec.js"
chmod 644 "$output/wasm_exec.js"
printf 'Browser protocol built with %s: %s\n' "$version" "$output"
