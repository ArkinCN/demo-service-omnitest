#!/usr/bin/env bash
# 跑一遍全部取证：真台架路径、红线确认闸口、mock 路径。产物落 evidence/。
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
E=evidence; PY=.venv/bin/python; B="http://127.0.0.1:${BRIDGE_PORT:-8031}"
H="x-bridge-token: ${BRIDGE_TOKEN}"
J(){ $PY -m json.tool --no-ensure-ascii; }
T(){ curl -sS -H "$H" -X POST "$B/devices/bench/tools/$1" -H 'content-type: application/json' -d "{\"arguments\":$2}"; }
G(){ curl -sS -H "$H" "$B$1"; }

echo "[1/4] 连接层 + 设备清单"
T connect '{}'                                   | J > $E/02-connect-live.json
G /devices                                       | J > $E/01-devices.json
G /devices/bench/status                          | J > $E/03-status-live.json

echo "[2/4] 观测层（真台架）"
T read_fg '{"samples":3,"interval_s":0.5}'       | J > $E/04-read_fg-live.json
T read_pwm '{}'                                  | J > $E/05-read_pwm-live.json
T tail_log '{"lines":12}'                        | J > $E/06-tail_log-live.json
T capture_scope '{}'                             | J > $E/07-capture_scope-dryrun.json

echo "[3/4] 动作层红线：无 token 拒绝 → 人工批准 → 放行 → 重放被拒"
T start '{"duty_percent":60,"duration_s":30}'    | J > $E/08-start-no-token-REFUSED.json
TOK=$($PY -c "import json;print(json.load(open('$E/08-start-no-token-REFUSED.json'))['confirm_token'])")
T start "{\"duty_percent\":60,\"duration_s\":30,\"confirm_token\":\"$TOK\"}" \
                                                 | J > $E/09-start-unapproved-token-REFUSED.json
curl -sS -H "$H" -X POST "$B/confirmations/$TOK/approve" -H 'content-type: application/json' \
     -d '{"operator":"张工（spike 取证）","note":"台架空载，仅验证闸口"}' | J > $E/10-approve-by-human.json
T start "{\"duty_percent\":60,\"duration_s\":30,\"confirm_token\":\"$TOK\"}" \
                                                 | J > $E/11-start-approved-EXECUTED.json
T start "{\"duty_percent\":60,\"duration_s\":30,\"confirm_token\":\"$TOK\"}" \
                                                 | J > $E/12-start-replay-REFUSED.json
# 参数被换掉：拿一张为 A 参数批的票去执行 B 参数，必须拒
T write_param '{"key":"kp_speed","value":1.25}'  | J > $E/13-write_param-no-token-REFUSED.json
TOK2=$($PY -c "import json;print(json.load(open('$E/13-write_param-no-token-REFUSED.json'))['confirm_token'])")
curl -sS -H "$H" -X POST "$B/confirmations/$TOK2/approve" -H 'content-type: application/json' \
     -d '{"operator":"张工（spike 取证）"}' > /dev/null
T write_param "{\"key\":\"kp_speed\",\"value\":9.99,\"confirm_token\":\"$TOK2\"}" \
                                                 | J > $E/14-write_param-args-tampered-REFUSED.json
T estop '{"reason":"演示"}'                       | J > $E/15-estop-no-token-REFUSED.json
G /confirmations?include_done=true               | J > $E/16-confirmations-audit-trail.json

echo "[4/4] mock 路径：断开真连接，强制 mock，同样的观测工具再跑一遍"
T connect '{"force_mock":true}'                  | J > $E/17-connect-mock.json
T read_fg '{"samples":3,"interval_s":0.3}'       | J > $E/18-read_fg-mock.json
T read_pwm '{}'                                  | J > $E/19-read_pwm-mock.json
T connect '{}'                                   > /dev/null   # 复位回真连接
echo "done -> $E/"
