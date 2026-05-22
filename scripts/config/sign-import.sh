#!/usr/bin/env bash
# =============================================================================
# sign-import.sh — Sign a configuration import envelope (T057 / Slice 008)
# =============================================================================
#
# Computes an HMAC-SHA256 signature over the JSON envelope body (sans the
# 'signature' field) and writes a signed envelope to stdout, --out, or
# in-place. Used when an admin edits an exported envelope before re-importing
# via admin_config_import (T053).
#
# References:
#   - T057           This script.
#   - T052           supabase/migrations/0077_configuration.sql admin_config_export
#   - T053           supabase/migrations/0077_configuration.sql admin_config_import
#   - D-T052-A       The export/import RPCs sign over (envelope - 'signature')::text
#                    in Postgres jsonb form (keys-sorted, compact). This script
#                    uses `jq -c -S` to approximate that canonical form.
#
# CANONICAL-FORM CAVEATS (D-T052-A divergence risks):
#   1. Numeric formatting. Postgres jsonb normalises numbers to its own
#      string form (e.g. trailing zeros stripped, scientific notation
#      sometimes preferred for very large/small values). jq preserves the
#      lexical form from the source file. If your envelope contains numbers
#      like 1.0e10 or 0.000001, jq output may not byte-match Postgres
#      output and the import will fail WCG08. Workaround: round-trip the
#      value through Postgres (export, then sign) so both sides agree on
#      the canonical form.
#   2. Unicode escape sequences. Postgres jsonb un-escapes \uXXXX sequences
#      for non-control characters in ::text; jq preserves them. If your
#      envelope contains é etc., re-export from Postgres before signing.
#   3. Duplicate keys. jq retains the LAST occurrence per JSON spec.
#      Postgres jsonb on input also retains the last. Generally aligned.
#
# Required tools:
#   - jq        (>= 1.6 — needs -S / --sort-keys and -c / --compact-output)
#   - openssl   (>= 1.1 — for `dgst -sha256 -hmac`)
#   Missing tools exit 69 (EX_UNAVAILABLE).
#
# Usage examples:
#   # Basic: sign in place (overwrites input file)
#   ./scripts/config/sign-import.sh --in config.json --secret "$SECRET" --in-place
#
#   # Promote a dev export to prod (re-stamp environment + re-sign):
#   ./scripts/config/sign-import.sh \
#     --in dev-export.json \
#     --env prod \
#     --secret "$PROD_SECRET" \
#     --out prod-import.json
#
#   # From stdin (envelope on stdin, secret via --secret-stdin from FD-1):
#   cat dev-export.json \
#     | ./scripts/config/sign-import.sh --in - --secret-stdin --env prod < secret.txt
#
#   # Positional file form:
#   ./scripts/config/sign-import.sh config.json --secret "$SECRET" --out signed.json
#
# Security notes:
#   * --secret <value> exposes the secret in argv (visible via `ps`). For
#     production usage prefer --secret-stdin and feed the secret on stdin.
#   * The secret value MUST match Postgres GUC `app.config_export_secret`.
#
# Exit codes (sysexits.h conventions):
#   0   success
#   64  usage error          (bad/missing CLI flags)
#   65  bad input data       (envelope is not valid JSON)
#   66  input file missing   (file not found / unreadable)
#   69  tool unavailable     (jq or openssl not on PATH)
#   74  IO error             (write failed, subcommand exited non-zero)
# =============================================================================

set -euo pipefail
IFS=$' \t\n'

# -----------------------------------------------------------------------------
# Logging + exit helpers
# -----------------------------------------------------------------------------
PROG="sign-import.sh"

log_err() {
  # printf, not echo -e — POSIX-portable; safe on macOS bash 3.2.
  printf '%s: error: %s\n' "$PROG" "$*" 1>&2
}

die_usage() {
  log_err "$*"
  print_usage 1>&2
  exit 64
}

die_data() {
  log_err "$*"
  exit 65
}

die_noinput() {
  log_err "$*"
  exit 66
}

die_unavailable() {
  log_err "$*"
  exit 69
}

die_io() {
  log_err "$*"
  exit 74
}

print_usage() {
  cat <<'USAGE'
Usage:
  sign-import.sh [--in <path> | <path>] [--env <name>]
                 (--secret <value> | --secret-stdin)
                 [--out <path> | --in-place | -i]
                 [--help | -h]

Signs a configuration import envelope with HMAC-SHA256. Writes the signed
envelope to stdout (default), --out, or --in-place.

Flags:
  --in <path>       Input envelope file. Use '-' to read from stdin.
                    Alternative to positional <path>.
  <path>            Positional input envelope file.
  --env <name>      Stamp this value into envelope.environment before signing.
                    Useful when promoting a dev export to prod.
  --secret <value>  HMAC secret (matches Postgres app.config_export_secret).
                    WARNING: visible in argv. Prefer --secret-stdin.
  --secret-stdin    Read the secret from stdin (single line). When combined
                    with --in -, stdin must provide the secret on the FIRST
                    line and the envelope after; use file redirection
                    (< secret.txt) instead.
  --out <path>      Write signed envelope to this path (atomic via temp file).
  --in-place, -i    Rewrite input file in place. Requires --in <path> (not -).
                    Mutually exclusive with --out.
  --help, -h        Show this help and exit 0.

Exit codes: 0 ok, 64 usage, 65 bad json, 66 file missing, 69 missing tool,
            74 IO error.
USAGE
}

# -----------------------------------------------------------------------------
# CLI parsing — manual loop, no GNU getopt (portable to macOS bash 3.2).
# -----------------------------------------------------------------------------
IN_PATH=""
ENV_NAME=""
SECRET=""
SECRET_FROM_STDIN=0
OUT_PATH=""
IN_PLACE=0
POSITIONAL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --in)
      [ "$#" -ge 2 ] || die_usage "--in requires an argument"
      IN_PATH="$2"
      shift 2
      ;;
    --env)
      [ "$#" -ge 2 ] || die_usage "--env requires an argument"
      ENV_NAME="$2"
      shift 2
      ;;
    --secret)
      [ "$#" -ge 2 ] || die_usage "--secret requires an argument"
      SECRET="$2"
      shift 2
      ;;
    --secret-stdin)
      SECRET_FROM_STDIN=1
      shift 1
      ;;
    --out)
      [ "$#" -ge 2 ] || die_usage "--out requires an argument"
      OUT_PATH="$2"
      shift 2
      ;;
    --in-place|-i)
      IN_PLACE=1
      shift 1
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift 1
      break
      ;;
    -*)
      die_usage "unknown flag: $1"
      ;;
    *)
      if [ -z "$POSITIONAL" ]; then
        POSITIONAL="$1"
        shift 1
      else
        die_usage "unexpected positional argument: $1"
      fi
      ;;
  esac
done

# Reconcile --in vs positional.
if [ -n "$POSITIONAL" ] && [ -n "$IN_PATH" ]; then
  die_usage "specify --in OR a positional path, not both"
fi
if [ -z "$IN_PATH" ] && [ -n "$POSITIONAL" ]; then
  IN_PATH="$POSITIONAL"
fi
if [ -z "$IN_PATH" ]; then
  die_usage "input envelope path is required (--in <path>, '-', or positional)"
fi

# Secret requirement.
if [ "$SECRET_FROM_STDIN" -eq 1 ] && [ -n "$SECRET" ]; then
  die_usage "--secret and --secret-stdin are mutually exclusive"
fi
if [ "$SECRET_FROM_STDIN" -eq 0 ] && [ -z "$SECRET" ]; then
  die_usage "--secret <value> or --secret-stdin is required"
fi

# Output destination reconciliation.
if [ "$IN_PLACE" -eq 1 ] && [ -n "$OUT_PATH" ]; then
  die_usage "--in-place and --out are mutually exclusive"
fi
if [ "$IN_PLACE" -eq 1 ] && [ "$IN_PATH" = "-" ]; then
  die_usage "--in-place cannot be used with stdin input"
fi

# -----------------------------------------------------------------------------
# Tool availability check (EX_UNAVAILABLE).
# -----------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 \
  || die_unavailable "jq is required (>= 1.6) but not on PATH"
command -v openssl >/dev/null 2>&1 \
  || die_unavailable "openssl is required (>= 1.1) but not on PATH"

# -----------------------------------------------------------------------------
# Temp file management (POSIX-portable; cleaned on exit).
# -----------------------------------------------------------------------------
TMPDIR_BASE="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "$TMPDIR_BASE/sign-import.XXXXXX")" \
  || die_io "failed to create working directory"

cleanup() {
  # Best-effort wipe of any secret material on disk.
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

ENVELOPE_FILE="$WORK_DIR/envelope.json"
BODY_FILE="$WORK_DIR/body.canonical"
SIGNED_FILE="$WORK_DIR/signed.json"

# -----------------------------------------------------------------------------
# Read the input envelope.
# -----------------------------------------------------------------------------
if [ "$IN_PATH" = "-" ]; then
  # Read envelope from stdin. Note: incompatible with --secret-stdin
  # unless the user provides the secret via FD redirection (< secret.txt
  # below the pipeline) — call this out:
  if [ "$SECRET_FROM_STDIN" -eq 1 ]; then
    # When both --in - and --secret-stdin are present, the secret is read
    # FIRST line from stdin, then the rest of stdin is the envelope.
    if ! IFS= read -r SECRET; then
      die_usage "failed to read secret from stdin (first line)"
    fi
    if [ -z "$SECRET" ]; then
      die_usage "secret read from stdin is empty"
    fi
  fi
  cat > "$ENVELOPE_FILE" \
    || die_io "failed to read envelope from stdin"
else
  if [ ! -f "$IN_PATH" ]; then
    die_noinput "input file not found: $IN_PATH"
  fi
  if [ ! -r "$IN_PATH" ]; then
    die_noinput "input file not readable: $IN_PATH"
  fi
  cp -- "$IN_PATH" "$ENVELOPE_FILE" \
    || die_io "failed to copy input envelope to working directory"
fi

# If --secret-stdin and we did NOT consume it above, read it now from FD 0.
if [ "$SECRET_FROM_STDIN" -eq 1 ] && [ "$IN_PATH" != "-" ]; then
  if ! IFS= read -r SECRET; then
    die_usage "failed to read secret from stdin"
  fi
  if [ -z "$SECRET" ]; then
    die_usage "secret read from stdin is empty"
  fi
fi

# -----------------------------------------------------------------------------
# Validate JSON, optionally re-stamp environment.
# -----------------------------------------------------------------------------
if ! jq -e . "$ENVELOPE_FILE" >/dev/null 2>&1; then
  die_data "input is not valid JSON: $IN_PATH"
fi

if [ -n "$ENV_NAME" ]; then
  # Re-stamp .environment (the body that gets hashed must reflect this).
  if ! jq --arg env "$ENV_NAME" '.environment = $env' \
        "$ENVELOPE_FILE" > "$ENVELOPE_FILE.new"; then
    die_io "failed to stamp --env into envelope"
  fi
  mv -- "$ENVELOPE_FILE.new" "$ENVELOPE_FILE" \
    || die_io "failed to replace envelope with --env-stamped copy"
fi

# -----------------------------------------------------------------------------
# Compute canonical body (sans signature) and HMAC-SHA256.
# -----------------------------------------------------------------------------
# `-c` compact (no whitespace), `-S` sort keys.
# del(.signature) removes the existing signature so the HMAC is computed over
# the body alone — matching `(envelope - 'signature')::text` in Postgres.
if ! jq -c -S '. | del(.signature)' "$ENVELOPE_FILE" > "$BODY_FILE"; then
  die_io "failed to produce canonical body via jq"
fi

# openssl dgst -hmac requires the key on the command line; this is an
# unavoidable exposure on multi-user shells. The script's --secret-stdin
# flag is preferred for production use. We still pass it via -hmac because
# OpenSSL does not provide a stdin path for the HMAC key directly in dgst.
SIG="$(openssl dgst -sha256 -hmac "$SECRET" -hex < "$BODY_FILE" 2>/dev/null \
       | awk '{print $NF}')" \
  || die_io "openssl dgst failed"

# Defensive: ensure the digest is a 64-char hex string.
case "$SIG" in
  ''|*[!0-9a-fA-F]*) die_io "openssl produced an unexpected digest: $SIG" ;;
  *) ;;
esac
SIG_LEN=${#SIG}
if [ "$SIG_LEN" -ne 64 ]; then
  die_io "openssl digest length $SIG_LEN (expected 64 hex chars)"
fi

# -----------------------------------------------------------------------------
# Attach signature to envelope.
# -----------------------------------------------------------------------------
if ! jq --arg sig "$SIG" '.signature = $sig' "$ENVELOPE_FILE" > "$SIGNED_FILE"; then
  die_io "failed to attach signature to envelope"
fi

# -----------------------------------------------------------------------------
# Emit the signed envelope.
# -----------------------------------------------------------------------------
if [ "$IN_PLACE" -eq 1 ]; then
  # In-place: atomic rename if same filesystem; cp+rm fallback otherwise.
  if mv -- "$SIGNED_FILE" "$IN_PATH" 2>/dev/null; then
    :
  else
    cp -- "$SIGNED_FILE" "$IN_PATH" \
      || die_io "failed to rewrite $IN_PATH in place"
  fi
elif [ -n "$OUT_PATH" ]; then
  # Write to --out (atomic if on the same fs).
  if mv -- "$SIGNED_FILE" "$OUT_PATH" 2>/dev/null; then
    :
  else
    cp -- "$SIGNED_FILE" "$OUT_PATH" \
      || die_io "failed to write $OUT_PATH"
  fi
else
  # stdout
  cat -- "$SIGNED_FILE" \
    || die_io "failed to write signed envelope to stdout"
fi

exit 0
