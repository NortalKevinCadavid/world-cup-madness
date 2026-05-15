#!/bin/sh
# audit.sh - Audit secrets health and status
#
# This script:
# 1. Reports on encryption status of secrets
# 2. Warns about stale encryptions (>30 days old)
# 3. Checks for plaintext files that need encryption
# 4. Validates recipients list
#
# Usage: ./scripts/secrets/audit.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Configuration
PLAIN_DIR="$REPO_ROOT/secrets/plain"
ENC_DIR="$REPO_ROOT/secrets/enc"
RECIPIENTS_FILE="$REPO_ROOT/secrets/recipients.txt"
MANIFEST_FILE="$REPO_ROOT/secrets/manifest.json"
STALE_DAYS=30

# Colors for output
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    GREEN=''
    YELLOW=''
    RED=''
    BLUE=''
    NC=''
fi

log_info() {
    printf "${GREEN}[OK]${NC} %s\n" "$1"
}

log_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

log_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

log_section() {
    printf "\n${BLUE}=== %s ===${NC}\n\n" "$1"
}

# Track issues
WARNINGS=0
ERRORS=0

echo ""
echo "Secrets Audit Report"
echo "===================="
echo "Repository: $REPO_ROOT"
echo "Date: $(date)"

# Section 1: Recipients
log_section "Recipients"

if [ -f "$RECIPIENTS_FILE" ]; then
    RECIPIENT_COUNT=$(grep -c "^age1" "$RECIPIENTS_FILE" 2>/dev/null || echo "0")
    if [ "$RECIPIENT_COUNT" -eq 0 ]; then
        log_error "No recipients configured"
        ERRORS=$((ERRORS + 1))
    else
        log_info "$RECIPIENT_COUNT recipient(s) configured"
        echo ""
        echo "Recipients:"
        grep "^age1" "$RECIPIENTS_FILE" | while read -r key; do
            # Show truncated key for privacy
            echo "  - ${key%????????????????????????????????}..."
        done
    fi
else
    log_error "Recipients file missing: $RECIPIENTS_FILE"
    ERRORS=$((ERRORS + 1))
fi

# Section 2: Plaintext Secrets
log_section "Plaintext Secrets"

PLAIN_COUNT=0
if [ -d "$PLAIN_DIR" ]; then
    for file in "$PLAIN_DIR"/*; do
        [ -f "$file" ] || continue
        [ "$(basename "$file")" = ".gitkeep" ] && continue
        PLAIN_COUNT=$((PLAIN_COUNT + 1))
    done
fi

if [ "$PLAIN_COUNT" -eq 0 ]; then
    log_info "No plaintext secrets present"
else
    log_warn "$PLAIN_COUNT plaintext file(s) present"
    WARNINGS=$((WARNINGS + 1))
    echo ""
    echo "Plaintext files:"
    for file in "$PLAIN_DIR"/*; do
        [ -f "$file" ] || continue
        [ "$(basename "$file")" = ".gitkeep" ] && continue
        echo "  - $(basename "$file")"
    done
    echo ""
    echo "Run ./scripts/secrets/encrypt_all.sh to encrypt these files."
fi

# Section 3: Encrypted Secrets
log_section "Encrypted Secrets"

ENC_COUNT=0
if [ -d "$ENC_DIR" ]; then
    for file in "$ENC_DIR"/*.age; do
        [ -f "$file" ] || continue
        ENC_COUNT=$((ENC_COUNT + 1))
    done
fi

if [ "$ENC_COUNT" -eq 0 ]; then
    log_info "No encrypted secrets present"
else
    log_info "$ENC_COUNT encrypted file(s) present"
    echo ""
    echo "Encrypted files:"
    for file in "$ENC_DIR"/*.age; do
        [ -f "$file" ] || continue
        echo "  - $(basename "$file")"
    done
fi

# Section 4: Staleness Check
log_section "Staleness Check"

if [ -f "$MANIFEST_FILE" ]; then
    # Extract last_encrypted timestamp (simple grep approach)
    LAST_ENCRYPTED=$(grep '"last_encrypted"' "$MANIFEST_FILE" 2>/dev/null | sed 's/.*: *"\([^"]*\)".*/\1/' || echo "")

    if [ -n "$LAST_ENCRYPTED" ]; then
        echo "Last encryption: $LAST_ENCRYPTED"

        # Calculate days since last encryption
        # Note: This is a simple check that works on most systems
        if command -v date >/dev/null 2>&1; then
            # Try to parse the date and calculate age
            CURRENT_EPOCH=$(date +%s 2>/dev/null || echo "0")

            # Parse ISO date (works on macOS and GNU date)
            if [ "$(uname)" = "Darwin" ]; then
                LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_ENCRYPTED" +%s 2>/dev/null || echo "0")
            else
                LAST_EPOCH=$(date -d "$LAST_ENCRYPTED" +%s 2>/dev/null || echo "0")
            fi

            if [ "$LAST_EPOCH" -gt 0 ] && [ "$CURRENT_EPOCH" -gt 0 ]; then
                DAYS_OLD=$(( (CURRENT_EPOCH - LAST_EPOCH) / 86400 ))
                echo "Days since encryption: $DAYS_OLD"

                if [ "$DAYS_OLD" -gt "$STALE_DAYS" ]; then
                    log_warn "Encryption is more than $STALE_DAYS days old"
                    WARNINGS=$((WARNINGS + 1))
                    echo ""
                    echo "Consider re-encrypting if:"
                    echo "  - Recipients have changed"
                    echo "  - Secrets have been modified"
                else
                    log_info "Encryption is current"
                fi
            fi
        fi
    else
        log_warn "Could not determine last encryption date"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    if [ "$ENC_COUNT" -gt 0 ]; then
        log_warn "Manifest file missing but encrypted files exist"
        WARNINGS=$((WARNINGS + 1))
    else
        log_info "No manifest (no secrets encrypted yet)"
    fi
fi

# Section 5: Sync Check
log_section "Sync Check"

# Check for files that exist in plain but not in enc
UNENCRYPTED=""
for file in "$PLAIN_DIR"/*; do
    [ -f "$file" ] || continue
    filename=$(basename "$file")
    [ "$filename" = ".gitkeep" ] && continue

    if [ ! -f "$ENC_DIR/${filename}.age" ]; then
        UNENCRYPTED="$UNENCRYPTED $filename"
    fi
done

if [ -n "$UNENCRYPTED" ]; then
    log_warn "Unencrypted files detected"
    WARNINGS=$((WARNINGS + 1))
    echo "Files needing encryption:"
    for f in $UNENCRYPTED; do
        echo "  - $f"
    done
else
    if [ "$PLAIN_COUNT" -gt 0 ]; then
        log_info "All plaintext files have encrypted versions"
    else
        log_info "No sync issues"
    fi
fi

# Summary
log_section "Summary"

if [ "$ERRORS" -gt 0 ]; then
    log_error "$ERRORS error(s) found"
fi

if [ "$WARNINGS" -gt 0 ]; then
    log_warn "$WARNINGS warning(s) found"
fi

if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
    log_info "All checks passed"
fi

echo ""
exit $ERRORS
