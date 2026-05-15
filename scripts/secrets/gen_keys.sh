#!/bin/sh
# gen_keys.sh - Generate age encryption keys
#
# Keys are stored at ~/.keys/age/keys.txt
# The file contains both the secret key and public key.
#
# Usage: ./scripts/secrets/gen_keys.sh

set -e

# Configuration
KEY_DIR="$HOME/.keys/age"
KEY_FILE="$KEY_DIR/keys.txt"

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

# Check if keys already exist
if [ -f "$KEY_FILE" ]; then
    log_info "Keys already exist at: $KEY_FILE"
    echo ""
    echo "Your public key:"
    grep "^age1" "$KEY_FILE" || grep "public key:" "$KEY_FILE" | cut -d' ' -f4
    echo ""
    exit 0
fi

# Create key directory
log_info "Creating key directory: $KEY_DIR"
mkdir -p "$KEY_DIR"

# Generate keys
log_info "Generating age keys..."
age-keygen -o "$KEY_FILE"

# Set secure permissions
chmod 600 "$KEY_FILE"

log_info "Keys generated successfully!"
echo ""
echo "Key file: $KEY_FILE"
echo ""
echo "Your public key (share this with teammates):"
grep "^age1" "$KEY_FILE" || grep "public key:" "$KEY_FILE" | cut -d' ' -f4
echo ""
log_warn "Keep your key file secure and backed up!"
log_warn "If you lose it, you cannot decrypt secrets."
