#!/bin/sh
# generate.sh - Wrapper for Python INDEX.md generator
#
# Usage: ./scripts/index/generate.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    NC='\033[0m'
else
    GREEN=''
    RED=''
    NC=''
fi

log_info() {
    printf "${GREEN}[INFO]${NC} %s\n" "$1"
}

log_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

# Check if Python 3 is available
if ! command -v python3 >/dev/null 2>&1; then
    log_error "Python 3 is not installed."
    echo ""
    echo "Please install Python 3:"
    echo "  macOS:  brew install python"
    echo "  Linux:  apt install python3"
    echo ""
    exit 1
fi

# Run the Python generator
cd "$REPO_ROOT"
python3 "$SCRIPT_DIR/generate_index.py"

log_info "INDEX.md updated successfully."
