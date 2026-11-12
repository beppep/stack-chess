#!/bin/sh
# Builds the native command line (build/sc) with gcc or cc, and build/sc.wasm with clang if it is installed.
# Run from anywhere: sh engine/build.sh
cd "$(dirname "$0")" || exit 1
mkdir -p build
CC=${CC:-gcc}
$CC -O3 -Wall -Wextra -o build/sc sc_cli.c sc_rules.c sc_search.c sc_nn.c -lm || exit 1
echo "built build/sc"

CLANG=${CLANG:-clang}
if ! command -v "$CLANG" >/dev/null 2>&1 && [ -x "/c/Program Files/LLVM/bin/clang.exe" ]; then CLANG="/c/Program Files/LLVM/bin/clang.exe"; fi
if command -v "$CLANG" >/dev/null 2>&1 || [ -x "$CLANG" ]; then
  # No libc: sc_wasm.c supplies memcpy/memset. The position table is static data (about 32 MB).
  "$CLANG" --target=wasm32 -O2 -nostdlib -fno-builtin -mbulk-memory \
    -Wl,--no-entry -Wl,--export-dynamic -Wl,-z,stack-size=1048576 \
    -o build/sc.wasm sc_wasm.c sc_rules.c sc_search.c sc_nn.c || exit 1
  echo "built build/sc.wasm"
else
  echo "clang not found: skipped build/sc.wasm"
fi
