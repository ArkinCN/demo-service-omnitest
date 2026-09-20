#!/usr/bin/env bash
# 起 MCP server 的 streamable-http 传输（默认 127.0.0.1:8032）
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE=.mcphttp.pid
if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then kill "$(cat $PIDFILE)"; sleep 2; fi
set -a; . ./.env; set +a
setsid nohup .venv/bin/python -m device_bench.server \
  --transport streamable-http --port "${MCP_HTTP_PORT:-8032}" \
  > evidence/mcp-http.log 2>&1 < /dev/null &
echo $! > $PIDFILE
sleep 4
echo "mcp streamable-http on 127.0.0.1:${MCP_HTTP_PORT:-8032}/mcp (pid $(cat $PIDFILE))"
