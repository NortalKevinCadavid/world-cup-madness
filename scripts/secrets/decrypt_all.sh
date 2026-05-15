#!/bin/sh
# decrypt_all.sh - Decrypt all encrypted secrets to plaintext
#
# This script:
# 1. Checks that age is installed
# 2. Verifies key file exists at ~/.keys/age/keys.txt
# 3. Decrypts all .age files in secrets/enc/
# 4. Writes plaintext to secrets/plain/
#
# Usage: ./scripts/secrets/decrypt_all.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Configuration
PLAIN_DIR="$REPO_ROOT/secrets/plain"
ENC_DIR="$REPO_ROOT/secrets/enc"
KEY_FILE="$HOME/.keys/age/keys.txt"

# Colors for output
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    NC='\033[0m'
else
    GREEN=''
    YELLOW=''
    RED=''
    NC=''
fi

log_info() {
    printf "${GREEN}[INFO]${NC} %s\n" "$1"
}

log_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

log_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

# Check if age is installed
if ! command -v age >/dev/null 2>&1; then
    log_error "age is not installed."
    echo ""
    echo "Please install age:"
    echo "  macOS:  brew install age"
    echo "  Linux:  apt install age  (or download from https://github.com/FiloSottile/age/releases)"
    echo ""
    exit 1
fi

# Check key file exists
if [ ! -f "$KEY_FILE" ]; then
    log_error "Key file not found: $KEY_FILE"
    echo ""
    echo "Your age private key is required to decrypt secrets."
    echo ""
    echo "If you have a key, ensure it's at: $KEY_FILE"
    echo "If you need to generate a key, run: ./scripts/bootstrap.sh"
    echo ""
    echo "Note: You can only decrypt secrets if you were a recipient"
    echo "when the secrets were encrypted."
    exit 1
fi

# Check enc directory exists
if [ ! -d "$ENC_DIR" ]; then
    log_error "Encrypted secrets directory not found: $ENC_DIR"
    exit 1
fi

# Ensure plain directory exists
mkdir -p "$PLAIN_DIR"

# Count files to decrypt
FILE_COUNT=0
for file in "$ENC_DIR"/*.age; do
    [ -f "$file" ] || continue
    FILE_COUNT=$((FILE_COUNT + 1))
done

if [ "$FILE_COUNT" -eq 0 ]; then
    log_warn "No encrypted files found in $ENC_DIR"
    echo ""
    echo "Encrypted files should have the .age extension."
    exit 0
fi

log_info "Decrypting $FILE_COUNT file(s)..."

# Track results
SUCCESS_COUNT=0
FAIL_COUNT=0

# Decrypt each file
for file in "$ENC_DIR"/*.age; do
    [ -f "$file" ] || continue

    filename=$(basename "$file" .age)
    output_file="$PLAIN_DIR/$filename"

    log_info "Decrypting: $filename"

    # Decrypt the file
    if age -d -i "$KEY_FILE" -o "$output_file" "$file" 2>/dev/null; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
        log_error "Failed to decrypt: $filename"
        log_error "You may not be a recipient for this file."
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
done

echo ""
echo "=== Decryption Complete ==="
echo ""
echo "Successfully decrypted: $SUCCESS_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "Failed to decrypt: $FAIL_COUNT"
    echo ""
    echo "Decryption failures occur when your key was not in the"
    echo "recipients list when the file was encrypted."
fi
echo ""
echo "Output directory: $PLAIN_DIR"
echo ""
echo "IMPORTANT: Files in secrets/plain/ are gitignored."
echo "Never manually add them to git!"
echo ""
