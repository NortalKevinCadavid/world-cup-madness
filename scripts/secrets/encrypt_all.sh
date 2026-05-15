#!/bin/sh
# encrypt_all.sh - Encrypt all plaintext secrets for safe storage
#
# This script:
# 1. Checks that age is installed
# 2. Verifies recipients.txt has at least one recipient
# 3. Encrypts all files in secrets/plain/ (excluding .gitkeep)
# 4. Writes encrypted files to secrets/enc/ with .age extension
# 5. Updates secrets/manifest.json with encryption metadata
#
# Usage: ./scripts/secrets/encrypt_all.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Configuration
PLAIN_DIR="$REPO_ROOT/secrets/plain"
ENC_DIR="$REPO_ROOT/secrets/enc"
RECIPIENTS_FILE="$REPO_ROOT/secrets/recipients.txt"
MANIFEST_FILE="$REPO_ROOT/secrets/manifest.json"

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

# Check recipients file exists and has content
if [ ! -f "$RECIPIENTS_FILE" ]; then
    log_error "Recipients file not found: $RECIPIENTS_FILE"
    echo ""
    echo "Run ./scripts/bootstrap.sh first to set up your environment."
    exit 1
fi

# Count valid recipients (lines starting with age1)
RECIPIENT_COUNT=$(grep -c "^age1" "$RECIPIENTS_FILE" 2>/dev/null || echo "0")

if [ "$RECIPIENT_COUNT" -eq 0 ]; then
    log_error "No recipients found in $RECIPIENTS_FILE"
    echo ""
    echo "Add at least one public key (age1...) to recipients.txt."
    echo "Run ./scripts/bootstrap.sh to add your key automatically."
    exit 1
fi

log_info "Found $RECIPIENT_COUNT recipient(s)"

# Check plain directory exists
if [ ! -d "$PLAIN_DIR" ]; then
    log_error "Plain secrets directory not found: $PLAIN_DIR"
    exit 1
fi

# Ensure enc directory exists
mkdir -p "$ENC_DIR"

# Count files to encrypt
FILE_COUNT=0
for file in "$PLAIN_DIR"/*; do
    [ -f "$file" ] || continue
    [ "$(basename "$file")" = ".gitkeep" ] && continue
    FILE_COUNT=$((FILE_COUNT + 1))
done

if [ "$FILE_COUNT" -eq 0 ]; then
    log_warn "No files to encrypt in $PLAIN_DIR"
    echo ""
    echo "Create secrets in secrets/plain/ then run this script again."
    exit 0
fi

log_info "Encrypting $FILE_COUNT file(s)..."

# Build recipient args
RECIPIENT_ARGS=""
while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    case "$line" in
        ''|'#'*) continue ;;
    esac
    # Only use lines starting with age1
    case "$line" in
        age1*) RECIPIENT_ARGS="$RECIPIENT_ARGS -r $line" ;;
    esac
done < "$RECIPIENTS_FILE"

# Track encrypted files for manifest
ENCRYPTED_FILES=""
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Encrypt each file
for file in "$PLAIN_DIR"/*; do
    [ -f "$file" ] || continue

    filename=$(basename "$file")

    # Skip .gitkeep
    [ "$filename" = ".gitkeep" ] && continue

    output_file="$ENC_DIR/${filename}.age"

    log_info "Encrypting: $filename"

    # Encrypt the file
    # shellcheck disable=SC2086
    age $RECIPIENT_ARGS -o "$output_file" "$file"

    # Track for manifest
    if [ -z "$ENCRYPTED_FILES" ]; then
        ENCRYPTED_FILES="$filename"
    else
        ENCRYPTED_FILES="$ENCRYPTED_FILES,$filename"
    fi
done

# Update manifest
log_info "Updating manifest..."

# Create or update manifest.json
# Using simple approach without jq dependency
cat > "$MANIFEST_FILE" << EOF
{
  "last_encrypted": "$TIMESTAMP",
  "recipients_count": $RECIPIENT_COUNT,
  "files": [
EOF

# Add file entries
FIRST=true
for file in "$PLAIN_DIR"/*; do
    [ -f "$file" ] || continue
    filename=$(basename "$file")
    [ "$filename" = ".gitkeep" ] && continue

    if [ "$FIRST" = true ]; then
        FIRST=false
    else
        echo "," >> "$MANIFEST_FILE"
    fi

    # Get file size
    if [ "$(uname)" = "Darwin" ]; then
        SIZE=$(stat -f%z "$file" 2>/dev/null || echo "0")
    else
        SIZE=$(stat -c%s "$file" 2>/dev/null || echo "0")
    fi

    printf '    {"name": "%s", "encrypted_at": "%s", "size": %s}' "$filename" "$TIMESTAMP" "$SIZE" >> "$MANIFEST_FILE"
done

cat >> "$MANIFEST_FILE" << EOF

  ]
}
EOF

echo ""
echo "=== Encryption Complete ==="
echo ""
echo "Files encrypted: $FILE_COUNT"
echo "Recipients: $RECIPIENT_COUNT"
echo "Output directory: $ENC_DIR"
echo ""
echo "Encrypted files are safe to commit to git."
echo "NEVER commit the plaintext files in secrets/plain/"
echo ""
