#!/usr/bin/env bash
# 重启 HTTP 桥。用脚本而不是一行 pkill，是因为 pkill -f 会连带匹配到调用它的那层 shell。
#
# 起完桥还要做一件事：桥重启后 SSH 会话是空的，status 会回 mode=unknown。
# 不自动补这一步的话，下一次走查会在 unknown 态下跑完，演示时才发现没连上台架。
# 所以这里起桥之后主动调一次 connect 工具，并把结果如实打出来：
# live 表示真连上台架，mock 表示连不上、回的是合成数据，unknown 表示连都没试成。
# 传 --no-connect 可跳过这一步。
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE=.bridge.pid
if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  kill "$(cat $PIDFILE)"; sleep 2
fi
set -a; . ./.env; set +a
setsid nohup .venv/bin/python bridge.py > evidence/bridge.log 2>&1 < /dev/null &
echo $! > $PIDFILE
sleep 5
BASE="http://127.0.0.1:${BRIDGE_PORT:-8031}"
curl -fsS "$BASE/health" && echo

if [[ "${1:-}" == "--no-connect" ]]; then
  echo "[bridge] 已跳过自动 connect，status 里的 mode 会是 unknown。"
  echo "[bridge] 需要连台架时执行：curl -fsS -X POST $BASE/devices/bench/tools/connect -H \"x-bridge-token: \$BRIDGE_TOKEN\" -H 'content-type: application/json' -d '{\"arguments\":{}}'"
  exit 0
fi

echo "[bridge] 正在重建到台架的 SSH 会话（connect 不是红线动作，不需要凭据）…"
CONNECT=$(curl -fsS -X POST "$BASE/devices/bench/tools/connect" \
  -H "x-bridge-token: ${BRIDGE_TOKEN}" -H 'content-type: application/json' \
  -d '{"arguments":{}}' || echo '{"mode":"unknown","error":"connect 调用本身失败"}')
MODE=$(printf '%s' "$CONNECT" | .venv/bin/python -c 'import json,sys;print(json.load(sys.stdin).get("mode","unknown"))' 2>/dev/null || echo unknown)
echo "[bridge] connect 返回 mode=$MODE"
case "$MODE" in
  live) echo "[bridge] 已真连上台架，status 会报 live。" ;;
  mock) echo "[bridge] 连不上台架，桥进入 mock：返回的全部是合成数据，不得当实测上报。" ;;
  *)    echo "[bridge] 连接未建立，status 仍为 unknown。手动重试：curl -X POST $BASE/devices/bench/tools/connect -H \"x-bridge-token: \$BRIDGE_TOKEN\" -H 'content-type: application/json' -d '{\"arguments\":{}}'" ;;
esac
printf '[bridge] 当前 status：'
curl -fsS "$BASE/devices/bench/status" -H "x-bridge-token: ${BRIDGE_TOKEN}" \
  | .venv/bin/python -c 'import json,sys
d = json.load(sys.stdin)
print("mode=%s connected=%s hostname=%s" % (d.get("mode"), d.get("connected"), d.get("hostname")))'
