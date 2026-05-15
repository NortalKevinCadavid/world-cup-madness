#!/bin/sh
# install_hooks.sh - Configure git to use .githooks/ directory
#
# Usage: ./scripts/install_hooks.sh

set -e

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

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log_error "Not a git repository."
    log_error "Please run 'git init' first."
    exit 1
fi

# Set the hooks path
git config core.hooksPath .githooks

log_info "Git hooks installed successfully."
log_info "Hooks directory: .githooks/"
