#!/usr/bin/env bash
# 每天 0 点备份 data/，只保留最近一份（前一天的），更早的自动清掉。
# 手动跑：bash deploy/backup.sh
# 改保留份数：BACKUP_KEEP=3 bash deploy/backup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$APP_DIR/data"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${BACKUP_KEEP:-1}"
STAMP="$(date +%Y-%m-%d)"
TARGET="$BACKUP_DIR/dafeiyu-data-$STAMP.tar.gz"

[ -d "$DATA_DIR" ] || { echo "[backup] 没有 data 目录：$DATA_DIR" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

# 打包 data/：排除日志和旧的手工备份，别把几十 MB 日志塞进去
tar -czf "$TARGET.tmp" -C "$APP_DIR" \
  --exclude='data/*.log' \
  --exclude='data/db.json.bak*' \
  --exclude='data/room-dsh' \
  data
mv -f "$TARGET.tmp" "$TARGET"
echo "[backup] $(date '+%F %T') 已生成 $TARGET ($(du -h "$TARGET" | cut -f1))"

# 只留最近 KEEP 份
ls -1t "$BACKUP_DIR"/dafeiyu-data-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "[backup] 清掉旧备份 $(basename "$old")"
done
