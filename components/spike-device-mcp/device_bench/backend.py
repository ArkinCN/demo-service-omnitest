"""SSH 后端与 mock 后端。

真实后端用 paramiko 连台架 Windows 工控机；连不上时自动降级成 mock，
返回合成数据，并且**每一条返回都带 mode 字段**，mock 绝不冒充真实。
"""
from __future__ import annotations

import math
import random
import threading
import time
from dataclasses import dataclass
from typing import Literal

import paramiko

from . import config

Mode = Literal["live", "mock", "unknown"]


@dataclass
class ExecResult:
    cmd: str
    rc: int
    out: str
    err: str
    elapsed_ms: int
    mode: Mode


class BenchBackend:
    """一条到台架机的 SSH 会话，带自动降级。

    线程安全：所有对 paramiko 客户端的使用都在一把锁里，
    因为桥和 MCP server 可能并发调用。
    """

    def __init__(self, device: config.DeviceConfig, allow_mock: bool = True) -> None:
        self.device = device
        self.allow_mock = allow_mock
        self._lock = threading.RLock()
        self._client: paramiko.SSHClient | None = None
        self._mode: Mode = "unknown"   # 没连过就是 unknown，不假装自己是 mock
        self._last_error: str | None = None
        self._connected_at: float | None = None
        self._hostname: str | None = None
        self._mock_t0 = time.time()

    # ---------- 状态 ----------

    @property
    def mode(self) -> Mode:
        return self._mode

    @property
    def connected(self) -> bool:
        with self._lock:
            if self._client is None:
                return False
            tr = self._client.get_transport()
            return bool(tr and tr.is_active())

    def snapshot(self) -> dict:
        return {
            "device_id": self.device.id,
            "name": self.device.name,
            "model": self.device.model,
            "kind": self.device.kind,
            "target": f"{self.device.user}@{self.device.host}:{self.device.port}",
            "connected": self.connected,
            "mode": self._mode,
            "hostname": self._hostname,
            "connected_at": self._connected_at,
            "uptime_s": round(time.time() - self._connected_at, 1) if self._connected_at else None,
            "last_error": self._last_error,
            "key_env": self.device.key_env,
            "key_present": bool(self.device.key_path),
        }

    # ---------- 连接 ----------

    def connect(self, force_mock: bool = False) -> dict:
        with self._lock:
            self.disconnect()
            if force_mock:
                self._mode = "mock"
                self._last_error = "force_mock=true，调用方明确要求 mock"
                self._connected_at = time.time()
                self._hostname = "MOCK-BENCH"
                return self.snapshot()

            key_path = self.device.key_path
            if not key_path:
                return self._degrade(f"私钥环境变量 {self.device.key_env} 未设置")

            try:
                cli = paramiko.SSHClient()
                cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                cli.connect(
                    hostname=self.device.host,
                    port=self.device.port,
                    username=self.device.user,
                    key_filename=key_path,
                    timeout=config.SSH_CONNECT_TIMEOUT,
                    banner_timeout=config.SSH_CONNECT_TIMEOUT,
                    auth_timeout=config.SSH_CONNECT_TIMEOUT,
                    look_for_keys=False,
                    allow_agent=False,
                )
                self._client = cli
                self._mode = "live"
                self._last_error = None
                self._connected_at = time.time()
                r = self._exec_live("hostname")
                self._hostname = r.out.strip() or None
                return self.snapshot()
            except Exception as exc:  # noqa: BLE001 — 任何失败都降级并如实记录
                return self._degrade(f"{type(exc).__name__}: {exc}")

    def _degrade(self, reason: str) -> dict:
        self._client = None
        self._last_error = reason
        if not self.allow_mock:
            self._mode = "live"
            self._connected_at = None
            self._hostname = None
            raise RuntimeError(f"SSH 连接失败且未允许 mock：{reason}")
        self._mode = "mock"
        self._connected_at = time.time()
        self._hostname = "MOCK-BENCH"
        return self.snapshot()

    def disconnect(self) -> dict:
        with self._lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception:  # noqa: BLE001
                    pass
            self._client = None
            self._connected_at = None
            self._hostname = None
            return self.snapshot()

    def ensure(self) -> None:
        """惰性连接。没连过、或 live 会话断了，都重连一次。"""
        if self._mode == "unknown":
            self.connect()
        elif self._mode == "live" and not self.connected:
            self.connect()
        elif self._mode == "mock" and self._connected_at is None:
            self.connect()

    # ---------- 执行 ----------

    def exec(self, cmd: str, timeout: float | None = None) -> ExecResult:
        """跑一条命令。live 走 SSH；mock 走合成器。"""
        with self._lock:
            self.ensure()
            if self._mode == "live" and self.connected:
                return self._exec_live(cmd, timeout)
            return self._exec_mock(cmd)

    def _exec_live(self, cmd: str, timeout: float | None = None) -> ExecResult:
        assert self._client is not None
        t0 = time.time()
        _in, out, err = self._client.exec_command(cmd, timeout=timeout or config.EXEC_TIMEOUT)
        so = out.read().decode("utf-8", "replace")
        se = err.read().decode("utf-8", "replace")
        rc = out.channel.recv_exit_status()
        return ExecResult(cmd, rc, so, se, int((time.time() - t0) * 1000), "live")

    # ---------- mock 合成器 ----------

    def _exec_mock(self, cmd: str) -> ExecResult:
        low = cmd.lower()
        t = time.time() - self._mock_t0
        if "fgpoll" in low:
            body = self._mock_fg_line(t)
        elif "hostname" in low:
            body = "MOCK-BENCH"
        elif "scopectl" in low and "pduty" in low:
            # 合成占空比：跟 mock 转速同相位，20% 到 70% 之间走
            body = f"{45 + 25 * math.sin(2 * math.pi * t / 60.0):.2f}"
        elif "scopectl" in low:
            body = "MOCK_OK idn=RIGOL,DS1104Z Plus,MOCKSERIAL,00.04.04"
        elif "deepcapture" in low:
            body = "MOCK_CAPTURE points=3000000 xinc=4.0E-05 file=C:\\fc_pull\\mock_capture.csv"
        elif "type " in low or "get-content" in low or "tail" in low:
            body = "\n".join(
                f"2026-09-19 21:{40 + i:02d}:00 [INFO] mock log line {i} save_workflow_autosave"
                for i in range(8)
            )
        else:
            body = f"MOCK_ECHO {cmd}"
        return ExecResult(cmd, 0, body + "\n", "", 3, "mock")

    def _mock_fg_line(self, t: float) -> str:
        """合成一条 FgPoll 风格的输出。

        转速按 60s 周期缓慢变化，FG1 ≈ 2.19 × FG2（沿用实测的系统性偏差），
        叠一点噪声，好让前端看到会动的数。
        """
        rpm = 6000 + 2500 * math.sin(2 * math.pi * t / 60.0)
        fg2 = rpm / 60.0
        fg1 = fg2 * 2.19
        jit = lambda v: v * (1 + random.uniform(-0.004, 0.004))  # noqa: E731
        return f"FG2={jit(fg2):.6E} FG1={jit(fg1):.6E}"
