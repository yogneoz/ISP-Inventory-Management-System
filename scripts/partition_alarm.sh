#!/usr/bin/env bash
# Journal partition alarm (worklist A2).
#
# `npm run check:partitions` exits 1 when a month in the window has no partition
# or when the DEFAULT catch-all holds rows, but on 2026-11-17 it had NO automatic
# caller: `grep -c check:partitions .github/workflows/ci.yml` was 0, so a dirty
# DEFAULT or a window that fell behind stayed invisible until an operator read a
# boot log.
#
# This script is the alarm, and it proves itself on every run:
#
#   1. provision — bring the window up on the target database (`--apply`);
#   2. alarm     — the read-only check must exit 0; any gap fails the job;
#   3. negative  — the same check on a deliberately stale window must exit
#                  non-zero AND name the month. If it ever passes, this script
#                  fails, so the alarm can never become a silent-pass.
#
# No `|| true`, no `continue-on-error`, no `set +e` around the alarm itself.
#
# Usage:  bash scripts/partition_alarm.sh
# Env:    DATABASE_URL          target database (required)
#         PARTITION_ALARM_STALE_FROM  reference date for the negative control
#                                 (default 2020-01-01, a window no install has)
set -euo pipefail

cd "$(dirname "$0")/.."

STALE_FROM="${PARTITION_ALARM_STALE_FROM:-2020-01-01}"
STALE_MONTH="${STALE_FROM:0:4}${STALE_FROM:5:2}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "partition_alarm: DATABASE_URL is not set — refusing to guess a database." >&2
  exit 2
fi

TIMEOUT=()
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout 180)
fi

echo "== 1/3 provisioning the window (idempotent) =="
"${TIMEOUT[@]}" npx tsx scripts/check_partitions.ts --apply

echo
echo "== 2/3 alarm: the window must be complete and DEFAULT must be empty =="
"${TIMEOUT[@]}" npx tsx scripts/check_partitions.ts

echo
echo "== 3/3 negative control: a stale window (from ${STALE_FROM}) must fail and name ${STALE_MONTH} =="
set +e
STALE_OUTPUT=$("${TIMEOUT[@]}" npx tsx scripts/check_partitions.ts --from "${STALE_FROM}" 2>&1)
STALE_CODE=$?
set -e
echo "${STALE_OUTPUT}"

if [ "${STALE_CODE}" -eq 0 ]; then
  echo "partition_alarm: FAILED — the check exited 0 on a window that cannot exist (${STALE_FROM})." >&2
  echo "partition_alarm: the alarm is not wired to the window, so a real gap could pass silently." >&2
  exit 1
fi
if ! printf '%s' "${STALE_OUTPUT}" | grep -q "${STALE_MONTH}"; then
  echo "partition_alarm: FAILED — the check exited ${STALE_CODE} but never named the stale month ${STALE_MONTH}." >&2
  exit 1
fi

echo
echo "partition_alarm: PASS — window healthy, and the alarm fails with ${STALE_MONTH} named when it is not."
