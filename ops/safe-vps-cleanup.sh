#!/bin/sh
set -eu

MODE="dry-run"
if [ "${1:-}" = "--apply" ]; then
  MODE="apply"
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

REPO="/home/steve/Scripts"
SCRIPT_FILES="$REPO/Script_files"
PROFILE_ROOT="$SCRIPT_FILES/chrome_profiles"
LOG_ROOT="$REPO/logs"

if [ ! -d "$REPO/.git" ]; then
  echo "Refusing cleanup: expected Git repository is missing at $REPO" >&2
  exit 1
fi

echo "mode=$MODE"
echo "--- before ---"
df -h /
docker system df

unhealthy_services="$(
  docker service ls --format '{{.Name}}|{{.Replicas}}' |
    awk -F'|' '
      split($2, count, "/") == 2 && count[1] != count[2] {
        print $1 "=" $2
      }
    '
)"
if [ -n "$unhealthy_services" ]; then
  echo "Refusing cleanup while Docker services are not converged:" >&2
  echo "$unhealthy_services" >&2
  exit 1
fi

is_active_profile() {
  target="$1"
  TARGET_PROFILE="$target" python3 - <<'PY'
import glob
import os
import sys

needle = ("--user-data-dir=" + os.environ["TARGET_PROFILE"]).encode()
for cmdline_path in glob.glob("/proc/[0-9]*/cmdline"):
    try:
        arguments = open(cmdline_path, "rb").read().split(b"\0")
    except OSError:
        continue
    if needle in arguments:
        sys.exit(0)
sys.exit(1)
PY
}

is_tracked_path() {
  target="$1"
  relative="${target#"$REPO"/}"
  [ "$relative" != "$target" ] || return 1
  [ -n "$(git -C "$REPO" ls-files -- "$relative" "$relative/**")" ]
}

remove_candidate() {
  target="$1"
  [ -e "$target" ] || return 0

  case "$target" in
    "$SCRIPT_FILES/chrome_sync_profile"|\
    "$SCRIPT_FILES"/manual_booking_profile_[0-9]*|\
    "$PROFILE_ROOT"/hb_extract_broken_[0-9]*|\
    "$PROFILE_ROOT"/hb_sync_broken_[0-9]*|\
    "$PROFILE_ROOT"/pajak_upload_reset_[0-9]*|\
    "$PROFILE_ROOT"/pajak_upload_manual_reset_[0-9]*|\
    "$LOG_ROOT"/*)
      ;;
    *)
      echo "Refusing unexpected target: $target" >&2
      exit 1
      ;;
  esac

  if is_active_profile "$target"; then
    echo "SKIP active profile: $target"
    return 0
  fi
  if is_tracked_path "$target"; then
    echo "SKIP Git-tracked path: $target"
    return 0
  fi

  size="$(du -sh "$target" 2>/dev/null | awk '{print $1}')"
  echo "CANDIDATE ${size:-unknown}: $target"
  if [ "$MODE" = "apply" ]; then
    rm -rf -- "$target"
    echo "REMOVED: $target"
  fi
}

remove_candidate "$SCRIPT_FILES/chrome_sync_profile"

for target in \
  "$SCRIPT_FILES"/manual_booking_profile_[0-9]* \
  "$PROFILE_ROOT"/hb_extract_broken_[0-9]* \
  "$PROFILE_ROOT"/hb_sync_broken_[0-9]* \
  "$PROFILE_ROOT"/pajak_upload_reset_[0-9]* \
  "$PROFILE_ROOT"/pajak_upload_manual_reset_[0-9]*
do
  remove_candidate "$target"
done

if [ -d "$LOG_ROOT" ]; then
  find "$LOG_ROOT" -xdev -type f -mtime +30 \
    \( -name '*.log.*' -o -name '*.gz' -o -name '*.png' -o -name '*.html' \) \
    -print | while IFS= read -r target; do
      remove_candidate "$target"
    done
fi

if [ "$MODE" = "apply" ]; then
  docker container prune --force
  docker image prune --all --force
fi

echo "--- after ---"
df -h /
docker system df

available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
minimum_kb=$((8 * 1024 * 1024))
if [ "$MODE" = "apply" ] && [ "$available_kb" -lt "$minimum_kb" ]; then
  echo "Insufficient free space after cleanup: require at least 8 GiB" >&2
  exit 1
fi
