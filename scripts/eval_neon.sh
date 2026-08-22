#!/usr/bin/env bash
# eval_neon.sh — NEON optimization evaluation for pet-album binary
#
# Usage:
#   ./scripts/eval_neon.sh                    # download latest CI artifact + analyze
#   ./scripts/eval_neon.sh /path/to/pet-album # analyze a local binary directly
#
# Outputs:
#   1. Binary size
#   2. NEON instruction count / density per hot function
#   3. Symbol size comparison (score_frame, rgb_to_nv12)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/eval_neon.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── 1. Binary acquisition ─────────────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
    BINARY="$1"
    echo -e "${CYAN}Using local binary: $BINARY${NC}"
else
    echo -e "${CYAN}Downloading latest CI artifact (pet-album-aarch64)...${NC}"
    gh run download --repo dj-oyu/rdk-x5_smart-pet-camera \
        --name pet-album-aarch64 \
        --dir "$WORK_DIR" 2>&1 | tail -3
    BINARY="$WORK_DIR/pet-album"
    chmod +x "$BINARY"
fi

if [[ ! -f "$BINARY" ]]; then
    echo -e "${RED}Error: binary not found at $BINARY${NC}" >&2
    exit 1
fi

# ── 2. Binary size ────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}=== Binary size ===${NC}"
ls -lh "$BINARY" | awk '{print "  Size:", $5, $9}'
file "$BINARY" | sed 's/.*: /  Type: /'

# ── 3. NEON instruction density ───────────────────────────────────────────────
echo ""
echo -e "${YELLOW}=== NEON instruction analysis ===${NC}"

# AArch64 NEON/SIMD opcodes to look for
NEON_PATTERN='fabs[[:space:]]|fcmgt[[:space:]]|fcmge[[:space:]]|fmul[[:space:]]|fmla[[:space:]]|fmls[[:space:]]|fadd[[:space:]]|fsub[[:space:]]|ld1[[:space:]]|ld2[[:space:]]|ld4[[:space:]]|st1[[:space:]]|st2[[:space:]]|dup[[:space:]]|zip1[[:space:]]|zip2[[:space:]]|uzp1[[:space:]]|uzp2[[:space:]]|trn1[[:space:]]|trn2[[:space:]]|addv[[:space:]]|addp[[:space:]]|faddp[[:space:]]|uaddlp[[:space:]]|umull[[:space:]]|smull[[:space:]]|sqrdmulh[[:space:]]|mla[[:space:]]|mls[[:space:]]|sshr[[:space:]]|ushr[[:space:]]|shl[[:space:]]|shrn[[:space:]]|fcvt[[:space:]]|scvtf[[:space:]]|ucvtf[[:space:]]|ins[[:space:]]|ext[[:space:]]'

SCALAR_PATTERN='^[[:space:]]+[0-9a-f]+:[[:space:]]'

analyze_function() {
    local func_pattern="$1"
    local label="$2"

    # Extract the function's disassembly block
    local dump
    dump=$(objdump -d --no-show-raw-insn "$BINARY" 2>/dev/null \
        | awk "/^[0-9a-f]+ <.*${func_pattern}.*>:/{found=1} found{print} found && /^$/{exit}")

    if [[ -z "$dump" ]]; then
        echo -e "  ${label}: ${RED}symbol not found${NC}"
        return
    fi

    local total neon
    total=$(echo "$dump" | grep -cE "$SCALAR_PATTERN" || true)
    neon=$(echo "$dump" | grep -iE "$NEON_PATTERN" | wc -l || true)

    if [[ $total -gt 0 ]]; then
        local pct=$(( neon * 100 / total ))
        if [[ $pct -ge 50 ]]; then
            echo -e "  ${GREEN}${label}${NC}: ${neon}/${total} NEON instructions (${pct}%) ✓"
        elif [[ $pct -ge 20 ]]; then
            echo -e "  ${YELLOW}${label}${NC}: ${neon}/${total} NEON instructions (${pct}%)"
        else
            echo -e "  ${RED}${label}${NC}: ${neon}/${total} NEON instructions (${pct}%) — may not be vectorized"
        fi
    else
        echo -e "  ${label}: (no instructions found — possibly inlined)"
    fi
}

analyze_function "score_frame"   "bg::score_frame"
analyze_function "rgb_to_nv12"   "detect.*rgb_to_nv12"
analyze_function "build_model"   "bg::build_model"

# ── 4. Symbol sizes (nm) ──────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}=== Symbol sizes (nm) ===${NC}"
nm --print-size --size-sort --radix=d "$BINARY" 2>/dev/null \
    | grep -E 'score_frame|rgb_to_nv12|build_model|clahe' \
    | awk '{printf "  %-8s bytes  %s\n", $2, $4}' \
    | sort -rn \
    || echo "  (nm output unavailable)"

# ── 5. Target CPU verification ────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}=== Build attributes ===${NC}"
objdump -s --section=.ARM.attributes "$BINARY" 2>/dev/null | grep -i 'cortex\|neon\|armv' || true
readelf -A "$BINARY" 2>/dev/null | grep -E 'Tag_CPU|Tag_FP|Tag_Advanced' | head -10 || \
    echo "  (readelf not available or no ARM attributes section)"

echo ""
echo -e "${GREEN}Done. Binary: $BINARY${NC}"
