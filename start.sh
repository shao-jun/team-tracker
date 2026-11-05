#!/usr/bin/env bash
# 启动团队工作台并打开浏览器
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8770}"
URL="http://127.0.0.1:${PORT}"

if curl -s --noproxy '*' -o /dev/null --max-time 2 "${URL}/health"; then
  echo "已在运行：${URL}"
else
  nohup python3 server.py >> server.log 2>&1 &
  for i in $(seq 1 20); do
    if curl -s --noproxy '*' -o /dev/null --max-time 1 "${URL}/health"; then break; fi
    sleep 0.3
  done
  echo "已启动：${URL}"
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 &
fi
