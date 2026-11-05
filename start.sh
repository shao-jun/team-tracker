#!/usr/bin/env bash
# 打开团队工作台。服务由 systemd 托管（team-tracker.service），这里只做健康检查和开浏览器。
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8770}"
URL="http://127.0.0.1:${PORT}"

if curl -s --noproxy '*' -o /dev/null --max-time 2 "${URL}/health"; then
  echo "服务在运行：${URL}"
elif systemctl list-unit-files 2>/dev/null | grep -q '^team-tracker.service'; then
  echo "服务未响应，尝试拉起 systemd 服务…"
  sudo systemctl restart team-tracker
  for i in $(seq 1 20); do
    if curl -s --noproxy '*' -o /dev/null --max-time 1 "${URL}/health"; then break; fi
    sleep 0.3
  done
  echo "已启动：${URL}"
else
  # 没装 systemd 服务的临时用法（开发调试）
  nohup python3 server.py >> server.log 2>&1 &
  for i in $(seq 1 20); do
    if curl -s --noproxy '*' -o /dev/null --max-time 1 "${URL}/health"; then break; fi
    sleep 0.3
  done
  echo "已临时启动（非 systemd）：${URL}"
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 &
fi
