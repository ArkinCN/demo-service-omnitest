"""device-bench MCP server。

工具按三层分组，组名写在每个工具的 meta.group 上，前端据此画工具菜单：
  connection  连接层   connect / status / disconnect
  observation 观测层   read_fg / read_pwm / capture_scope / tail_log
  action      动作层   start / stop / estop / write_param / export / archive

动作层六个工具全部受人工确认闸口约束（device_bench/confirm.py），
无 confirm_token 一律拒绝执行，只返回一张待人工批准的凭据。

两种传输：
    python -m device_bench.server --transport stdio
    python -m device_bench.server --transport streamable-http --port 8032
"""
from __future__ import annotations

import argparse
import math
import os
import re
import time
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from . import config
from .backend import BenchBackend
from .confirm import GUARDED_ACTIONS, REGISTRY

ALLOW_MOCK = os.environ.get("BENCH_ALLOW_MOCK", "1") != "0"
BENCH = BenchBackend(config.BENCH, allow_mock=ALLOW_MOCK)

server = MCPServer(
    name="device-bench",
    title="峰岹台架设备",
    version="0.1.0",
    instructions=(
        "把峰岹电机测试台架当成一台 MCP 设备来用。\n"
        "观测层随便调；动作层六个工具（start/stop/estop/write_param/export/archive）"
        "有物理后果，必须先拿到人工批准过的 confirm_token 才会执行。\n"
        "任何返回里的 mode 字段若为 mock，数据就是合成的，不得当作实测结果上报。"
    ),
)


# ---------- 公共 ----------

def _envelope(mode: str, **kw: Any) -> dict:
    """统一返回信封。mode 永远在，mock 永不冒充 live。"""
    env = {"mode": mode, "ts": time.time(), "device_id": "bench"}
    if mode == "mock":
        env["mock_warning"] = "合成数据，非台架实测，不得作为测试结论的证据"
    env.update(kw)
    return env


def _guard(tool: str, args: dict, confirm_token: str | None) -> dict | None:
    """动作层闸口。返回非 None 就代表拒绝执行，把它原样当结果返回。"""
    clean = {k: v for k, v in args.items() if k != "confirm_token"}
    if not confirm_token:
        t = REGISTRY.issue(tool, clean, GUARDED_ACTIONS[tool])
        return {
            "status": "confirmation_required",
            "executed": False,
            "reason": "红线动作，未带 confirm_token，已拒绝执行",
            "how_to_proceed": (
                "把下面这张凭据交给人：前端在 C 区看板弹出确认条，"
                "人点确认后调桥的 POST /confirmations/{token}/approve，"
                "再带着同一个 confirm_token 和同一组参数重调本工具。"
            ),
            **t.public(),
        }
    try:
        REGISTRY.redeem(confirm_token, tool, clean)
    except (PermissionError, KeyError) as exc:
        return {
            "status": "confirmation_invalid",
            "executed": False,
            "reason": str(exc),
            "tool": tool,
        }
    return None


# ---------- 连接层 ----------

@server.tool(
    name="connect",
    title="连接台架",
    description="通过 SSH 连接峰岹台架工控机。连不上时降级为 mock 并在返回里标明原因。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True),
    meta={"group": "connection", "layer": "连接层", "guarded": False},
)
def connect(force_mock: bool = False) -> dict:
    """建立或重建到台架的 SSH 会话。

    Args:
        force_mock: 置 true 则不尝试 SSH，直接进 mock，用于无台架时演示。
    """
    snap = BENCH.connect(force_mock=force_mock)
    return _envelope(snap.pop("mode"), status="ok", **snap)


@server.tool(
    name="status",
    title="台架状态",
    description="返回连接状态、真实/mock 模式、主机名、在线时长与最近一次错误。C 区画布节点靠它显示连接徽章。",
    annotations=ToolAnnotations(readOnlyHint=True),
    meta={"group": "connection", "layer": "连接层", "guarded": False},
)
def status() -> dict:
    snap = BENCH.snapshot()
    pending = REGISTRY.list()
    return _envelope(
        snap.pop("mode"),
        status="ok",
        pending_confirmations=len(pending),
        pending_tokens=[p["confirm_token"] for p in pending],
        **snap,
    )


@server.tool(
    name="disconnect",
    title="断开台架",
    description="关闭 SSH 会话，释放通道。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True),
    meta={"group": "connection", "layer": "连接层", "guarded": False},
)
def disconnect() -> dict:
    snap = BENCH.disconnect()
    return _envelope(snap.pop("mode"), status="ok", **snap)


# ---------- 观测层 ----------

_FG_RE = re.compile(r"FG(\d)=([0-9.eE+\-]+)")


@server.tool(
    name="read_fg",
    title="读转速反馈",
    description=(
        "读 FG1（电气转速方波）与 FG2（红外机械转速，1 脉冲/转）的频率，"
        "并换算转速与 FG1/FG2 比值（极对数 2，理论应为 2.0）。"
        "台架上跑的是 C:\\fc_pull\\FgPoll.exe。"
    ),
    annotations=ToolAnnotations(readOnlyHint=True),
    meta={"group": "observation", "layer": "观测层", "guarded": False,
          "signals": ["FG1", "FG2"]},
)
def read_fg(samples: int = 1, interval_s: float = 1.0) -> dict:
    """采 samples 次 FG 频率。

    Args:
        samples: 采样次数，1 到 10。
        interval_s: 两次之间间隔秒数。
    """
    samples = max(1, min(int(samples), 10))
    rows: list[dict] = []
    mode = BENCH.mode
    for i in range(samples):
        if i:
            time.sleep(max(0.0, min(interval_s, 5.0)))
        r = BENCH.exec(config.FGPOLL)
        mode = r.mode
        found = {f"FG{g}": float(v) for g, v in _FG_RE.findall(r.out)}
        fg1, fg2 = found.get("FG1"), found.get("FG2")
        valid = lambda v: v is not None and v < config.VISA_NAN / 10  # noqa: E731
        row = {
            "i": i,
            "fg1_hz": fg1 if valid(fg1) else None,
            "fg2_hz": fg2 if valid(fg2) else None,
            "raw": r.out.strip(),
            "elapsed_ms": r.elapsed_ms,
        }
        if row["fg2_hz"]:
            row["rpm"] = round(row["fg2_hz"] * 60, 1)
        if row["fg1_hz"] and row["fg2_hz"]:
            row["fg1_over_fg2"] = round(row["fg1_hz"] / row["fg2_hz"], 3)
        if row["fg1_hz"] is None and row["fg2_hz"] is None:
            row["note"] = (
                "示波器返回 9.9E37（VISA 无有效测量哨兵值）：电机未转或探头未接，"
                "不是通信故障"
            )
        rows.append(row)
    ok = [r for r in rows if r.get("rpm")]
    return _envelope(
        mode,
        status="ok",
        samples=rows,
        rpm_mean=round(sum(r["rpm"] for r in ok) / len(ok), 1) if ok else None,
        motor_spinning=bool(ok),
    )


@server.tool(
    name="read_pwm",
    title="读 PWM 占空比",
    description=(
        "读 PWM1（驱动被测电机）的占空比。实现方式是取一段 CH4 采样、"
        "按高于中点的采样占比算占空比——低采样率混叠下该比例仍准确（实测零偏差），"
        "载波形状则需要 capture_scope 单独高速短抓。"
    ),
    annotations=ToolAnnotations(readOnlyHint=True),
    meta={"group": "observation", "layer": "观测层", "guarded": False,
          "signals": ["PWM1"]},
)
def read_pwm(channel: int = 4) -> dict:
    """读一路 PWM 的占空比。

    Args:
        channel: 示波器通道号，PWM1 接在 CH4。
    """
    r = BENCH.exec(f'{config.SCOPECTL} q ":MEAS:ITEM? PDUTy,CHAN{channel}"')
    txt = r.out.strip()
    duty = None
    m = re.search(r"([0-9.eE+\-]+)", txt)
    if m:
        try:
            v = float(m.group(1))
            if v < config.VISA_NAN / 10:
                duty = round(v, 2)
        except ValueError:
            duty = None
    if r.mode == "mock" and duty is None:
        duty = 50.0
        txt = "MOCK duty 50.0"
    note = None
    if duty is None:
        note = (
            "未取到占空比。已知成因两类：一是 C:\\fc_pull 下的 .exe 会变坏档（ScopeCtl "
            "返回 OPEN_FAIL），需在台架机用 csc /platform:x64 当场重编；"
            "二是示波器被 MotorDebug 或遗留 powershell 独占。"
        )
    return _envelope(
        r.mode,
        status="ok" if duty is not None else "unavailable",
        channel=channel,
        signal="PWM1" if channel == 4 else f"CH{channel}",
        duty_percent=duty,
        raw=txt,
        note=note,
    )


@server.tool(
    name="capture_scope",
    title="抓示波器波形",
    description=(
        "从示波器深存储读逐点时序（电流 CH1 / FG1 CH2 / FG2 CH3 / PWM1 CH4）。"
        "默认只做 dry_run 返回计划与预估，不真抓——真抓一次约 20 到 25 秒、出约 100 MB CSV，"
        "且会独占示波器，必须由调用方显式把 dry_run 置 false。"
    ),
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False),
    meta={"group": "observation", "layer": "观测层", "guarded": False,
          "signals": ["CH1", "FG1", "FG2", "PWM1"]},
)
def capture_scope(
    channels: list[int] | None = None,
    time_per_div_s: float = 10.0,
    dry_run: bool = True,
) -> dict:
    """抓一段深存储波形。

    Args:
        channels: 要抓的通道，默认四通道全抓。
        time_per_div_s: 时基，10 秒每格对应 120 秒窗口、约 25 kSa/s。
        dry_run: 默认 true，只返回计划不真抓。
    """
    chans = channels or [1, 2, 3, 4]
    window_s = time_per_div_s * 12
    depth = 3_000_000
    plan = {
        "channels": chans,
        "time_per_div_s": time_per_div_s,
        "window_s": window_s,
        "assumed_depth_points": depth,
        "effective_sample_rate_sa_s": round(depth / window_s, 1),
        "tool": config.DEEPCAPTURE4,
        "expected_csv_mb": round(depth * len(chans) * 8 / 1e6),
        "caveat": (
            "PWM 载波约 25 kHz，在 25 kSa/s 下只有 1 点/周期，看不了波形形状；"
            "要看载波须另开 1 ms/div 的高速短抓。"
        ),
    }
    if dry_run:
        return _envelope(BENCH.mode, status="planned", executed=False, plan=plan)
    r = BENCH.exec(config.DEEPCAPTURE4, timeout=180)
    return _envelope(
        r.mode,
        status="ok" if r.rc == 0 else "failed",
        executed=True,
        plan=plan,
        rc=r.rc,
        stdout_tail=r.out[-2000:],
        stderr_tail=r.err[-1000:],
        elapsed_ms=r.elapsed_ms,
    )


@server.tool(
    name="tail_log",
    title="读软件运行日志",
    description=(
        "读台架机上 MotorDebug（原 Altior）的后端运行日志尾部。"
        "节点执行的真相在这里：预设命令完成、RIGOL 截图保存、SCPI 下发都会留痕。"
        "整屏只有 save_workflow_autosave 则说明工作流根本没在跑。"
    ),
    annotations=ToolAnnotations(readOnlyHint=True),
    meta={"group": "observation", "layer": "观测层", "guarded": False},
)
def tail_log(lines: int = 40, date: str | None = None) -> dict:
    """读日志尾部。

    Args:
        lines: 取最后多少行，1 到 500。
        date: 形如 2026-09-11；留空则取该目录下最新的一份。
    """
    n = max(1, min(int(lines), 500))
    if date:
        pick = f'$f=Get-Item -LiteralPath "{config.MOTORDEBUG_LOG_DIR}\\motordebug.{date}.log"'
    else:
        pick = (
            f'$f=Get-ChildItem -LiteralPath "{config.MOTORDEBUG_LOG_DIR}" -Filter *.log '
            f'| Sort-Object LastWriteTime -Descending | Select-Object -First 1'
        )
    # 日志正文是 UTF-8，但 Windows 控制台是 GBK，直接回显必乱码。
    # 办法是在远端把内容 base64 起来当纯 ASCII 传回，本地再解码，彻底绕开控制台编码。
    ps = (
        '$ProgressPreference="SilentlyContinue"; ' + pick + '; '
        'Write-Output ("LOGFILE:"+$f.FullName); '
        f'$t=(Get-Content -LiteralPath $f.FullName -Tail {n} -Encoding UTF8) -join "`n"; '
        'Write-Output ("B64:"+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))'
    )
    import base64
    enc = base64.b64encode(ps.encode("utf-16-le")).decode()
    r = BENCH.exec(f"powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {enc}")

    logfile, body = None, []
    for ln in r.out.splitlines():
        if ln.startswith("LOGFILE:"):
            logfile = ln[len("LOGFILE:"):].strip()
        elif ln.startswith("B64:"):
            try:
                body = base64.b64decode(ln[4:].strip()).decode("utf-8", "replace").splitlines()
            except Exception:  # noqa: BLE001
                body = [ln]
        elif r.mode == "mock":
            body.append(ln)
    return _envelope(
        r.mode,
        status="ok" if r.rc == 0 and body else "unavailable",
        logfile=logfile,
        line_count=len(body),
        lines=body,
        stderr_tail=r.err[-500:] or None,
    )


# ---------- 动作层（六个红线动作） ----------

def _action_result(tool: str, mode: str, detail: dict) -> dict:
    return _envelope(mode, status="ok", executed=True, tool=tool, **detail)


@server.tool(
    name="start",
    title="启动电机（需人工确认）",
    description="启动被测电机。红线动作：无人工批准过的 confirm_token 一律拒绝执行。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "物理后果：台架会真的转起来"},
)
def start(duty_percent: float = 50.0, duration_s: float = 30.0,
          confirm_token: str | None = None) -> dict:
    """启动电机跑一段。

    Args:
        duty_percent: PWM 占空比百分比。
        duration_s: 持续秒数。
        confirm_token: 人工批准过的一次性凭据；没有就拒绝执行。
    """
    args = {"duty_percent": duty_percent, "duration_s": duration_s}
    blocked = _guard("start", args, confirm_token)
    if blocked:
        return blocked
    return _action_result("start", BENCH.mode, {
        "args": args,
        "dispatch": "spike 阶段不真发控制命令；落地时这里下发 hid_preset_speed_test 工作流",
        "approved_token": confirm_token,
    })


@server.tool(
    name="stop",
    title="停止电机（需人工确认）",
    description="正常停止被测电机。红线动作，需人工批准过的 confirm_token。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "改变被测对象运行状态"},
)
def stop(confirm_token: str | None = None) -> dict:
    blocked = _guard("stop", {}, confirm_token)
    if blocked:
        return blocked
    return _action_result("stop", BENCH.mode, {
        "dispatch": "spike 阶段不真发控制命令", "approved_token": confirm_token})


@server.tool(
    name="estop",
    title="急停（需人工确认）",
    description=(
        "急停：立即切断驱动输出。红线动作，需人工批准过的 confirm_token。"
        "注意急停在权限模型里独立于常规三档权限，落地时应另有一条物理急停回路，"
        "软件急停只是补充、不能作为唯一手段。"
    ),
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "立即切断输出",
          "note": "软件急停不替代物理急停回路"},
)
def estop(reason: str = "", confirm_token: str | None = None) -> dict:
    """急停。

    Args:
        reason: 急停理由，会写进凭据历史。
        confirm_token: 人工批准过的一次性凭据。
    """
    args = {"reason": reason}
    blocked = _guard("estop", args, confirm_token)
    if blocked:
        return blocked
    return _action_result("estop", BENCH.mode, {
        "args": args, "dispatch": "spike 阶段不真发控制命令",
        "approved_token": confirm_token})


@server.tool(
    name="write_param",
    title="写回参数（需人工确认）",
    description="把控制参数写回驱动板。红线动作，需人工批准过的 confirm_token。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "改变被测对象行为，且可能不可逆"},
)
def write_param(key: str, value: float, confirm_token: str | None = None) -> dict:
    """写一个参数。

    Args:
        key: 参数名。
        value: 新值。
        confirm_token: 人工批准过的一次性凭据。
    """
    args = {"key": key, "value": value}
    blocked = _guard("write_param", args, confirm_token)
    if blocked:
        return blocked
    return _action_result("write_param", BENCH.mode, {
        "args": args, "dispatch": "spike 阶段不真写寄存器",
        "approved_token": confirm_token})


@server.tool(
    name="export",
    title="导出产物（需人工确认）",
    description="把本轮产物导出成对外交付文件。红线动作，需人工批准过的 confirm_token。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "落盘成对外交付物"},
)
def export(run_id: str, fmt: str = "xlsx", confirm_token: str | None = None) -> dict:
    """导出一轮产物。

    Args:
        run_id: 轮次标识。
        fmt: 导出格式。
        confirm_token: 人工批准过的一次性凭据。
    """
    args = {"run_id": run_id, "fmt": fmt}
    blocked = _guard("export", args, confirm_token)
    if blocked:
        return blocked
    return _action_result("export", BENCH.mode, {
        "args": args, "dispatch": "spike 阶段不真导出",
        "approved_token": confirm_token})


@server.tool(
    name="archive",
    title="归档本轮（需人工确认）",
    description="把本轮结果写入存档。红线动作，需人工批准过的 confirm_token。",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False),
    meta={"group": "action", "layer": "动作层", "guarded": True,
          "human_gate": "confirm_token", "risk": "写入不可随意回退的存档"},
)
def archive(run_id: str, note: str = "", confirm_token: str | None = None) -> dict:
    """归档一轮结果。

    Args:
        run_id: 轮次标识。
        note: 归档备注。
        confirm_token: 人工批准过的一次性凭据。
    """
    args = {"run_id": run_id, "note": note}
    blocked = _guard("archive", args, confirm_token)
    if blocked:
        return blocked
    return _action_result("archive", BENCH.mode, {
        "args": args, "dispatch": "spike 阶段不真归档",
        "approved_token": confirm_token})


# ---------- 入口 ----------

def main() -> None:
    ap = argparse.ArgumentParser(description="device-bench MCP server")
    ap.add_argument("--transport", default="stdio",
                    choices=["stdio", "streamable-http", "sse"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("MCP_HTTP_PORT", "8032")))
    a = ap.parse_args()
    if a.transport == "stdio":
        server.run(transport="stdio")
    else:
        # mcp 2.x 把 host/port 作为 run 的关键字参数传，不再挂在 settings 上
        server.run(transport=a.transport, host=a.host, port=a.port)


if __name__ == "__main__":
    main()
