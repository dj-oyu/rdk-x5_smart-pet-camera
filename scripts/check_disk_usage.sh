#!/usr/bin/env bash
set -euo pipefail

# Warn before a filesystem the camera depends on fills up.
#
# Why this exists: a diagnostic log grew unbounded to 893 MB and exhausted the
# 2 GB /tmp tmpfs. Nothing noticed. The daemon had also been writing into a
# deleted inode, so the space was held without any file being visible — `du`
# showed 206 MB while `df` showed 1.2 GB used. That gap is checked here too,
# because it is invisible to a plain size check.
#
# Runs from pet-camera-disk-check.timer. Findings go to the journal at warning
# level, so `journalctl -p warning` surfaces them.

THRESHOLD_PCT="${DISK_WARN_PERCENT:-80}"
# Space held by files that have been unlinked but are still open. Anything past
# this means a process is writing somewhere nobody can see.
DELETED_WARN_MB="${DISK_DELETED_WARN_MB:-100}"

status=0

check_usage() {
  local mount="$1"
  [ -d "$mount" ] || return 0

  local used_pct avail_mb
  used_pct=$(df --output=pcent "$mount" | tail -1 | tr -dc '0-9')
  avail_mb=$(df -m --output=avail "$mount" | tail -1 | tr -dc '0-9')

  if [ "${used_pct:-0}" -ge "$THRESHOLD_PCT" ]; then
    echo "[disk-check] WARNING ${mount} is ${used_pct}% full (${avail_mb} MB free)" >&2
    df -h "$mount" | tail -1 >&2
    status=1
  else
    echo "[disk-check] ${mount}: ${used_pct}% used, ${avail_mb} MB free"
  fi
}

check_deleted_but_open() {
  local mount="$1"
  [ -d "$mount" ] || return 0

  # Sum the sizes of deleted-but-open files under this mount.
  #
  # The size must be read through /proc/PID/fd/N, not through the path the link
  # points at: that path no longer exists, which is the whole point. Statting
  # the stale path silently yields nothing and the check never fires.
  #
  # Needs root to see other processes' descriptors; without it the scan simply
  # finds less.
  # A readlink per descriptor costs a process each; on this device that was
  # 9 s of CPU for an hourly check. One `ls -l` per PID lists every link target
  # in a single pass, and only the matches are then statted.
  #
  # `|| true` matters: grep exits non-zero when a PID holds no matching
  # descriptor, which is the normal case, and `set -e` would abort the scan.
  local total_mb
  total_mb=$(
    {
      for fddir in /proc/[0-9]*/fd; do
        ls -l "$fddir" 2>/dev/null |
          grep -a -- " -> ${mount}/.* (deleted)$" |
          sed "s|.* \([0-9][0-9]*\) -> .*|${fddir}/\1|" || true
      done
    } | sort -u | while read -r fd; do
      stat -Lc %s "$fd" 2>/dev/null || true
    done | awk '{s+=$1} END {printf "%d", s/1024/1024}'
  ) || true
  total_mb=${total_mb:-0}

  if [ "$total_mb" -ge "$DELETED_WARN_MB" ]; then
    echo "[disk-check] WARNING ${total_mb} MB on ${mount} is held by deleted-but-open files" >&2
    echo "[disk-check] a process is writing to a file that no longer has a name;" >&2
    echo "[disk-check] the space is only released when it exits or reopens" >&2
    status=1
  else
    echo "[disk-check] ${mount}: ${total_mb} MB held by deleted-but-open files"
  fi
}

for mount in /tmp /mnt/petcam-data /; do
  check_usage "$mount"
done
check_deleted_but_open /tmp

exit "$status"
