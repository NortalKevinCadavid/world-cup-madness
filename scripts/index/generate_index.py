#!/usr/bin/env python3
"""
generate_index.py - Generate deterministic INDEX.md with repository file map.

This script:
1. Reads existing INDEX.md if present
2. Preserves content outside GENERATED:START/END markers
3. Walks directory tree (excluding certain directories)
4. Generates sorted file tree in markdown format
5. Writes updated INDEX.md

Usage: python3 scripts/index/generate_index.py
"""

import os
from pathlib import Path

# Directories to exclude from the tree
EXCLUDE_DIRS = {
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    '.idea',
    '.vscode',
    'secrets/plain',  # Never show plaintext secrets
}

# Files to exclude from the tree
EXCLUDE_FILES = {
    '.DS_Store',
    'Thumbs.db',
    '*.pyc',
}

# Markers for generated content
MARKER_START = "<!-- GENERATED:START -->"
MARKER_END = "<!-- GENERATED:END -->"


def should_exclude_dir(path: Path, root: Path) -> bool:
    """Check if a directory should be excluded."""
    rel_path = str(path.relative_to(root))

    # Check exact matches and prefix matches
    for exclude in EXCLUDE_DIRS:
        if rel_path == exclude or rel_path.startswith(exclude + '/'):
            return True
        if path.name == exclude:
            return True

    return False


def should_exclude_file(path: Path) -> bool:
    """Check if a file should be excluded."""
    name = path.name

    for pattern in EXCLUDE_FILES:
        if pattern.startswith('*'):
            if name.endswith(pattern[1:]):
                return True
        elif name == pattern:
            return True

    return False


def generate_tree(root: Path) -> str:
    """Generate a directory tree as a string."""
    lines = []

    def walk_dir(current: Path, prefix: str = "", is_last: bool = True):
        """Recursively walk directory and build tree."""
        # Get sorted entries
        try:
            entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return

        # Filter entries
        entries = [
            e for e in entries
            if not (e.is_dir() and should_exclude_dir(e, root))
            and not (e.is_file() and should_exclude_file(e))
        ]

        for i, entry in enumerate(entries):
            is_last_entry = (i == len(entries) - 1)

            # Choose connector
            connector = "└── " if is_last_entry else "├── "

            # Add entry
            if entry.is_dir():
                lines.append(f"{prefix}{connector}{entry.name}/")
                # Recurse with updated prefix
                extension = "    " if is_last_entry else "│   "
                walk_dir(entry, prefix + extension, is_last_entry)
            else:
                lines.append(f"{prefix}{connector}{entry.name}")

    lines.append(".")
    walk_dir(root)

    return "\n".join(lines)


def read_existing_index(index_path: Path) -> tuple:
    """Read existing INDEX.md and extract sections."""
    if not index_path.exists():
        return "", ""

    content = index_path.read_text()

    # Find marker positions
    start_pos = content.find(MARKER_START)
    end_pos = content.find(MARKER_END)

    if start_pos == -1 or end_pos == -1:
        # No markers found, return all as header
        return content.strip(), ""

    # Extract sections
    header = content[:start_pos].strip()
    footer = content[end_pos + len(MARKER_END):].strip()

    return header, footer


def generate_index():
    """Main function to generate INDEX.md."""
    # Get repository root (where this script is run from)
    repo_root = Path.cwd()
    index_path = repo_root / "INDEX.md"

    # Read existing content
    header, footer = read_existing_index(index_path)

    # Generate tree
    tree = generate_tree(repo_root)

    # Build new content
    if not header:
        header = """# Project Index

This file provides an overview of the repository structure.

## Quick Links

- [README.md](README.md) - Project overview and setup
- [CLAUDE_START.md](CLAUDE_START.md) - Claude Code getting started
- [docs/secrets-guide.md](docs/secrets-guide.md) - Secrets management guide"""

    generated_section = f"""{MARKER_START}
## Repository Map

```
{tree}
```
{MARKER_END}"""

    # Combine sections
    parts = [header, "", generated_section]
    if footer:
        parts.append("")
        parts.append(footer)

    new_content = "\n".join(parts) + "\n"

    # Write the file
    index_path.write_text(new_content)

    print(f"Generated INDEX.md with {tree.count(chr(10)) + 1} entries")


if __name__ == "__main__":
    generate_index()
