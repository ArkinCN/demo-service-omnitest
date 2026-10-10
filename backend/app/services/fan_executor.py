"""风扇实验执行器：真实台架执行 + 模拟兜底（阶段 5 接入 v0.6 硬件交接包）。

数据纪律（不可逾越）：
- **真实数据只来自真仪器**。`RealFanExecutor` 只把 `run-experiment.ps1` 写进
  `events.jsonl` 的 `capture_completed` 事件原样映射成 sample，不加减任何数值。
- **模拟数据必须显式标注 `simulation: true`**。`SimFanExecutor` 是开发/联调兜底，
  用于在无仪器时验证「接口 → 轮询 → 动态刷新」链路，其数值是合成值，
  不得被下游当作实测上报；每个返回对象都带 `simulation` 字段，前端据此如实显示。

字段契约对齐扩展包 `hardware/v0.6/docs/examples/02_samples.json`（snake_case）：
  sequence / t_s / measurement_started_t_s / measurement_finished_t_s /
  commanded_pwm_pct / voltage_v / current_probe_v / current_a /
  measured_pwm_duty_pct / pwm_frequency_hz / rpm / quality / capture_id

缺测纪律：电流未确认换算时 `current_a = null`、测速未接入时 `rpm = null`，
并在 `quality` 里写明原因；绝不补 0、绝不编值。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.core.exceptions import BadRequestException, ConflictException
from app.core.logger import logger

# 默认计划：30/50/70/100% 各 20 秒，一轮共 80 秒（对齐 acceptance.json，2026-10-09）。
# 为什么由 10s 改为 20s：硬件改为每档连续多次采集（capturesPerStep，默认 5），
# 单档需 settle 2s + 5 次采集（每次约 2~3.5s），10s 装不下 5 个点；20s 可容纳。
# 该值只用于展示/planned_duration_s 与 overrun 判定，真实样本仍以 events.jsonl 为准。
DEFAULT_STEPS = [
    {"duration_s": 20, "commanded_pwm_pct": 30},
    {"duration_s": 20, "commanded_pwm_pct": 50},
    {"duration_s": 20, "commanded_pwm_pct": 70},
    {"duration_s": 20, "commanded_pwm_pct": 100},
]

# ---------------------------------------------------------------------------
# 硬件脚本位置（相对项目根推导，不写死绝对路径）。
#
# fan_executor.py 位于 <项目根>/backend/app/services/ 下：
#   parents[0] = services, parents[1] = app, parents[2] = backend, parents[3] = 项目根
# 硬件脚本**Python 跨平台版**约定放在 <项目根>/hardware/py/ 下（对应原 PowerShell 版
# hardware/v0.6/，二者行为契约一致）。配置仍用 hardware/v0.6/config/acceptance.json
# （Python 版入口通过 -ConfigPath 接受同一份配置）。
# 项目整体移动/换机器后仍能自动定位；环境变量 FAN_START_SCRIPT / FAN_STOP_SCRIPT /
# FAN_CONFIG_PATH 仍可覆盖（例如硬件部署在另一台仪器电脑时）。
# ---------------------------------------------------------------------------
_PY_DIR = Path(__file__).resolve().parents[3] / "hardware" / "py"
_DEFAULT_START_SCRIPT = _PY_DIR / "entrypoints" / "start.py"
_DEFAULT_STOP_SCRIPT = _PY_DIR / "entrypoints" / "stop.py"
_DEFAULT_CONFIG_PATH = _PY_DIR.parent / "v0.6" / "config" / "acceptance.json"
# 平台 overlay（2026-10-08 新增）：主配置 acceptance.json 的 serial.port / scope.resource
# **故意留空**，靠 overlay 补齐（见 hardware/py/runtime.py 的 overlay 合并层）。
# 但 start.py 约定「显式传 -ConfigPath 则不叠加 overlay」（保护 run_scope.py 隔离测试），
# 而后端启动时必然是显式传 -ConfigPath —— 两条规则相撞会让 serial.port 为空、启动即失败。
# 因此由后端（唯一知道"当前是哪台机器"的组件）按平台直接选定 overlay 文件。
_CONFIG_DIR = _DEFAULT_CONFIG_PATH.parent
_PLATFORM_OVERLAY = _CONFIG_DIR / (
    "acceptance.windows.json" if os.name == "nt" else "acceptance.linux.json"
)
# 子进程解释器解析（2026-10-09 修，风扇不转的致命根因）。
#
# 背景：原实现是 `os.environ.get("FAN_PYTHON") or sys.executable`。
# sys.executable 指向**后端自己的 venv**（backend/.venv/Scripts/python.exe），
# 而该 venv 只装后端依赖，**没有 pyserial / pyvisa**（实测两库均 ModuleNotFoundError）。
# 于是 hardware/py/run_experiment.py 在顶层 `import fan_serial` → `import serial`
# 处立即崩、退出码 1，`SET <duty>` 从未下发到 UNO —— 表现就是「点了启动风扇不转」。
#
# 修复口径（数据纪律：不假装成功，失败给可行动原因）：
#   ① FAN_PYTHON 环境变量优先（现场/分机显式指定）；
#   ② 否则探测「同目录下的 backend/.venv 兄弟解释器」以外，还允许用
#      `hardware/.env`（若存在）里的 FAN_PYTHON 指定；
#   ③ 仍无则回退 sys.executable，并由 _precheck_dependencies 在启动前如实报错，
#      提示到哪个解释器装 requirements.txt，而不是静默崩在子进程里。
_FAN_PYTHON_ENV = "FAN_PYTHON"

# hardware/.env（可选）：把硬件侧环境变量（含 FAN_PYTHON / FAN_CONFIG_PATH）写在
# 此文件里，后端启动子进程时读取并注入。硬件包与后端可能用不同解释器，这层是解耦点。
_HARDWARE_ENV_FILE = _PY_DIR.parent / ".env"


def _read_hardware_env() -> dict[str, str]:
    """读 hardware/.env（若存在）为键值对。缺失/不可读一律返回空 dict，不抛错。

    为什么需要：hardware/ 未被 git 跟踪、解释器与后端不同，现场需要一个
    「不改代码就能指定解释器/overlay」的地方。hardware/.env 承担这个角色：
      FAN_PYTHON=<装有 pyserial+pyvisa 的解释器绝对路径>
      FAN_CONFIG_PATH=<overlay 绝对路径，可选>
    文件缺失时**不猜路径**，交由依赖预检如实报错（数据纪律）。
    """
    out: dict[str, str] = {}
    try:
        if not _HARDWARE_ENV_FILE.is_file():
            return out
        for raw in _HARDWARE_ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                out[key] = value
    except OSError:
        return {}
    return out


def _probe_dependencies(python_exe: str) -> list[str]:
    """探测某个解释器是否具备硬件脚本所需依赖，返回缺失项名称列表（空=齐备）。

    用 `-c "import importlib.util,sys; ..."` 在**目标解释器**内探测（而非当前进程），
    因为当前后端进程是否有 serial 与目标解释器无关。只探测不打开硬件，副作用为零。
    探测失败（解释器路径不存在/无法启动）返回全部缺失项，由调用方报可行动原因。
    """
    required = ("serial", "pyvisa")
    code = (
        "import importlib.util as u,sys;"
        f"miss=[m for m in {required!r} if u.find_spec(m) is None];"
        "sys.stdout.write('|'.join(miss))"
    )
    try:
        proc = subprocess.run(
            [python_exe, "-c", code],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning("[fan-executor] 解释器探测失败（%s）：%s", python_exe, e)
        return list(required)
    if proc.returncode != 0:
        # 解释器能起但导入探测脚本就失败 → 视为全部缺失，附 stderr 末行便于定位
        detail = (proc.stderr or "").strip().splitlines()
        logger.warning(
            "[fan-executor] 解释器 %s 探测返回码 %s：%s",
            python_exe, proc.returncode, detail[-1] if detail else "(无 stderr)",
        )
        return list(required)
    missing = [m for m in (proc.stdout or "").strip().split("|") if m]
    return missing


def _resolve_python() -> str:
    """解析用于拉起硬件脚本的解释器（2026-10-09 新增）。

    优先级（高 → 低）：
      1. 进程环境变量 FAN_PYTHON（部署/分机显式指定，最高优先）；
      2. hardware/.env 里的 FAN_PYTHON（现场配置文件，不改代码即可切换）；
      3. sys.executable（兜底；缺依赖时由 _precheck_dependencies 如实报错）。

    注意：**不做「扫描磁盘找 conda」这类臆测**——找不到就回退并在预检阶段
    报出可行动原因（写明去哪个解释器装 hardware/py/requirements.txt）。
    """
    explicit = os.environ.get(_FAN_PYTHON_ENV)
    if explicit:
        return explicit
    env_file = _read_hardware_env().get(_FAN_PYTHON_ENV)
    if env_file:
        return env_file
    return sys.executable


# 解析结果缓存（每进程一次即可；环境变量变更需重启后端，与「后端不热重载」一致）。
_PYTHON = _resolve_python()


def _select_config_path() -> str:
    """选定主配置路径（后端专用）。

    优先级（高 → 低）：
      1. `FAN_CONFIG_PATH` 环境变量**不是主配置路径**，见下方说明，此处忽略之；
      2. 主配置 `acceptance.json`（跨机器通用，机器相关字段留空）。

    为什么这里不直接返回 overlay 文件：overlay（acceptance.windows.json）**只是
    一个字段片段，本身没有 schemaVersion**，不能单独当主配置读（会报
    "Unsupported config schemaVersion."）。正确用法是「主配置 + 深合并 overlay」，
    即 runtime.read_experiment_config 的 allow_overlay=True 路径 —— 由
    FAN_CONFIG_PATH 环境变量指向 overlay。见 `_resolve_overlay_path()`。
    """
    return str(_DEFAULT_CONFIG_PATH)


def _resolve_overlay_path() -> str:
    """解析本次运行要使用的 overlay 文件路径（可为空串表示不叠加）。

    优先级：
      1. `FAN_CONFIG_PATH` 环境变量 —— 现场显式指定（可指向 overlay 或完整配置）；
      2. 平台 overlay：Windows=acceptance.windows.json / Linux=acceptance.linux.json；
      3. 空串 —— 无 overlay 可用（此时主配置留空字段会由预检报出明确原因）。

    为什么要由后端解析：start.py 约定「显式传 -ConfigPath 则不叠加 overlay」
    （保护 run_scope.py 隔离测试），而后端启动必然是显式 -ConfigPath。因此后端
    必须在子进程环境里补上 FAN_CONFIG_PATH，让子进程的 allow_overlay 分支生效。
    """
    explicit = os.environ.get("FAN_CONFIG_PATH")
    if explicit:
        return explicit
    if _PLATFORM_OVERLAY.is_file():
        return str(_PLATFORM_OVERLAY)
    logger.warning(
        "[fan-executor] 平台 overlay 不存在：%s（主配置留空字段将无法补齐）",
        _PLATFORM_OVERLAY,
    )
    return ""


def _load_runtime_module() -> Any:
    """按文件路径加载硬件包的 runtime.py（不污染后端 sys.path）。

    必须先注册进 sys.modules 再 exec_module：runtime.py 用了
    `from __future__ import annotations` + @dataclass，dataclasses 解析类型注解时
    会按模块名回查 sys.modules，未注册会抛 "NoneType has no attribute __dict__"。
    """
    import importlib.util  # noqa: PLC0415 - 延迟导入：避免后端启动即依赖硬件包

    runtime_path = _PY_DIR / "runtime.py"
    module_name = "_fan_runtime_precheck"
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(module_name, runtime_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载校验模块：{runtime_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module


def _precheck_config(config_path: str, overlay_path: str) -> str:
    """启动前预检「主配置 + overlay」可解析，把配置错误提前到 start() 同步阶段。

    返回空串表示通过；否则返回可行动的错误原因（原样透传，不美化）。
    为什么预检：子进程失败时后端只能靠 stderr 透传，链路长（≥10s 早失败窗口），
    且 start.py 建目录前失败时连 runs/<id>/stderr.log 都没有，
    前端只会看到"退出码 1 无收尾"这种不可行动的提示。
    预检用与子进程**完全同一套**校验（runtime.read_experiment_config），保证口径一致。
    """
    try:
        module = _load_runtime_module()
        # allow_overlay=True：与子进程一致，走「主配置 < overlay < 精细环境变量」链路。
        # 通过临时设置 FAN_CONFIG_PATH 让 runtime 完成深合并（它读的就是这个环境变量）。
        previous = os.environ.get("FAN_CONFIG_PATH")
        try:
            if overlay_path:
                os.environ["FAN_CONFIG_PATH"] = overlay_path
            else:
                os.environ.pop("FAN_CONFIG_PATH", None)
            module.read_experiment_config(config_path, allow_overlay=True)
        finally:
            if previous is None:
                os.environ.pop("FAN_CONFIG_PATH", None)
            else:
                os.environ["FAN_CONFIG_PATH"] = previous
        return ""
    except Exception as e:  # noqa: BLE001 - 预检失败不抛异常，改为透传原因
        return str(e)


def _precheck_dependencies(python_exe: str) -> str:
    """启动前预检「选定解释器是否装了 hardware/py 依赖」。

    返回空串表示依赖齐备；否则返回可行动原因（含解释器路径与安装指引）。
    为什么必须在后端侧预检：解释器错了的话，子进程会在 `import fan_serial` 处
    立刻崩，而后端只能靠 stderr 透传（链路长、且早失败窗口约 10s）；
    预检把这一步提前到 start() 同步阶段，前端 ≤1s 就能看到「哪个解释器缺哪个包」。

    数据纪律：**如实报错**，不因缺依赖就回退到模拟执行器（那会造成
    「图在动、风扇没转」的误导）。
    """
    missing = _probe_dependencies(python_exe)
    if not missing:
        return ""
    return (
        f"硬件脚本解释器缺少依赖 {missing}（解释器：{python_exe}）。"
        "请在**该解释器**下执行 "
        f"`\"{python_exe}\" -m pip install -r "
        f"{str(_PY_DIR / 'requirements.txt')}`，"
        "或在 hardware/.env 写 FAN_PYTHON=<已装 pyserial/pyvisa 的解释器绝对路径> "
        "后重启后端。"
    )


# ---------------------------------------------------------------------------
# 波形读取（GET /api/fan-tests/{run_id}/captures/{capture_id} 的数据源）
#
# 示波器每次采集把每通道的**真实时序波形**写成 runs/<tag>/<profile>/CH{n}.csv，
# 列为：sample,time_s,voltage_V,current_A（见 scope_capture._save_profile_capture）。
# 这里按需读取，映射成前端可直接绘图的数组。
#
# 数据纪律：文件不存在 / 解析失败 / 列缺失 → 该通道如实返回 available=false + reason，
# **绝不返回伪造或补零数组**；通道未接（如 tach 关闭）同样如实标注。
# ---------------------------------------------------------------------------
# 角色 → 通道语义（与 acceptance.json 的 scope.channels 对应；仅在缺失时作展示名兜底）
_CHANNEL_ROLES = {1: "current", 2: "voltage", 3: "pwm", 4: "tach"}


def _read_wave_csv(csv_path: str) -> dict:
    """读一个 CH{n}.csv 为 {time_s: [...], voltage_v: [...], current_a: [...]|None, points}。

    失败（不存在/空/无表头/无数据行）抛 OSError/ValueError，由调用方转成 available=false。
    只读 4 列里的 3 列（sample 列不用于绘图），逐行 float 解析，非数字行跳过并计数。
    """
    import csv as _csv  # noqa: PLC0415 - 仅此函数用，避免顶层多一个 import

    with open(csv_path, "r", encoding="utf-8", newline="") as fh:
        reader = _csv.DictReader(fh)
        if not reader.fieldnames or "time_s" not in reader.fieldnames or "voltage_V" not in reader.fieldnames:
            raise ValueError("CSV 缺少 time_s / voltage_V 列")
        time_s: list[float] = []
        voltage_v: list[float] = []
        current_a: list[float | None] = []
        has_current = "current_A" in reader.fieldnames
        skipped = 0
        for row in reader:
            try:
                t = float(row["time_s"])
                v = float(row["voltage_V"])
            except (TypeError, ValueError):
                skipped += 1
                continue
            time_s.append(t)
            voltage_v.append(v)
            if has_current:
                raw_c = (row.get("current_A") or "").strip()
                try:
                    current_a.append(float(raw_c) if raw_c else None)
                except ValueError:
                    current_a.append(None)
    if not time_s:
        raise ValueError("CSV 无有效数据行")
    return {
        "time_s": time_s,
        "voltage_v": voltage_v,
        "current_a": current_a if has_current else None,
        "points": len(time_s),
        "skippedRows": skipped,
    }


def read_capture_waveforms(meta: dict) -> dict:
    """按 capture 元数据（含 artifacts 绝对路径）读取各通道真实波形。

    返回 {'available': bool, 'channels': [...], 'notes': [...]}：
      - available=True 表示至少有一个通道读到真实数据；
      - 每个 channel 项：{channel, role, available, reason?, time_s[], voltage_v[], points}
      - 缺通道（如 tach 未开）不出现在 channels 里，notes 里写明原因。
    artifacts 里可能有 pwm/ 与 tach/ 两套（各含 CH{n}.csv）；本接口按文件实际存在读取。
    """
    artifacts = meta.get("artifacts") or []
    channels_out: list[dict] = []
    notes: list[str] = []
    seen_channels: set[int] = set()
    for art in artifacts:
        name = str(art)
        base = os.path.basename(name)
        if not (base.startswith("CH") and base.endswith(".csv")):
            continue
        ch_tag = base[2:-4]
        if not ch_tag.isdigit():
            continue
        channel = int(ch_tag)
        if channel in seen_channels:
            continue
        seen_channels.add(channel)
        role = _CHANNEL_ROLES.get(channel, f"ch{channel}")
        try:
            wave = _read_wave_csv(name)
        except (OSError, ValueError) as e:
            channels_out.append({
                "channel": channel, "role": role, "available": False,
                "reason": f"波形文件不可读：{e}", "time_s": [], "voltage_v": [], "points": 0,
            })
            continue
        channels_out.append({
            "channel": channel, "role": role, "available": True,
            "time_s": wave["time_s"], "voltage_v": wave["voltage_v"],
            "current_a": wave.get("current_a"),
            "points": wave["points"], "skippedRows": wave["skippedRows"],
        })

    if not channels_out:
        notes.append("本次采集的 artifacts 里没有可读的 CH{n}.csv（可能未配示波器或采集失败）。")

    channels_out.sort(key=lambda c: c["channel"])
    available = any(c.get("available") for c in channels_out)
    return {"available": available, "channels": channels_out, "notes": notes}


@dataclass
class FanRunState:
    """一次运行的内存态。本阶段不落库，进程重启即失效（与桥凭据同为内存态）。"""

    run_id: str
    simulation: bool
    mode: str  # "finite" | "rolling"
    planned_duration_s: float
    default_duration_s: float
    cycles: int
    steps: list[dict]
    status: str  # preparing / running / stopping / stopped / completed / failed
    samples: list[dict] = field(default_factory=list)
    started_at: float | None = None
    finished_at: float | None = None
    next_sequence: int = 1
    overrun: bool = False
    stop_requested: bool = False
    error: str = ""
    # 是否已到达权威终态（stopped/completed/failed）。前端据此停止轮询，
    # 不再硬编码 status 字符串判断，避免后端新增状态时前端失配。
    terminal: bool = False
    # 真实执行器记录的 run 首事件 startedUtc，作为 t_s 换算基准（ISO 8601 字符串）。
    t0_utc: str | None = None
    # 波形索引（2026-10-09 新增）：capture_id → 该次采集的元数据与真实 CSV 路径。
    # 数据来源为 capture_completed 事件的 data（含 artifacts 绝对路径），只缓存索引，
    # 波形本体在 GET /captures/{id} 时才从磁盘读取（单文件 ~1200 行，按需读）。
    captures: dict[str, dict] = field(default_factory=dict)


class FanExecutor(Protocol):
    """执行器协议。路由层只依赖这组方法，不关心真实/模拟。"""

    def start(self, run_id: str, plan: dict) -> FanRunState:
        """启动一次运行，返回初始状态。"""

    def stop(self, run_id: str) -> None:
        """请求停止一次运行。"""

    def status(self, run_id: str) -> FanRunState:
        """读取当前状态。"""

    def samples(self, run_id: str, after_sequence: int) -> tuple[list[dict], int]:
        """返回 sequence > after_sequence 的增量点，及**已交付样本的最大 sequence**。

        ⚠️ 契约（2026-10-09 修）：返回的游标必须与筛选字段（`s["sequence"]`）**同源**。
        原实现返回 `st.next_sequence`（已追加样本的计数器），而 RealFanExecutor 里样本
        的 sequence 取自 events.jsonl 的**事件序号**（run_started/step_started/
        capture_completed 混编，如 3、7、11…），两者不同源 → 客户端拿计数器当游标
        回头再问，会收到**已经交付过的样本**，曲线上出现重复斜坡、「已采 N 条」虚高。
        """

    def capture_meta(self, run_id: str, capture_id: str) -> dict | None:
        """返回某次采集的波形索引（含真实 CSV 绝对路径），未知则 None。"""

    def has_active_run(self) -> bool:
        """是否已有 running/stopping 状态的运行（单设备锁依据）。"""


def _quality(voltage: str | None, current: str | None, rpm: str | None) -> dict[str, Any]:
    """拼 quality 对象，缺测项附原因（对齐 02_samples.json 的 quality 语义）。"""
    q: dict[str, Any] = {}
    if voltage:
        q["voltage"] = voltage
    if current:
        q["current"] = current
    if rpm:
        q["rpm"] = rpm
    return q


def _planned_duration(steps: list[dict], cycles: int) -> float:
    """计划总时长 = 各步 duration_s 之和 × cycles；cycles<=0 视为无限（返回 0 表示不可算）。"""
    total = sum(float(s.get("duration_s", 0)) for s in steps)
    if cycles <= 0:
        return 0.0
    return total * cycles


class SimFanExecutor:
    """模拟执行器（默认兜底）：后台线程按计划每秒产一个合成点。

    仅用于无仪器时验证链路，产出全部标 `simulation=True`。数值是合成值：
    电压约 4.95V、实测占空比在命令值附近小幅抖动，电流与转速保持 null（未确认）。
    """

    _lock = threading.Lock()
    _runs: dict[str, FanRunState] = {}

    def has_active_run(self) -> bool:
        with self._lock:
            return any(s.status in ("running", "stopping") for s in self._runs.values())

    def start(self, run_id: str, plan: dict) -> FanRunState:
        if self.has_active_run():
            raise ConflictException("已有风扇实验在进行，请先停止再启动")
        steps = plan.get("steps") or DEFAULT_STEPS
        cycles = int(plan.get("cycles", 1))
        duration = _planned_duration(steps, cycles)
        state = FanRunState(
            run_id=run_id,
            simulation=True,
            mode=plan.get("mode", "finite"),
            planned_duration_s=duration or float(plan.get("default_duration_s", 60)),
            default_duration_s=float(plan.get("default_duration_s", 60)),
            cycles=cycles,
            steps=steps,
            status="running",
            started_at=time.monotonic(),
        )
        with self._lock:
            self._runs[run_id] = state
        threading.Thread(target=self._run, args=(run_id,), daemon=True).start()
        logger.info("[fan-executor] sim run %s started (simulation=True)", run_id)
        return state

    def stop(self, run_id: str) -> None:
        with self._lock:
            st = self._runs.get(run_id)
            if not st or st.terminal:
                return
            st.stop_requested = True
            st.status = "stopping"

    def status(self, run_id: str) -> FanRunState:
        with self._lock:
            return self._runs.get(run_id, FanRunState(run_id=run_id, simulation=True, mode="finite", planned_duration_s=0, default_duration_s=60, cycles=0, steps=[], status="unknown"))

    def samples(self, run_id: str, after_sequence: int) -> tuple[list[dict], int]:
        with self._lock:
            st = self._runs.get(run_id)
            if st is None:
                return [], after_sequence
            picked = [s for s in st.samples if s["sequence"] > after_sequence]
            # 游标 = 已交付样本的最大 sequence（与筛选字段同源，见 Protocol 说明）。
            # sim 的 sequence 本就是 1,2,3…（与 next_sequence 同源），故行为等价。
            latest = picked[-1]["sequence"] if picked else after_sequence
            return picked, max(after_sequence, latest)

    def capture_meta(self, run_id: str, capture_id: str) -> dict | None:
        """模拟执行器不产真实波形文件，一律返回 None（前端据此显示「未采集」）。"""
        return None

    def _run(self, run_id: str) -> None:
        with self._lock:
            st = self._runs[run_id]
        # 展开计划：cycles<=0 视为 rolling（无限循环），此处按单轮有限时长生成
        step_list: list[dict] = []
        cycles = st.cycles if st.cycles > 0 else 1
        for _ in range(cycles):
            step_list.extend(st.steps)

        # 以启动时刻为单调时钟原点；每秒产一个点，取测量中点作为 t_s
        start_mono = st.started_at or time.monotonic()
        step_idx = 0
        t_in_step = 0.0
        current_pwm = None
        while True:
            with self._lock:
                if st.stop_requested:
                    st.status = "stopped"
                    st.finished_at = time.monotonic()
                    st.terminal = True
                    break
                if st.status not in ("running", "stopping"):
                    break

            elapsed = time.monotonic() - start_mono
            # 推进当前档位
            if step_idx < len(step_list):
                step = step_list[step_idx]
                current_pwm = int(step.get("commanded_pwm_pct", 0))
                if elapsed >= step.get("duration_s", 10) + t_in_step:
                    t_in_step += step.get("duration_s", 10)
                    step_idx += 1
                    continue
            else:
                # 计划跑完，标记 completed 后退出
                with self._lock:
                    st.status = "completed"
                    st.finished_at = time.monotonic()
                    st.terminal = True
                    # 若实际耗时超计划，标 overrun
                    if _planned_duration(st.steps, st.cycles) and elapsed > _planned_duration(st.steps, st.cycles):
                        st.overrun = True
                break

            # 采样点（合成值，t_s 取测量中点）
            t_s = round(elapsed, 2)
            pwm = current_pwm if current_pwm is not None else 0
            # 实测占空比 = 命令值 ± 小幅抖动（合成，仅演示）
            measured = round(pwm + (0.0 if pwm in (0, 100) else (pwm % 7 - 3) * 0.3), 1)
            sample = {
                "sequence": st.next_sequence,
                "t_s": t_s,
                "measurement_started_t_s": round(t_s - 0.1, 2),
                "measurement_finished_t_s": round(t_s + 0.1, 2),
                "commanded_pwm_pct": pwm,
                "voltage_v": 4.95,
                "current_probe_v": 0.003,
                "current_a": None,  # 换算未确认，不编值
                "measured_pwm_duty_pct": measured,
                "pwm_frequency_hz": 24950 if pwm not in (0, 100) else None,
                "rpm": None,  # 测速未接入，不编值
                "quality": _quality("provisional_probe_ratio", "conversion_not_confirmed", "not_connected"),
                "capture_id": None,
            }
            with self._lock:
                st.samples.append(sample)
                st.next_sequence += 1
            time.sleep(1.0)


class RealFanExecutor:
    """真实执行器（`FAN_EXECUTOR=real` 启用）：调用仪器电脑硬件脚本，读真实事件流。

    脚本与配置路径：默认按项目相对位置推导（Python 跨平台版 `hardware/py/entrypoints/`），
    项目整体移动/换机器后无需改路径。环境变量可覆盖（例如硬件部署在另一台仪器电脑时）：
      FAN_START_SCRIPT    start.py 路径（可选，默认 hardware/py/entrypoints/start.py）
      FAN_STOP_SCRIPT     stop.py 路径（可选，默认 hardware/py/entrypoints/stop.py）
      FAN_CONFIG_PATH     config 路径（可选，默认 hardware/v0.6/config/acceptance.json）
      FAN_PYTHON          Python 解释器（可选，默认 sys.executable；分机场景指定仪器机 Python）

    数据只来自 `events.jsonl` 里 `capture_completed` 事件的 `data.metrics`，原样映射，
    不加减数值。终态以 `summary.json` 的 `terminalPublished:true` 为准。
    """

    _lock = threading.Lock()
    _runs: dict[str, FanRunState] = {}
    # 缺 sequence 事件的告警去重集合（按 event type），避免每轮轮询刷屏。
    _warned_missing_seq: set[str] = set()
    # _watch 等待终态的总超时（秒）：超过即强制收敛为 failed，杜绝无限轮询。
    # 2026-10-09 上调 120 → 240：硬件改为每档连续多次采集（capturesPerStep，默认 5），
    # 单轮时长明显变长（每档 settle + 多次 VISA 采集），120s 会把正常在跑的轮次
    # 误判为超时失败。上限用「实际时长 + 余量」估算：4 档 × (2s settle + 5 × ~3s 采集)
    # ≈ 70s，再叠加 CH4 档与抖动，240s 足够；仍可被环境变量 FAN_WATCH_TIMEOUT_S 覆盖。
    WATCH_TIMEOUT_S = float(os.environ.get("FAN_WATCH_TIMEOUT_S") or 240.0)
    # 早失败窗口（秒）：启动后此时间内既无事件流文件、进程也已退出 → 不等满超时，
    # 立即透传可行动原因（查 runs/<id>/stderr.log），让前端 ≤10s 看到真实失败。
    EARLY_FAIL_S = 10.0

    def _cfg(self) -> tuple[str, str, str, str]:
        """返回 (start_script, stop_script, config_path, overlay_path)。

        config_path 是**主配置**（跨机器通用）；overlay_path 是本机差异片段，
        通过子进程环境变量 FAN_CONFIG_PATH 注入，让 start.py 的 allow_overlay
        分支完成深合并（见 _resolve_overlay_path 的设计说明）。
        """
        # 环境变量优先（覆盖场景：硬件部署在别处）；未设则用项目相对路径推导。
        start = os.environ.get("FAN_START_SCRIPT") or str(_DEFAULT_START_SCRIPT)
        stop = os.environ.get("FAN_STOP_SCRIPT") or str(_DEFAULT_STOP_SCRIPT)
        config = _select_config_path()
        overlay = _resolve_overlay_path()
        return start, stop, config, overlay

    def has_active_run(self) -> bool:
        with self._lock:
            return any(s.status in ("running", "stopping") for s in self._runs.values())

    def start(self, run_id: str, plan: dict) -> FanRunState:
        if self.has_active_run():
            raise ConflictException("已有风扇实验在进行，请先停止再启动")
        start_script, stop_script, config_path, overlay_path = self._cfg()
        # 启动前预检：配置解析失败（如 serial.port 为空、overlay 缺失）时同步返回明确原因，
        # 不让子进程退出码 1 静默失败（那样要等 ≥10s 早失败窗口且原因可能缺失）。
        problem = _precheck_config(config_path, overlay_path)
        if problem:
            logger.warning(
                "[fan-executor] 配置预检未通过（config=%s, overlay=%s）：%s",
                config_path, overlay_path or "(无)", problem,
            )
            raise BadRequestException(f"风扇实验配置无效：{problem}")
        # 依赖预检（2026-10-09 新增，风扇不转的致命根因防线）：
        # 选定解释器必须能 import serial + pyvisa，否则子进程会立刻崩、风扇不转。
        # 放在配置预检之后：配置错先报配置，依赖错再报依赖，原因逐层收敛。
        dep_problem = _precheck_dependencies(_PYTHON)
        if dep_problem:
            logger.warning(
                "[fan-executor] 依赖预检未通过（python=%s）：%s", _PYTHON, dep_problem,
            )
            raise BadRequestException(f"风扇实验无法启动：{dep_problem}")
        logger.info(
            "[fan-executor] 使用配置：主配置=%s，overlay=%s，解释器=%s",
            config_path, overlay_path or "(无)", _PYTHON,
        )
        steps = plan.get("steps") or DEFAULT_STEPS
        cycles = int(plan.get("cycles", 1))
        state = FanRunState(
            run_id=run_id,
            simulation=False,
            mode=plan.get("mode", "finite"),
            planned_duration_s=_planned_duration(steps, cycles) or float(plan.get("default_duration_s", 60)),
            default_duration_s=float(plan.get("default_duration_s", 60)),
            cycles=cycles,
            steps=steps,
            status="running",
            started_at=time.monotonic(),
        )
        with self._lock:
            self._runs[run_id] = state
        threading.Thread(
            target=self._watch,
            args=(run_id, start_script, stop_script, config_path, overlay_path),
            daemon=True,
        ).start()
        logger.info("[fan-executor] real run %s started via %s", run_id, start_script)
        return state

    def stop(self, run_id: str) -> None:
        """请求停止一次运行。

        ⚠️ 已到终态（terminal）的运行**不再改动状态**（2026-10-09 修）：
        原实现无条件 `status = "stopping"`，会把已经 failed/completed/stopped 的运行
        「复活」成非终态；而 `has_active_run()` 依据 status in (running, stopping) 判单设备锁，
        于是这一复活会让锁**永久占住** → 之后每次启动都 409「已有风扇实验在进行」。
        实测复现：前端在 run 失败（terminal）后仍会调一次 /stop（running→estopped 边沿），
        正好命中该路径。修法：终态直接返回，不改状态、不置 stop_requested。
        """
        with self._lock:
            st = self._runs.get(run_id)
            if not st or st.terminal:
                return
            st.stop_requested = True
            st.status = "stopping"

    def status(self, run_id: str) -> FanRunState:
        with self._lock:
            return self._runs.get(run_id, FanRunState(run_id=run_id, simulation=False, mode="finite", planned_duration_s=0, default_duration_s=60, cycles=0, steps=[], status="unknown"))

    def samples(self, run_id: str, after_sequence: int) -> tuple[list[dict], int]:
        with self._lock:
            st = self._runs.get(run_id)
            if st is None:
                return [], after_sequence
            picked = [s for s in st.samples if s["sequence"] > after_sequence]
            # ⚠️ 游标必须取「已交付样本的最大 sequence」，**不能**用 st.next_sequence：
            # 样本的 sequence 取自 events.jsonl 事件序号（见 _drain_events 的 `"sequence": seq`），
            # 而 next_sequence 是「已追加样本的计数器」，两者不同源。用计数器当游标会让
            # 客户端下一轮收到已交付过的样本 → 曲线重复、「已采 N 条」虚高（2026-10-09 修）。
            latest = picked[-1]["sequence"] if picked else after_sequence
            return picked, max(after_sequence, latest)

    def capture_meta(self, run_id: str, capture_id: str) -> dict | None:
        """返回某次采集的波形索引（含真实 CSV 绝对路径）；未采到的 id 返回 None。

        只读内存索引（由 _drain_events 从 capture_completed 事件的 artifacts 建立），
        不做磁盘扫描、不猜路径；未知即 None，由路由层如实返回 available=false。
        """
        with self._lock:
            st = self._runs.get(run_id)
            if st is None:
                return None
            return st.captures.get(capture_id)

    def _watch(
        self, run_id: str, start_script: str, stop_script: str,
        config_path: str, overlay_path: str = "",
    ) -> None:
        """后台线程：spawn entrypoints/start.py → 轮询 events.jsonl → 解析 capture_completed → 收敛终态。

        终态收敛三重兜底（2026-10-06 补，修「脚本已失败但前端无限轮询」）：
          ① 进程已退出（proc.poll() 非空）→ 按 summary 收敛，summary 缺失按事件流；
          ② _drain_events 见到 run_finished 事件 → 标记脚本已收尾，下一轮强制判定；
          ③ 总超时 120 秒仍无终态 → 置 failed + terminal，error 写明超时。
        任一兜底命中即收敛，绝不无限轮询。
        """
        with self._lock:
            st = self._runs[run_id]
        stderr_file: Any = None
        try:
            # 启动硬件脚本（Python 版）。stderr 改为**捕获到临时文件**（2026-10-08 改）：
            # 原用 DEVNULL，但 start.py 在「建运行目录之前」失败时（如配置为空）不会写出
            # runs/<id>/stderr.log，后端便无法透传真实原因，前端只看到"退出码 1 无收尾"。
            # 为什么用临时文件而非 PIPE：stderr=PIPE 若不持续读满会撑满管道缓冲导致子进程
            # 阻塞（死锁隐患）；落文件既不阻塞子进程，又能在早失败时读到原因。
            stderr_file = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
            # 关键（2026-10-08 修，本次核心）：**不传 `-ConfigPath`**。
            # 原因：start.py 约定「显式传 -ConfigPath → allow_overlay=False」，
            # 此时即使设了 FAN_CONFIG_PATH 也会被忽略，主配置里留空的 serial.port
            # 无从补齐 → 子进程必然报 "serial.port is empty after overlay merge"
            # 退出码 1（实测复现）。改为不传该参数，让 start.py 走默认主配置路径 +
            # allow_overlay=True，再由 FAN_CONFIG_PATH 完成 overlay 深合并。
            # 注：config_path 仍保留在后端侧，用于 eventsPath 兜底推导与日志。
            child_env = dict(os.environ)
            # hardware/.env（可选）优先注入：现场可在不改代码的前提下指定解释器/overlay。
            # 进程环境变量仍可覆盖之（后者写法见下），保证「环境变量 > 文件」的直觉一致。
            for key, value in _read_hardware_env().items():
                child_env.setdefault(key, value)
            if overlay_path:
                child_env["FAN_CONFIG_PATH"] = overlay_path
            else:
                child_env.pop("FAN_CONFIG_PATH", None)
            proc = subprocess.Popen(
                [_PYTHON, start_script, "-RunId", run_id],
                stdout=subprocess.PIPE, stderr=stderr_file, text=True, encoding="utf-8",
                env=child_env,
            )

            # eventsPath 兜底：优先用 start.py stdout 的单行 launch JSON，但**不依赖它**——
            # 若 stdout 阻塞/解析失败，退化为按 config 目录推导 runs（config 在
            # hardware/v0.6/config/，其 parent.parent = hardware/v0.6，下即 runs/）。
            meta: dict = {}
            try:
                line = proc.stdout.readline() if proc.stdout else ""
                meta = json.loads(line) if line.strip() else {}
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("[fan-executor] 读 start.py stdout 失败（改用推导路径）：%s", e)
            events_path = meta.get("eventsPath") or meta.get("events_path")
            if not events_path:
                events_path = str(Path(config_path).resolve().parent.parent / "runs" / run_id / "events.jsonl")
                logger.info("[fan-executor] eventsPath 缺失，按 config 推导：%s", events_path)

            t_start = time.monotonic()
            last_seq = 0
            finish_seen_at: float | None = None  # 首见 run_finished 的时刻（给 summary 落盘窗口）
            while True:
                with self._lock:
                    should_stop = st.stop_requested
                    if st.status not in ("running", "stopping"):
                        break
                if should_stop:
                    # ⚠️ _request_stop 内部 subprocess.run 可能阻塞数秒~60s，
                    # 必须在锁外调用，否则会持锁阻塞所有 status/samples 读取。
                    self._request_stop(stop_script, run_id, config_path, meta)
                    with self._lock:
                        st.status = "stopped"
                        st.finished_at = time.monotonic()
                        st.terminal = True
                    break

                last_seq, seen_finish = self._drain_events(st, events_path, last_seq)
                if seen_finish and finish_seen_at is None:
                    finish_seen_at = time.monotonic()  # 首见 run_finished 的时间

                # 兜底①：优先按 summary 收敛（权威终态）
                if self._terminal_reached(st, meta):
                    break

                # 兜底②：脚本已收尾（见到 run_finished）→ 给 summary 2 秒落盘窗口；
                # 窗口过后 summary 仍不可读，则按事件流兜底判定（failed 也不折叠）。
                exited = proc.poll() is not None
                if finish_seen_at is not None and (time.monotonic() - finish_seen_at) > 2.0:
                    if self._terminal_from_events(st, events_path):
                        break
                if exited and finish_seen_at is not None:
                    # 进程已退出且事件流已收尾，但 summary 尚未落盘 → 按事件流判定
                    if self._terminal_from_events(st, events_path):
                        break
                if exited and proc.returncode not in (None, 0) and finish_seen_at is None:
                    # 进程非零退出且连收尾事件都没有：如实标失败，不假装停止。
                    # 连带透传后端捕获的 stderr 末行，让前端能看到真实原因（不美化）。
                    detail = self._read_captured_stderr(stderr_file) or self._read_script_stderr(meta, events_path)
                    with self._lock:
                        st.status = "failed"
                        st.error = (
                            f"脚本退出码 {proc.returncode} 且未产出收尾事件"
                            + (f"：{detail}" if detail else "")
                        )
                        st.finished_at = time.monotonic()
                        st.terminal = True
                    logger.warning("[fan-executor] run %s 进程退出码 %s 无收尾，按失败收敛", run_id, proc.returncode)
                    break

                # 兜底③：总超时（含脚本卡死场景），强制收敛
                if time.monotonic() - t_start > self.WATCH_TIMEOUT_S:
                    with self._lock:
                        st.status = "failed"
                        st.error = f"等待运行终态超时（>{int(self.WATCH_TIMEOUT_S)}s），脚本可能卡住"
                        st.finished_at = time.monotonic()
                        st.terminal = True
                    logger.warning("[fan-executor] run %s 等待终态超时，强制收敛为 failed", run_id)
                    break

                # 兜底④（早失败，2026-10-07 补）：启动 N 秒内既无事件流文件、进程也已退出，
                # 说明脚本启动即失败（如目录冲突/依赖缺失），不必等满 120s。
                # 读取脚本 stderr.log 原样透传（数据纪律：不美化、不编造），让前端快速可见。
                if (time.monotonic() - t_start > self.EARLY_FAIL_S
                        and not Path(events_path).is_file()
                        and proc.poll() is not None):
                    # 优先读后端自己捕获的 stderr（start.py 建目录前失败时 run 目录
                    # 里没有 stderr.log，只有这里才有真实原因）。
                    detail = self._read_captured_stderr(stderr_file) or self._read_script_stderr(meta, events_path)
                    with self._lock:
                        st.status = "failed"
                        st.error = (
                            f"硬件脚本启动后未产出事件流（退出码 {proc.returncode}）"
                            + (f"：{detail}" if detail else "；请查 runs/<run_id>/stderr.log")
                        )
                        st.finished_at = time.monotonic()
                        st.terminal = True
                    logger.warning("[fan-executor] run %s 早失败收敛：%s", run_id, st.error)
                    break

                time.sleep(1.0)
        except Exception as e:  # noqa: BLE001 - 后台线程须吞异常并落状态
            logger.exception("[fan-executor] real run %s 失败", run_id)
            with self._lock:
                st.status = "failed"
                st.error = str(e)
                st.terminal = True
        finally:
            # 释放后端捕获 stderr 的临时文件（无论正常收敛还是异常退出）
            if stderr_file is not None:
                try:
                    stderr_file.close()
                except OSError:
                    pass

    def _drain_events(self, st: FanRunState, events_path: str, last_seq: int) -> tuple[int, bool]:
        """读 events.jsonl 增量，把 capture_completed 映射成 sample。

        返回 (新的 last_seq, 是否见到 run_finished)。
        见到 run_finished 表示脚本软件层面已收尾（终态文件随后发布），
        供 _watch 做第②重兜底（无需依赖 summary 是否已落盘）。
        """
        seen_finish = False
        try:
            path = Path(events_path)
            if not path.is_file():
                return last_seq, seen_finish
            text = path.read_text(encoding="utf-8")
        except OSError:
            return last_seq, seen_finish
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            seq = ev.get("sequence")
            # 缺 sequence 的事件无法参与增量游标（无法判重），如实留痕后跳过。
            # 为什么不是静默 continue（2026-10-09 修）：静默丢事件会让「曲线缺一档」
            # 无从定位；至少留下告警，且只报一次（避免每轮轮询刷屏）。
            if not isinstance(seq, int):
                self._warn_missing_sequence(ev)
                continue
            if seq <= last_seq:
                continue
            last_seq = seq
            ev_type = ev.get("type")
            if ev_type == "run_finished":
                seen_finish = True
            # 记录 run 首事件时间作为 t_s 换算基准（只在第一次设置）
            if st.t0_utc is None:
                ev_data = ev.get("data") or {}
                t0 = ev.get("timestampUtc") or ev_data.get("startedUtc")
                if t0:
                    with self._lock:
                        st.t0_utc = t0
            if ev_type != "capture_completed":
                continue
            data = ev.get("data") or {}
            metrics = data.get("metrics") or {}
            # 原样映射 metrics，不加减数值；缺测保持 null + quality 原因
            started_t_s, finished_t_s = self._capture_t_s(st, data)
            # capture_id：用于前端按 id 取该次采集的真实时序波形（GET /captures/{id}）。
            # 由「cycle + duty + startedUtc」拼稳定 id，与 _save_profile_capture 的
            # 目录 tag 同源（tag = cycle0001_duty030_<时间戳>），因此可由 id 反推目录。
            capture_id = self._make_capture_id(data)
            sample = {
                "sequence": seq,
                "t_s": (started_t_s + finished_t_s) / 2.0 if started_t_s is not None and finished_t_s is not None else (started_t_s if started_t_s is not None else finished_t_s),
                "measurement_started_t_s": started_t_s,
                "measurement_finished_t_s": finished_t_s,
                "commanded_pwm_pct": data.get("commandedPwmPercent"),
                "voltage_v": self._metric(metrics, "voltage", "meanV"),
                "current_probe_v": self._metric(metrics, "current", "meanV"),
                "current_a": self._metric(metrics, "current", "meanCurrentA"),
                "measured_pwm_duty_pct": self._metric(metrics, "pwm", "dutyPercent"),
                "pwm_frequency_hz": self._metric(metrics, "pwm", "frequencyHz"),
                "rpm": self._metric(metrics, "tach", "rpm"),
                "quality": self._quality_from(metrics),
                "capture_id": capture_id,
            }
            with self._lock:
                st.samples.append(sample)
                st.next_sequence += 1
                # 缓存波形索引：capture_id → 该采集的真实 CSV 绝对路径（来自事件 artifacts）
                if capture_id:
                    st.captures[capture_id] = {
                        "capture_id": capture_id,
                        "cycle": data.get("cycle"),
                        "profile": data.get("profile"),
                        "commanded_pwm_pct": data.get("commandedPwmPercent"),
                        "artifacts": data.get("artifacts") or [],
                        "startedUtc": data.get("startedUtc"),
                        "finishedUtc": data.get("finishedUtc"),
                    }
        return last_seq, seen_finish

    def _warn_missing_sequence(self, ev: dict) -> None:
        """缺 sequence 的事件告警（按事件类型去重，避免每轮轮询刷屏）。"""
        ev_type = str(ev.get("type") or "(无 type)")
        if ev_type in self._warned_missing_seq:
            return
        self._warned_missing_seq.add(ev_type)
        logger.warning(
            "[fan-executor] 事件缺 sequence，已跳过（type=%s）；该事件无法参与增量游标，"
            "对应的采集点不会出现在趋势图中。",
            ev_type,
        )

    @staticmethod
    def _make_capture_id(data: dict) -> str | None:
        """由 capture 事件 data 生成稳定 capture_id（与落盘目录 tag 同源）。

        形如 `c1_d030_20261008T231937`：cycle + duty + startedUtc 去掉分隔符。
        生成不了（缺字段）返回 None —— 此时前端拿不到该点波形，如实置空，
        绝不编造 id 去猜文件。
        """
        cycle = data.get("cycle")
        duty = data.get("commandedPwmPercent")
        started = data.get("startedUtc")
        if cycle is None or duty is None or not started:
            return None
        stamp = str(started).replace("-", "").replace(":", "").replace("+00:00", "")
        stamp = stamp.replace("T", "T").split(".")[0]
        return f"c{int(cycle)}_d{int(duty)}_{stamp}"

    def _terminal_from_events(self, st: FanRunState, events_path: str) -> bool:
        """按事件流兜底判终态：summary 不可读时，用 run_finished 事件里的 state 收敛。

        不编造：只认事件流真实存在的 state（failed/completed/stopped），
        没有 run_finished 事件则返回 False（继续等 summary）。
        """
        try:
            text = Path(events_path).read_text(encoding="utf-8")
        except OSError:
            return False
        state = None
        err = ""
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "run_finished":
                data = ev.get("data") or {}
                state = data.get("state") or ev.get("state")
                err = data.get("failureMessage") or ""
        if not state:
            return False
        with self._lock:
            st.status = state if state in ("completed", "stopped", "failed") else "failed"
            if st.status == "failed" and err:
                st.error = err
            st.finished_at = time.monotonic()
            st.terminal = True
        logger.info("[fan-executor] run %s 终态按事件流收敛：state=%s", st.run_id, st.status)
        return True

    @staticmethod
    def _metric(metrics: dict, group: str, key: str) -> Any:
        g = metrics.get(group) or {}
        return g.get(key)

    def _capture_t_s(self, st: FanRunState, data: dict) -> tuple[float | None, float | None]:
        """真实 t_s：用 capture 的 startedUtc/finishedUtc 相对 run 首事件时间换算秒数。

        数据纪律：只用事件里真实存在的 UTC 时间戳，不编造时钟；解析失败保持 None，
        前端据此把该点标注为「时间未知」，绝不用假值填充横轴。
        """
        t0 = st.t0_utc
        if not t0:
            return None, None
        try:
            from datetime import datetime
            t0_dt = datetime.fromisoformat(t0.replace("Z", "+00:00"))
            out = []
            for key in ("startedUtc", "finishedUtc"):
                raw = data.get(key)
                if not raw:
                    out.append(None)
                    continue
                try:
                    dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                    out.append(round((dt - t0_dt).total_seconds(), 2))
                except (ValueError, TypeError):
                    out.append(None)
            return out[0], out[1]
        except (ValueError, TypeError):
            return None, None

    @staticmethod
    def _quality_from(metrics: dict) -> dict[str, Any]:
        q: dict[str, Any] = {}
        for grp, keys in (("voltage", "voltage"), ("current", "current"), ("tach", "rpm")):
            g = metrics.get(grp) or {}
            if not g.get("physicalProbeRatioConfirmed", False) and grp in ("voltage", "current"):
                q[keys] = "provisional_probe_ratio"
            if grp == "tach" and g.get("rpm") is None:
                q["rpm"] = "not_connected"
        if metrics.get("current") and metrics["current"].get("meanCurrentA") is None:
            q["current"] = "conversion_not_confirmed"
        return q

    @staticmethod
    def _read_captured_stderr(stderr_file: Any) -> str:
        """读后端捕获的子进程 stderr 末行（原样透传，不美化、不编造）。

        为什么需要：start.py 在「建运行目录之前」失败时（如配置校验不通过），
        运行目录尚不存在，runs/<id>/stderr.log 也就没有——只有后端自己捕获的
        这份 stderr 才有真实原因。读取失败一律返回空串（由调用方兜底其他来源）。
        """
        try:
            if stderr_file is None:
                return ""
            stderr_file.flush()
            stderr_file.seek(0)
            text = stderr_file.read() or ""
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            if lines:
                return lines[-1][:300]
        except (OSError, ValueError):
            pass
        return ""

    @staticmethod
    def _read_script_stderr(meta: dict, events_path: str) -> str:
        """早失败时读取脚本 stderr.log 末行作为可行动原因（原样透传，不美化）。

        stderr.log 与 events.jsonl 同目录（start.py 写 stdout.jsonl/stderr.log 到 run 目录）。
        """
        try:
            run_dir = meta.get("directory") or str(Path(events_path).parent)
            log = Path(run_dir) / "stderr.log"
            if log.is_file():
                lines = [ln.strip() for ln in log.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
                if lines:
                    return lines[-1][:300]
        except OSError:
            pass
        return ""

    def _request_stop(self, stop_script: str, run_id: str, _config_path: str, meta: dict) -> None:
        """调用 entrypoints/stop.py 写 stop.request（发 SET 0 等 ACK，不强制杀进程）。

        注：`_config_path` 保留形参以兼容调用方签名，但自 2026-10-08 起不再下传
        `-ConfigPath`（见下方说明，改由环境变量注入 overlay）。
        """
        directory = meta.get("directory", "")
        args = [_PYTHON, stop_script, "-RunId", run_id]
        if directory:
            args += ["-RunDirectory", directory]
        # 与启动保持一致（2026-10-08 修）：无 directory 时不传 -ConfigPath，
        # 改由 FAN_CONFIG_PATH 让 stop.py 走「默认路径 + allow_overlay=True」，
        # 否则同样会因显式 ConfigPath 禁用 overlay 而解析失败。
        child_env = dict(os.environ)
        for key, value in _read_hardware_env().items():
            child_env.setdefault(key, value)
        overlay_path = _resolve_overlay_path()
        if overlay_path:
            child_env["FAN_CONFIG_PATH"] = overlay_path
        else:
            child_env.pop("FAN_CONFIG_PATH", None)
        try:
            subprocess.run(
                args, capture_output=True, text=True, encoding="utf-8", timeout=60,
                env=child_env,
            )
        except subprocess.TimeoutExpired:
            logger.warning("[fan-executor] stop.py 超时，run %s", run_id)

    def _terminal_reached(self, st: FanRunState, meta: dict) -> bool:
        """以 summary.json 的 terminalPublished:true 判权威终态（如实，不提前判成功）。

        state 原样映射（completed/stopped/failed），**不再把 failed 折叠成 stopped**；
        failureMessage 透传到 st.error，供前端如实显示失败原因。
        summary 路径缺失时按 run_id 推导运行目录兜底（与 _watch 的 eventsPath 同规则）。
        """
        directory = meta.get("directory")
        summary_path = meta.get("summaryPath")
        if not summary_path:
            if directory:
                summary_path = os.path.join(directory, "summary.json")
            else:
                # meta 缺失（stdout 未解析出来）：按脚本目录 + run_id 推导
                summary_path = str(
                    Path(str(_DEFAULT_START_SCRIPT)).resolve().parent / "runs" / st.run_id / "summary.json"
                )
        try:
            summary = json.loads(Path(summary_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if summary.get("terminalPublished"):
            state = summary.get("state")
            with self._lock:
                # 原样映射；未知值保守落 failed（不伪装成正常停止）
                st.status = state if state in ("completed", "stopped", "failed") else "failed"
                if st.status == "failed":
                    st.error = summary.get("failureMessage") or st.error or "运行失败（未提供原因）"
                st.finished_at = time.monotonic()
                st.terminal = True
            logger.info("[fan-executor] run %s 终态按 summary 收敛：state=%s", st.run_id, st.status)
            return True
        return False


def get_executor() -> FanExecutor:
    """选择执行器：默认真实台架；显式 `FAN_EXECUTOR=sim` 才走模拟兜底。

    为什么默认 real 而非 sim：本系统以真实台架采集为目标，模拟仅是「无仪器联调」
    的开发兜底。默认 sim 会在有仪器时静默回退成合成数据，造成「图在动、风扇没转」
    的误导（实测踩过）。因此默认 real，模拟必须显式声明，杜绝静默降级。
    """
    mode = os.environ.get("FAN_EXECUTOR", "real").lower()
    if mode == "sim":
        return SimFanExecutor()
    return RealFanExecutor()


def make_run_id() -> str:
    """生成唯一 run_id（uuid hex，可拼 URL，与 runs.py 一致）。"""
    return uuid.uuid4().hex
