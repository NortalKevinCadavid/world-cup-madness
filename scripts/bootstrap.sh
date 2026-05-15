#!/bin/sh
# bootstrap.sh - One-command setup for new repository clones
#
# This script:
# 1. Checks that age is installed
# 2. Installs git hooks
# 3. Generates encryption keys (if not present)
# 4. Adds your public key to recipients.txt (if not present)
# 5. Regenerates INDEX.md
#
# Usage: ./scripts/bootstrap.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configuration
KEY_FILE="$HOME/.keys/age/keys.txt"
RECIPIENTS_FILE="$REPO_ROOT/secrets/recipients.txt"

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
    printf "${GREEN}[INFO]${NC} %s\n" "$1"
}

log_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

log_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

log_step() {
    printf "${BLUE}[STEP]${NC} %s\n" "$1"
}

# Track actions taken
ACTIONS_TAKEN=""

add_action() {
    if [ -z "$ACTIONS_TAKEN" ]; then
        ACTIONS_TAKEN="$1"
    else
        ACTIONS_TAKEN="$ACTIONS_TAKEN\n$1"
    fi
}

echo "=== Bootstrap Setup ==="
echo ""

# Step 1: Check age is installed
log_step "Checking age installation..."
if ! command -v age >/dev/null 2>&1; then
    log_error "age is not installed."
    echo ""
    echo "Please install age first:"
    echo "  macOS:  brew install age"
    echo "  Linux:  apt install age  (or download from https://github.com/FiloSottile/age/releases)"
    echo ""
    echo "Then run this script again."
    exit 1
fi
log_info "age is installed: $(age --version 2>/dev/null || echo 'version unknown')"

# Step 2: Install git hooks
log_step "Installing git hooks..."
if "$SCRIPT_DIR/install_hooks.sh"; then
    add_action "Installed git hooks"
else
    log_warn "Could not install git hooks (not a git repository?)"
fi

# Step 3: Generate keys if not present
log_step "Checking encryption keys..."
if [ -f "$KEY_FILE" ]; then
    log_info "Keys already exist at: $KEY_FILE"
else
    log_info "Generating new encryption keys..."
    "$SCRIPT_DIR/secrets/gen_keys.sh"
    add_action "Generated new encryption keys"
fi

# Step 4: Add public key to recipients if not present
log_step "Checking recipients list..."

# Extract public key
PUBLIC_KEY=""
if [ -f "$KEY_FILE" ]; then
    # Try to get the public key from the key file
    PUBLIC_KEY=$(grep "^age1" "$KEY_FILE" 2>/dev/null || grep "public key:" "$KEY_FILE" 2>/dev/null | head -1 | sed 's/.*: //')
fi

if [ -z "$PUBLIC_KEY" ]; then
    log_warn "Could not extract public key from $KEY_FILE"
else
    # Check if key is already in recipients
    if [ -f "$RECIPIENTS_FILE" ] && grep -q "$PUBLIC_KEY" "$RECIPIENTS_FILE" 2>/dev/null; then
        log_info "Your public key is already in recipients.txt"
    else
        # Add the key
        log_info "Adding your public key to recipients.txt..."
        echo "" >> "$RECIPIENTS_FILE"
        echo "# Added by bootstrap on $(date +%Y-%m-%d)" >> "$RECIPIENTS_FILE"
        echo "$PUBLIC_KEY" >> "$RECIPIENTS_FILE"
        add_action "Added public key to recipients.txt"
    fi
fi

# Step 5: Regenerate INDEX.md
log_step "Regenerating INDEX.md..."
cd "$REPO_ROOT"
if "$SCRIPT_DIR/index/generate.sh" 2>/dev/null; then
    add_action "Regenerated INDEX.md"
else
    log_warn "Could not regenerate INDEX.md (Python 3 not available?)"
fi

# Print summary
echo ""
echo "=== Bootstrap Complete ==="
echo ""

if [ -n "$ACTIONS_TAKEN" ]; then
    echo "Actions taken:"
    printf "$ACTIONS_TAKEN\n" | while read -r action; do
        [ -n "$action" ] && echo "  - $action"
    done
else
    echo "No changes needed - already set up."
fi

echo ""
echo "Your public key:"
if [ -n "$PUBLIC_KEY" ]; then
    echo "  $PUBLIC_KEY"
else
    echo "  (not available)"
fi
echo ""
echo "Next steps:"
echo "  1. Share your public key with teammates"
echo "  2. Create secrets in secrets/plain/"
echo "  3. Encrypt with: ./scripts/secrets/encrypt_all.sh"
echo ""
