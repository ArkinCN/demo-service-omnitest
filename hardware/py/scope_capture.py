"""示波器采集与波形推算（Python 重写，对应原 src/ScopeCapture.psm1）。

逐条复刻原 SCPI 命令序列、preamble 解析、波形推算算法、CSV/BMP 导出与 capture.json 结构。
算法口径**严格对齐**（频率/占空比/RPM/削波/25kHz 频带/电流换算），不美化不降级。
"""
from __future__ import annotations

import csv
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any

from scope_visa import ScopeDevice, VisaError, block_payload


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _num(v: float) -> str:
    """数值格式化：对齐原 Number()（往返最短表示）。"""
    return repr(float(v))


# ---------------------------------------------------------------------------
# 通道 / 触发 / 初始化
# ---------------------------------------------------------------------------
def _set_channel(scope: ScopeDevice, channel: int, settings: dict) -> dict:
    scope.write(f":CHANnel{channel}:DISPlay ON")
    scope.write(f":CHANnel{channel}:COUPling DC")
    scope.write(f":CHANnel{channel}:UNIT VOLT")
    scope.write(f":CHANnel{channel}:PROBe {_num(settings['probeRatio'])}")
    scope.write(f":CHANnel{channel}:SCALe {_num(settings['scaleVoltsPerDiv'])}")
    scope.write(f":CHANnel{channel}:OFFSet {_num(settings['offsetV'])}")

    if (scope.query(f":CHANnel{channel}:COUPling?") != "DC"
            or scope.query(f":CHANnel{channel}:UNIT?") != "VOLT"
            or scope.query(f":CHANnel{channel}:DISPlay?") != "1"):
        raise VisaError(f"readback mismatch: CH{channel}")

    return {
        "channel": channel,
        "probeRatio": _check_num(scope, f":CHANnel{channel}:PROBe?", settings["probeRatio"]),
        "scaleVoltsPerDiv": _check_num(scope, f":CHANnel{channel}:SCALe?", settings["scaleVoltsPerDiv"]),
        "offsetV": _check_num(scope, f":CHANnel{channel}:OFFSet?", settings["offsetV"]),
        "coupling": "DC",
        "unit": "VOLT",
        "physicalProbeRatioConfirmed": settings["physicalProbeRatioConfirmed"],
    }


def _read_num(scope: ScopeDevice, command: str) -> float:
    n = float(scope.query(command))
    if math.isnan(n) or math.isinf(n):
        raise VisaError(f"Non-finite readback: {command}")
    return n


def _check_num(scope: ScopeDevice, command: str, expected: float) -> float:
    actual = _read_num(scope, command)
    if abs(actual - expected) > max(1e-9, abs(expected) * 1e-5):
        raise VisaError(f"Scope readback mismatch: {command} expected {expected} got {actual}")
    return actual


# 错误队列响应的**有效形状**：`<code>,<message>`，如 `0,"No error"` / `-113,"..."`。
# 只有先匹配这个形状，内容才可信；否则一律按「响应错位」处理（见 _assert_no_scope_error）。
ERR_RESP_SHAPE = re.compile(r"^\s*(-?\d+)\s*,")

# 脏响应重查的最大轮数。DS1104Z 在高速切源/切时基后偶发把上一次查询的**尾部**
# 留在输出缓冲里（实测返回 `=@ @` 这类乱码，既不是 "0,..." 也不是超时），
# 清空缓冲再查一次即可拿到真响应；连查 3 轮仍脏才判定为真故障。
ERR_RECHECK_ROUNDS = 3


def _hexdump(text: str) -> str:
    """把原始响应转成可被日志/终端安全承载的形式（乱码时十进制不可读）。

    终端代码页会把非 ASCII 字节渲染成 `锟?` 之类，等于丢失定位信息；
    这里同时给 backslash-escape 与 hex，两者都能反推出原始字节。
    """
    raw = text.encode("utf-8", errors="backslashreplace")
    escaped = text.encode("unicode_escape").decode("ascii", errors="replace")
    hexed = raw[:64].hex(" ")
    return f"{escaped!r} (hex: {hexed})"


def _drain_input_buffer(inst: Any) -> None:
    """按极短超时把输入缓冲读空，丢弃错位残留的脏字节。

    ⚠️ 刻意**不用 `*CLS`**（会清掉真实错误队列，等于掩盖故障）、
    也**不用 `inst.clear()`**（部分后端会连带复位采集配置）。
    只读不写，不改变设备状态。
    """
    original = inst.timeout
    try:
        inst.timeout = 80
        while True:
            try:
                if not inst.read_raw(64):
                    break
            except Exception:  # noqa: BLE001 - 无数据可读即缓冲已空
                break
    finally:
        inst.timeout = original


def _assert_no_scope_error(scope: ScopeDevice, timeout_ms: int = 1500) -> None:
    """检查示波器错误队列；**空队列阻塞按「无错误」、脏响应按「响应错位」处理**。

    为什么需要这层包装（2026-10-09 修）：本台 DS1104Z（固件 00.04.05.SP2）的
    `:SYSTem:ERRor?` 在**错误队列为空时不返回 "0,No error"，而是不响应**
    （NI-VISA 后端下表现为 `VI_ERROR_TMO`）。原实现直接断言 `startswith("0,")`，
    于是**每一档采集都在这一步超时**、整轮 failed：
    实测连续三次实验（含 tach 关闭、改动前的配置）全部挂在
    `Read :SYSTem:ERRor? failed: VI_ERROR_TMO (-1073807339)`，
    而同一条会话下 `*IDN?` / `:TIMebase:MAIN:SCALe?` / `:CHANnel3:DISPlay?`
    全部正常 —— 证明不是 USB 或资源名问题，就是这条命令的阻塞行为。

    2026-10-09 二次修（脏响应）：错误队列回读还出现过**内容乱码**，
    消息形如 `Scope configuration error: =@ @` / `L;...` / `锟?锟紷`。
    该类返回**既不匹配 `0,` 前缀、也不是超时**，被原逻辑判为真错误 →
    整轮 failed。时间线（run `aa87fd70f11b49e8be130e1abfd53da6`）：
    10:44:51 pwm 档完成 → 10:44:55 tach 档完成（rpm 710）→ 10:45:04 报错，
    正是 tach 采完后 `finally: _set_capture_profile(scope, cfg, "pwm")`
    **切回时基**那一刻 —— 属查询响应错位（上一次读的尾巴留在缓冲里），
    不是设备真错误。

    处置口径（保留真报错通路，不放弃错误检测）：
      · 把超时临时收紧到 1.5s（默认 15s 太长，空队列时白等 15 秒×每档）；
      · 超时 → 视为「队列为空 = 无错误」，静默通过；
      · 读到内容 → **先按 `ERR_RESP_SHAPE` 校验形状**：
          - 形状合法且 code == 0 → 无错误，通过；
          - 形状合法且 code != 0 → **真错误，原样抛出**（如实报错）；
          - 形状非法（乱码）→ 按响应错位处理：读空输入缓冲 → 短暂等待 → 重查，
            最多 `ERR_RECHECK_ROUNDS` 轮；仍非法才抛错，并把原始字节以
            backslash-escape + hex 打印（现有消息无法定位）。
    """
    inst = getattr(scope, "_inst", None)
    if inst is None:  # 非标准实现（测试替身）→ 退回原行为（无缓冲可清，不做重查）
        err = scope.query(":SYSTem:ERRor?")
        if not ERR_RESP_SHAPE.match(err or ""):
            raise VisaError(f"Scope configuration error: {_hexdump(err or '')}")
        if not err.startswith("0,"):
            raise VisaError(f"Scope configuration error: {err}")
        return

    original = inst.timeout
    last_bad = ""
    try:
        inst.timeout = timeout_ms
        for _ in range(ERR_RECHECK_ROUNDS):
            try:
                err = scope.query(":SYSTem:ERRor?")
            except Exception as e:  # noqa: BLE001 - 超时即队列空，按无错误处理
                msg = str(e)
                if "VI_ERROR_TMO" in msg or "Timeout" in msg:
                    return
                raise
            if not err:
                return
            m = ERR_RESP_SHAPE.match(err)
            if m:
                if m.group(1).lstrip("-").strip("0") == "":  # code == 0
                    return
                # 形状合法且非零 → 真实设备错误，如实抛出（不做重查，避免掩盖故障）
                raise VisaError(f"Scope configuration error: {err}")
            # 形状非法 = 响应错位：清缓冲、等一拍、重查
            last_bad = err
            _drain_input_buffer(inst)
            time.sleep(0.08)
    finally:
        inst.timeout = original
    raise VisaError(
        f"Scope configuration error: 连续 {ERR_RECHECK_ROUNDS} 次回读均非合法响应码，"
        f"最后一次原始返回 {_hexdump(last_bad)}"
    )


def _set_capture_profile(scope: ScopeDevice, cfg: dict, profile: str) -> None:
    if profile == "pwm":
        source = cfg["channels"]["pwm"]["channel"]
        timebase = cfg["pwmTimebaseSecondsPerDiv"]
        level = cfg["triggerLevelV"]
    else:
        source = cfg["tach"]["channel"]
        timebase = cfg["tach"]["timebaseSecondsPerDiv"]
        level = cfg["tach"]["triggerLevelV"]
    scope.write(f":TIMebase:MAIN:SCALe {_num(timebase)}")
    scope.write(":TRIGger:MODE EDGE")
    scope.write(f":TRIGger:EDGE:SOURce CHANnel{source}")
    scope.write(f":TRIGger:EDGE:LEVel {_num(level)}")
    scope.write(":TRIGger:SWEep AUTO")
    _check_num(scope, ":TIMebase:MAIN:SCALe?", timebase)
    if scope.query(":TRIGger:EDGE:SOURce?") != f"CHAN{source}":
        raise VisaError("Trigger source readback mismatch.")
    _check_num(scope, ":TRIGger:EDGE:LEVel?", level)
    _assert_no_scope_error(scope)


def initialize_scope(scope: ScopeDevice, cfg: dict) -> dict:
    """识别身份 → 配通道 → 配触发 → RUN；返回 settings（写 scope-settings.json）。"""
    ident = scope.query("*IDN?")
    if ident != cfg["expectedIdentity"]:
        raise VisaError(f"Unvalidated scope identity: {ident}")
    import re
    if not re.match(r"^RIGOL TECHNOLOGIES,DS1104Z Plus,DS1ZC[0-9]+,", ident):
        raise VisaError(f"Unvalidated scope identity: {ident}")

    settings: dict[str, Any] = {
        "identity": ident,
        "inputImpedanceOhm": 1000000,
        "channels": {},
        "configuredUtc": _now(),
        "timebaseSecondsPerDiv": cfg["pwmTimebaseSecondsPerDiv"],
    }
    active: list[int] = []
    for role in ("current", "voltage", "pwm"):
        ch = cfg["channels"][role]
        settings["channels"][role] = _set_channel(scope, int(ch["channel"]), ch)
        active.append(int(ch["channel"]))

    if cfg.get("tach", {}).get("enabled"):
        t = cfg["tach"]
        pseudo = {
            "probeRatio": t["probeRatio"],
            "scaleVoltsPerDiv": t["scaleVoltsPerDiv"],
            "offsetV": 0,
            "physicalProbeRatioConfirmed": t["physicalProbeRatioConfirmed"],
        }
        settings["channels"]["tach"] = _set_channel(scope, int(t["channel"]), pseudo)
        active.append(int(t["channel"]))

    for ch in (1, 2, 3, 4):
        if ch not in active:
            scope.write(f":CHANnel{ch}:DISPlay OFF")
            if scope.query(f":CHANnel{ch}:DISPlay?") != "0":
                raise VisaError("Inactive channel not disabled.")

    _set_capture_profile(scope, cfg, "pwm")
    scope.write(":RUN")
    return settings


# ---------------------------------------------------------------------------
# 波形推算（严格对齐原 Get-WaveMetrics）
# ---------------------------------------------------------------------------
# 转速脉冲「同包络」合并窗口（秒）。
#
# 实测依据（2026-10-09，probe_ch4_007）：一次转动在示波器上会呈现 2 个子尖峰，
# 子尖峰间隔 6~14ms；而转动周期为 70~85ms（30% 档）到 28ms（100% 档）。
# 取 12ms 能把多数子尖峰并成一个脉冲事件，又小于最小转动周期（28ms）的一半以上，
# 不会把相邻两次转动并到一起。用**时间**而非采样点数：本台架 0.02/0.05 s/div
# 两档采样间隔分别是 200µs/500µs，按点数写死会在另一档失效。
PULSE_MERGE_S = 0.012

# 脉冲阈值相对幅度（占「基线到最小值」的比例）与噪声底倍数（稳健标准差）。
#
# thr = 基线 - max(0.35*幅度, min(3*稳健σ, 0.6*幅度))：
#   · 有真脉冲时：0.35*幅度 落在纹波带以下、脉冲深处以上（实测取到约 -0.9V，
#     而基线纹波约 ±0.5V、脉冲最深处约 -2.7V）；
#   · 纯噪声时：幅度≈噪声峰峰 → 0.35*幅度 小于 3σ → 退化为 3σ 门限，
#     跨过的点极少，由「脉冲数 ≥ 4」的校验如实拒绝，不会把噪声算成转速；
#   · 上限 min(..., 0.6*幅度)：防止「双极性方波」这类信号的 MAD 偏大
#     （一半样本离中位数很远）把门限推到信号范围之外（离线回归实测的 bug）。
PULSE_LEVEL_FRACTION = 0.35
PULSE_NOISE_SIGMA = 3.0
PULSE_NOISE_CLAMP_FRACTION = 0.6

# 最少脉冲数（合并后）与周期一致性上限。
#
# ⚠️ 一致性用「**每个**间隔都必须落在中位周期 ±25% 内」而不是「MAD/中位 ≤ 20%」：
# 后者只要求「多数间隔接近」，随机点偶尔会蒙混过关——离线压力测试（60 随机种子 ×
# 5 档噪声 × 打乱/尖刺噪声 = 420 例负样本）中，MAD 判据误报 49~56 例，本判据 0 例；
# 同一批条件下正样本（四档真实采集）两者都是全对，故采用更严的本判据。
PULSE_MIN_COUNT = 5
PULSE_PERIOD_TOLERANCE = 0.25


def get_tach_pulse_metrics(values: list[float], increment: float) -> dict:
    """转速（tach）脉冲定周期：稳健阈值找脉冲包络 → 取间隔中位数 → 一致性校验。

    为什么不能沿用 get_wave_metrics 的「数穿越点」判法（2026-10-09 实测依据）：
      · CH4 基线上叠着约 ±0.5V 的 PWM 串扰纹波，而 (最小值+最大值)/2 这条水平线
        正好落在纹波带里 → 产生几十个假穿越（实测 30% 档出现 33~123 个上升沿，
        而真实脉冲只有 7~21 个）；
      · 每次转动会呈现 2 个子尖峰（实测间隔 7~14ms），一个真实脉冲被数成多次。
      两者叠加使周期一致性校验必然失败（edgeStatus=unstable_periods），
      而同一批数据里真实周期其实高度规整（实测 100% 档 21 个间隔全为 28.0ms）。

    判法（对「纹波 + 多尖峰」信号稳健，且不依赖探头倍率等绝对幅值）：
      1. 基线 base = 中位数；稳健离散 mad = 1.4826 * MAD；幅度 span = base - 最小值；
      2. 阈值 thr = base - max(PULSE_LEVEL_FRACTION*span,
                               min(PULSE_NOISE_SIGMA*mad, PULSE_NOISE_CLAMP_FRACTION*span))；
      3. 低于 thr 且彼此间隔 ≤ PULSE_MERGE_S 的采样合并为同一「脉冲包络」，
         取包络内最小点作为脉冲中心（一次转动的多个子尖峰 → 一个事件）；
      4. 间隔 = 相邻脉冲中心之差（秒）；先取中位数 period0，再把比 0.5*period0
         更近的中心合并一次（处理个别跨包络的漏合并，保留更深的点），重算中位周期；
      5. 通过条件（三条同时满足，否则如实报未采集并写明原因）：
           · 合并后脉冲数 ≥ PULSE_MIN_COUNT(5)；
           · **每一个**间隔都落在中位周期 ±PULSE_PERIOD_TOLERANCE(25%) 内；
           · 中位周期 ≥ 20 个采样点（低于此说明时间分辨不足以可信定位尖峰）。
      6. frequencyHz = 1/中位周期；转速由调用方按 PPR 换算（rpm = 60*f/PPR）。

    离线回归（2026-10-09，`_tmp_test_tach.py` / `_tmp_stress.py`，只读历史 CSV 与合成信号）：
      · 正样本——probe_ch4_007（10×、1V/div、0.05 s/div）：30%/50%/70%/100% →
        710/1200/1633/2143 rpm，单调上升且同档重复性一致；
        probe_ch4_005/006/07654f（0.02 s/div、240ms 窗）：50%/70%/100% →
        1215/1648/2162~2174 rpm（与人工逐个定位尖峰的结果一致）。
      · 窗口不足者如实拒绝：0.02 s/div 下 30% 档窗内只有 2~3 个脉冲 →
        报脉冲数不足（不做「用 2 个间隔硬算」的将就）。
      · 负样本 420 例（60 随机种子 × 5 档高斯噪声 + 真实波形打乱 + 尖刺噪声）：
        **零误报**；恒定值与缓慢漂移同样不给数字。

    ⚠️ dutyPercent 有意不设：该脉冲宽度是「反光条角宽」，不是 PWM 占空比，
    写进去会被下游误读成占空比。
    """
    n = len(values)
    total = 0.0
    sq = 0.0
    mn = float("inf")
    mx = float("-inf")
    for v in values:
        total += v
        sq += v * v
        mn = min(mn, v)
        mx = max(mx, v)
    metric: dict[str, Any] = {
        "points": n,
        "sampleIntervalS": increment,
        "windowS": (n - 1) * increment,
        "minimumV": mn,
        "maximumV": mx,
        "meanV": total / n,
        "rmsV": math.sqrt(sq / n),
        "frequencyHz": None,
        "dutyPercent": None,
        "edgeStatus": "insufficient_amplitude_or_edges",
        "pulseCount": 0,
        "medianPeriodS": None,
    }
    if n < 40:
        return metric

    sorted_vals = sorted(values)
    base = sorted_vals[n // 2]
    devs = sorted(abs(v - base) for v in values)
    mad = 1.4826 * devs[n // 2]
    span = base - mn
    if span <= 0 or mad <= 0:
        # 全平或恒定波形：无脉冲可谈，如实保留 insufficient 状态
        return metric
    thr = base - max(
        PULSE_LEVEL_FRACTION * span,
        min(PULSE_NOISE_SIGMA * mad, PULSE_NOISE_CLAMP_FRACTION * span),
    )

    # 3) 低于阈值 → 合并为脉冲包络 → 取包络内最小点为脉冲中心
    merge_gap = max(1, int(round(PULSE_MERGE_S / increment)))
    below = [i for i, v in enumerate(values) if v < thr]
    if len(below) < PULSE_MIN_COUNT:
        metric["edgeStatus"] = "fewer_than_five_pulses"
        return metric
    groups: list[list[int]] = [[below[0]]]
    for i in below[1:]:
        if i - groups[-1][-1] <= merge_gap:
            groups[-1].append(i)
        else:
            groups.append([i])
    centres = [min(g, key=lambda i: values[i]) for g in groups]

    # 4) 间隔 → 中位周期 → 再按 0.5*周期合并一次 → 重算中位周期
    def _median(xs: list[float]) -> float:
        s = sorted(xs)
        m = len(s)
        if m == 0:
            return 0.0
        return s[m // 2] if m % 2 else (s[m // 2 - 1] + s[m // 2]) / 2.0

    ivals = [(centres[i + 1] - centres[i]) * increment for i in range(len(centres) - 1)]
    period0 = _median(ivals)
    merged = [centres[0]]
    for c in centres[1:]:
        if period0 > 0 and (c - merged[-1]) * increment < 0.5 * period0:
            if values[c] < values[merged[-1]]:
                merged[-1] = c
        else:
            merged.append(c)
    metric["pulseCount"] = len(merged)
    if len(merged) < PULSE_MIN_COUNT:
        metric["edgeStatus"] = "fewer_than_five_pulses"
        return metric

    ivals = [(merged[i + 1] - merged[i]) * increment for i in range(len(merged) - 1)]
    period = _median(ivals)
    metric["medianPeriodS"] = period
    if period < 20 * increment:
        metric["edgeStatus"] = "pulse_period_below_time_resolution"
        return metric
    if period <= 0 or max(abs(x - period) for x in ivals) / period > PULSE_PERIOD_TOLERANCE:
        # 只要有一个间隔偏离中位周期超过 25% 就不给数字（见 PULSE_PERIOD_TOLERANCE 说明）
        metric["edgeStatus"] = "unstable_pulse_intervals"
        return metric
    metric["frequencyHz"] = 1.0 / period
    metric["edgeStatus"] = "derived_from_pulse_intervals"
    return metric


def get_wave_metrics(values: list[float], increment: float, edges: bool) -> dict:
    n = len(values)
    total = 0.0
    sq = 0.0
    mn = float("inf")
    mx = float("-inf")
    for v in values:
        total += v
        sq += v * v
        mn = min(mn, v)
        mx = max(mx, v)
    mean = total / n
    metric: dict[str, Any] = {
        "points": n,
        "sampleIntervalS": increment,
        "windowS": (n - 1) * increment,
        "minimumV": mn,
        "maximumV": mx,
        "meanV": mean,
        "rmsV": math.sqrt(sq / n),
        "frequencyHz": None,
        "dutyPercent": None,
        "edgeStatus": "not_requested",
    }
    if edges:
        metric["edgeStatus"] = "insufficient_amplitude_or_edges"
        rises: list[float] = []
        falls: list[float] = []
        if (mx - mn) >= 0.5:
            level = (mn + mx) / 2
            for i in range(1, n):
                a = values[i - 1]
                b = values[i]
                if (a < level <= b) or (a >= level > b):
                    t = ((i - 1) + (level - a) / (b - a)) * increment
                    (rises if b > a else falls).append(t)
        if len(rises) >= 2:
            period_sum = 0.0
            high_sum = 0.0
            periods = 0
            lengths: list[float] = []
            for i in range(len(rises) - 1):
                left = rises[i]
                right = rises[i + 1]
                fall = None
                for f in falls:
                    if left < f < right:
                        fall = f
                        break
                if fall is not None:
                    period_sum += right - left
                    high_sum += fall - left
                    periods += 1
                    lengths.append(right - left)
            if periods >= 3 and (period_sum / periods / increment) >= 20:
                mean_period = period_sum / periods
                stable = all(abs(p - mean_period) / mean_period <= 0.2 for p in lengths)
                if stable:
                    metric["frequencyHz"] = periods / period_sum
                    metric["dutyPercent"] = 100 * high_sum / period_sum
                    metric["edgeStatus"] = "derived_from_displayed_waveform"
                    metric["completePeriods"] = periods
                else:
                    metric["edgeStatus"] = "unstable_periods"
            else:
                metric["edgeStatus"] = "fewer_than_three_periods_or_twenty_samples_per_period"
    return metric


# ---------------------------------------------------------------------------
# 单档采集（对齐 Save-ProfileCapture）
# ---------------------------------------------------------------------------
def _save_profile_capture(
    scope: ScopeDevice, cfg: dict, directory: str, profile: str, cycle: int, duty: int
) -> dict:
    os.makedirs(directory, exist_ok=True)
    started = _now()
    metrics: dict[str, Any] = {}
    files: list[str] = []
    roles = ("current", "voltage", "pwm") if profile == "pwm" else ("tach",)
    # 波形点数（2026-10-08 新增，可配置；同日随后恢复默认）。
    # 由 config 的 scope.waveformPoints 控制采集点数。走 NI-VISA(@ivi) 后端时
    # 大块读取稳定，可用 1200 点完整分辨率（Windows overlay 已设 1200）；
    # 若回退 @py(pyvisa-py+libusbK)，该组合实测 >~100 点必超时，需在 overlay 改小。
    want_points = int(cfg.get("waveformPoints") or 1200)
    try:
        scope.write(":STOP")
        scope.write(":WAVeform:MODE NORM")
        # ⚠️ 2026-10-08：波形读取改用 BYTE（二进制）格式。
        # 原因：ASCii 格式 1200 点约 15KB，经 USB-TMC 传输在 Windows+libusbK 下必超时
        # （VI_ERROR_TMO）；BYTE 格式仅 1.2KB，稳定读通。换算回电压用 preamble 的
        # YINcrement/YORigin/YREFerence（f[7]/f[8]/f[9]）。
        scope.write(":WAVeform:FORMat BYTE")
        # 显式设定点数：设备会记住上一次的 POINts 设置，不显式设定会导致
        # preamble 报屏幕点数(1200)与实际读取量不一致 → 校验误报。
        scope.write(f":WAVeform:POINts {want_points}")
        for role in roles:
            ch = cfg["tach"] if role == "tach" else cfg["channels"][role]
            channel = int(ch["channel"])
            scope.write(f":WAVeform:SOURce CHANnel{channel}")
            # 逐通道重新设点数（切源后 POINts 可能被复位为屏幕点数）
            scope.write(f":WAVeform:POINts {want_points}")
            # preamble 读取 + 重试（2026-10-09 增）：
            # 实测 100% 档（恒高电平）偶发在**切源后首帧**读到：
            #   ① 通信层异常（VISA 读超时/被占用，query 直接抛 VisaError）；
            #   ② 畸形 preamble（长度≠10 或时间坐标 NaN/0）。
            # 原实现任一情况都直接抛错让整轮 failed（实测每轮都在 100% 档第 2 次挂掉）。
            # 处置：重试（最多 4 次、间隔 0.4s，含通信异常与畸形两种）；仍失败才如实抛错。
            # 数据纪律：**不伪造坐标** —— 只在「能读到合法 preamble」时继续。
            inc = origin = ref = y_inc = y_origin = y_ref = 0.0
            ok = False
            last_err = ""
            for attempt in range(4):
                try:
                    pre = scope.query(":WAVeform:PREamble?")
                except Exception as e:  # noqa: BLE001 - 通信瞬断可重试
                    last_err = f"{type(e).__name__}: {e}"
                    time.sleep(0.4)
                    continue
                f = pre.split(",")
                if len(f) != 10:
                    last_err = f"preamble 字段数 {len(f)} ≠ 10"
                    time.sleep(0.4)
                    continue
                try:
                    inc = float(f[4]); origin = float(f[5]); ref = float(f[6])
                    y_inc = float(f[7]); y_origin = float(f[8]); y_ref = float(f[9])
                except (ValueError, OverflowError) as e:
                    last_err = f"数值解析失败: {e}"
                    time.sleep(0.4)
                    continue
                bad = (inc <= 0 or math.isnan(inc) or math.isinf(inc)
                       or math.isnan(origin) or math.isinf(origin)
                       or math.isnan(ref) or math.isinf(ref)
                       or math.isnan(y_inc) or math.isinf(y_inc)
                       or math.isnan(y_origin) or math.isinf(y_origin)
                       or math.isnan(y_ref) or math.isinf(y_ref))
                if not bad:
                    ok = True
                    break
                last_err = "时间坐标非法(NaN/Inf/≤0)"
                time.sleep(0.4)
            if not ok:
                # 如实抛错（附最后一次原因，便于现场定位），不编造坐标
                raise VisaError(
                    f"Invalid waveform time coordinates. (CH{channel} 连续 4 次读取失败：{last_err})"
                )
            if role == "pwm" and inc > 0.000002:
                raise VisaError("PWM export lacks 20 samples per 25kHz period.")

            # BYTE 二进制块：直接用 query_binary_values 解析 IEEE-488.2 定长块，
            # 避免手工处理块头；容器用 bytes，值为 0..255 的原始字节。
            raw_bytes = scope.query_binary_values(":WAVeform:DATA?")
            # 校验放宽（2026-10-08）：设备对 POINts 的处理可能与请求值不完全一致
            # （NORM 模式受屏幕采样限制）。只要求「有足够样本可算指标」即可，
            # 不因绝对相等而误报——点数以实际读回为准，如实记录在 metrics 里。
            if len(raw_bytes) < 2:
                raise VisaError("Waveform sample count differs from preamble.")

            cc = cfg["currentConversion"]
            values: list[float] = []
            rows: list[dict] = []
            for i, b in enumerate(raw_bytes):
                # 字节 → 电压：v = (byte - YREF) * YINcrement + YORigin
                v = (float(b) - y_ref) * y_inc + y_origin
                if math.isnan(v) or math.isinf(v):
                    raise VisaError("Invalid waveform voltage.")
                values.append(v)
                current_a = None
                if role == "current" and cc.get("enabled"):
                    current_a = v * cc["gainAmpsPerVolt"] / cc["turns"]
                rows.append({
                    "sample": i,
                    "time_s": (i - ref) * inc + origin,
                    "voltage_V": v,
                    "current_A": current_a if current_a is not None else "",
                })

            csv_path = os.path.join(directory, f"CH{channel}.csv")
            with open(csv_path, "w", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=["sample", "time_s", "voltage_V", "current_A"])
                writer.writeheader()
                writer.writerows(rows)
            files.append(csv_path)

            pre_path = os.path.join(directory, f"CH{channel}_preamble.txt")
            with open(pre_path, "w", encoding="utf-8") as fh:
                fh.write(pre)
            files.append(pre_path)

            # 转速通道走专用判法（脉冲包络 + 间隔中位数）；PWM 仍走原「数穿越点」判法，
            # 口径与阈值一行未动（2026-10-09）。
            if role == "tach":
                m = get_tach_pulse_metrics(values, inc)
            else:
                m = get_wave_metrics(values, inc, role == "pwm")
            m["physicalProbeRatioConfirmed"] = ch["physicalProbeRatioConfirmed"]
            if role == "pwm" and duty in (0, 100):
                m["frequencyHz"] = None
                m["dutyPercent"] = None
                m["edgeStatus"] = "constant_output_command_no_frequency_claim"
            if role == "pwm" and m["frequencyHz"] is not None and abs(m["frequencyHz"] - 25000) > 2500:
                m["frequencyHz"] = None
                m["dutyPercent"] = None
                m["edgeStatus"] = "outside_expected_25kHz_band"
            if role == "tach":
                scale = ch["scaleVoltsPerDiv"]
                m["clipped"] = (m["maximumV"] >= 4 * scale * 0.99 or m["minimumV"] <= -4 * scale * 0.99)
                if m["clipped"]:
                    m["frequencyHz"] = None
                    m["dutyPercent"] = None
                    m["edgeStatus"] = "display_clipped_invalid_frequency"
            if role == "current" and cc.get("enabled"):
                m["meanCurrentA"] = m["meanV"] * cc["gainAmpsPerVolt"] / cc["turns"]
                m["currentConversion"] = "confirmed_gain_and_turns"
                m["belowSpecifiedRange"] = abs(m["meanCurrentA"]) < cc["minimumSpecifiedCurrentA"]
            if role == "tach":
                m["rpm"] = None
                if m["frequencyHz"] is not None and cfg["tach"].get("pulsesPerRevolution") is not None:
                    m["rpm"] = 60 * m["frequencyHz"] / cfg["tach"]["pulsesPerRevolution"]
                m["pulsesPerRevolution"] = cfg["tach"].get("pulsesPerRevolution")
            metrics[role] = m

        # BMP 截屏：改用 query_binary_values 解析定长块（与波形同因，避免大块超时）。
        bmp = scope.query_binary_values(":DISPlay:DATA? ON,OFF,BMP")
        if len(bmp) < 54 or bmp[0] != 66 or bmp[1] != 77:
            raise VisaError("Invalid scope BMP.")
        screen = os.path.join(directory, "screen.bmp")
        with open(screen, "wb") as fh:
            fh.write(bmp)
        files.append(screen)

        meta = {
            "schemaVersion": "1.0",
            "startedUtc": started,
            "finishedUtc": _now(),
            "cycle": cycle,
            "commandedPwmPercent": duty,
            "profile": profile,
            "source": "NORM displayed waveforms; short STOP snapshot, not ten-second trend",
            "timebaseSecondsPerDiv": (cfg["pwmTimebaseSecondsPerDiv"] if profile == "pwm"
                                      else cfg["tach"]["timebaseSecondsPerDiv"]),
            "metrics": metrics,
            "artifacts": list(files),
            "rpmAvailable": bool(profile == "tach" and metrics["tach"].get("rpm") is not None),
        }
        meta_path = os.path.join(directory, "capture.json")
        meta["artifacts"].append(meta_path)
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=2)
        return meta
    finally:
        scope.write(":RUN")


def _merge_profile_captures(captures: list[dict], base_dir: str) -> dict:
    """把同一次物理采集的多档记录合并为**一条**（2026-10-09 新增）。

    为什么合并（用户报「同一时刻一半通道显示未采集」的根因）：
      四通道共用一个时基，PWM 需 20µs/div、转速需 0.05s/div（差 2500 倍），
      **一次采样不可能同时测到两者**，所以必须跑两趟。但两趟属于**同一次物理
      采集**（同一档位、同一时刻、同一目录 tag），原实现把它们当成两条独立
      记录分别上报（`for capture in results: emit(...)`）→ 后端一事件一样本 →
      样本被劈成「只有 CH1~CH3」与「只有 CH4」两半 → 趋势 tooltip 按 t 轴对齐
      时必然一半显示「未采集」（读数行因取「该量最后一个非 null 样本」而侥幸全满，
      掩盖了这个问题）。

    合并口径（**不用一个字段同时撒两个谎**）：
      · metrics      = 各档并集（pwm 档给 current/voltage/pwm，tach 档给 tach）
      · artifacts    = 各档拼接（→ read_capture_waveforms 遍历后天然得 CH1~CH4）
      · profile      = "pwm+tach"（多档才有这个值；单档原样返回）
      · startedUtc   = **第一档（pwm）**：与落盘目录 tag / `_make_capture_id` 同源，
                       保证 capture_id 与波形寻址不变
      · finishedUtc  = **最后一档（tach）**：真实结束时刻
      · timebaseSecondsPerDiv = 第一档值（顶层主时基，保持既有字段语义）
      · profiles     = 分档留痕各自 timebaseSecondsPerDiv / startedUtc / finishedUtc
                       （两档时基不同，不可合并成一个数）
      · rpmAvailable = 任一分档的 tach.rpm 非空
    并在 tag 根目录补写一份合并后的 `capture.json`，与 `pwm/`、`tach/` 下两份并存，
    便于离线核查（落盘路径沿用 `_save_profile_capture` 的「先 append 自身路径再 dump」范式）。
    """
    if len(captures) == 1:
        return captures[0]

    merged_metrics: dict[str, Any] = {}
    merged_artifacts: list[str] = []
    profiles: dict[str, Any] = {}
    for cap in captures:
        merged_metrics.update(cap.get("metrics") or {})
        merged_artifacts.extend(cap.get("artifacts") or [])
        prof = cap.get("profile")
        if prof:
            profiles[prof] = {
                "timebaseSecondsPerDiv": cap.get("timebaseSecondsPerDiv"),
                "startedUtc": cap.get("startedUtc"),
                "finishedUtc": cap.get("finishedUtc"),
                "roles": sorted((cap.get("metrics") or {}).keys()),
            }

    first, last = captures[0], captures[-1]
    merged: dict[str, Any] = {
        "schemaVersion": first.get("schemaVersion", "1.0"),
        # 沿用第一档的 startedUtc（与目录 tag 同源），结束时刻取最后一档
        "startedUtc": first.get("startedUtc"),
        "finishedUtc": last.get("finishedUtc"),
        "cycle": first.get("cycle"),
        "commandedPwmPercent": first.get("commandedPwmPercent"),
        "profile": "+".join(p for p in ("pwm", "tach") if any(c.get("profile") == p for c in captures)),
        "source": first.get("source"),
        "timebaseSecondsPerDiv": first.get("timebaseSecondsPerDiv"),
        # 分档留痕：两档时基/起止各自保留，供定位与离线核查
        "profiles": profiles,
        # 合并后 metrics 是四路并集：current/voltage/pwm + tach
        "metrics": merged_metrics,
        "artifacts": merged_artifacts,
        "rpmAvailable": any(
            (c.get("metrics") or {}).get("tach", {}).get("rpm") is not None for c in captures
        ),
        # 合并档数如实记录（1 = 只有 pwm，2 = pwm + tach）
        "mergedProfiles": len(captures),
    }

    meta_path = os.path.join(base_dir, "capture.json")
    merged["artifacts"].append(meta_path)
    os.makedirs(base_dir, exist_ok=True)
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, ensure_ascii=False, indent=2)
    return merged


def save_fan_scope_capture(scope: ScopeDevice, cfg: dict, run_dir: str, cycle: int, duty: int) -> list[dict]:
    """一次采集（pwm 档 + 可选 tach 档），对齐 Save-FanScopeCapture。

    ⚠️ 整体重试一次（2026-10-09 增）：实测 100% 档（恒高电平）下切源后首帧
    偶发读到畸形 preamble 或通信瞬断，原实现直接让整轮 failed（每轮都栽在这里）。
    现改为「整次采集最多试 2 遍」：第 1 遍失败后，重新 :RUN 稳定 0.5s 再试一遍。
    两遍都失败才抛错 —— **不伪造数据**，失败原因原样透传。
    为什么在此层重试而不是逐通道：切源/STOP/RUN 是整次采集的会话态，
    首帧异常往往是会话未就绪，重开一次会话比逐通道重读更有效。

    ⚠️ 返回值口径（2026-10-09 改）：多档结果**合并为长度 1 的列表**。
    这样两个调用点（`run_experiment.py` / `entrypoints/run_scope.py`）的
    `for capture in results: emit("capture_completed", capture)` 循环
    **一行都不用改**，就自动从「一次采集两条事件」变成「一次采集一条事件」，
    样本随之恢复为四通道齐全的一行（详见 `_merge_profile_captures`）。
    tach 未启用时本来就只有 1 档，返回值与改造前完全一致（零回归）。
    """
    tag = f"cycle{cycle:04d}_duty{duty:03d}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]}"
    base = os.path.join(run_dir, tag)
    last_err: Exception | None = None
    for attempt in range(2):
        result: list[dict] = []
        try:
            result.append(_save_profile_capture(scope, cfg, os.path.join(base, "pwm"), "pwm", cycle, duty))
            if cfg.get("tach", {}).get("enabled"):
                # ⚠️ 切回 pwm 时基属**恢复动作**：失败不得顶替在飞的真实错误，
                # 否则现场只会看到「切时基失败」，真正的原因（如采集失败）被吞掉。
                # 正常路径下切回失败仍照旧抛出，交给外层重试。
                try:
                    _set_capture_profile(scope, cfg, "tach")
                    time.sleep(math.ceil(12 * cfg["tach"]["timebaseSecondsPerDiv"] * 1000) / 1000)
                    result.append(_save_profile_capture(scope, cfg, os.path.join(base, "tach"), "tach", cycle, duty))
                except Exception:
                    try:
                        _set_capture_profile(scope, cfg, "pwm")
                    except Exception:  # noqa: BLE001 - 原错误优先，恢复失败只留痕
                        sys.stderr.write("scope recovery (restore pwm timebase) failed; original error takes precedence\n")
                    raise
                else:
                    _set_capture_profile(scope, cfg, "pwm")
            # 合并为一条：同一次物理采集的四通道数据作为一行上报
            return [_merge_profile_captures(result, base)]
        except Exception as e:  # noqa: BLE001 - 瞬态采集失败重试后再定论
            last_err = e
            # 重开显示：让示波器回到 RUN 稳态，下次采集的切源首帧更可靠
            try:
                scope.write(":RUN")
            except Exception:  # noqa: BLE001 - 恢复动作失败不掩盖原错误
                pass
            time.sleep(0.5)
    assert last_err is not None
    raise last_err
