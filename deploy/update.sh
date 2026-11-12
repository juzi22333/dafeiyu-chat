#!/usr/bin/env bash
# 拉最新代码并重启。你的部署要能跟着仓库更新，而不是永远停在装的那天。
#   bash deploy/update.sh
# 数据在 data/，不在版本控制里，拉代码不会动用户和聊天记录。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${SERVICE:-dafeiyu-chat}"
cd "$APP_DIR"

echo "== 当前版本 =="
git rev-parse --short HEAD 2>/dev/null || echo "(不是 git 部署)"
curl -s --max-time 5 "http://127.0.0.1:${PORT:-8710}/api/version" || true
echo

echo "== 拉代码 =="
# 本地改过的文件先收起来，拉完再放回去；冲突就留给用户自己看，不要硬覆盖
STASHED=0
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  git stash push -u -m "update.sh 自动暂存 $(date +%Y%m%d-%H%M%S)" >/dev/null && STASHED=1
  echo "本地改动已暂存"
fi
BRANCH="${BRANCH:-master}"
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git pull --ff-only
else
  # 克隆/reset 出来的仓库可能没有 upstream，直接对 origin 的对应分支做快进
  git fetch origin "$BRANCH"
  git merge --ff-only "origin/$BRANCH"
  git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true
fi

if [ "$STASHED" = "1" ]; then
  git stash pop || echo "!! 本地改动和上游冲突了，改动还在 stash 里（git stash list 看）"
fi

echo "== 语法检查 =="
node --check server.js
node --check room.js
[ -f dsh-brain.js ] && node --check dsh-brain.js || true
[ -f room-lite.cjs ] && node --check room-lite.cjs || true

echo "== 重启 =="
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service"; then
  sudo systemctl restart "$SERVICE"
  sleep 2
  systemctl is-active "$SERVICE"
else
  echo "没找到 systemd 服务 ${SERVICE}，请手动重启（例如 pm2 restart / 重新运行 start.sh）"
fi

echo "== 新版本 =="
git rev-parse --short HEAD
curl -s --max-time 5 "http://127.0.0.1:${PORT:-8710}/api/version" || true
echo
echo "完成。设置页底部应该显示新的版本号。"
