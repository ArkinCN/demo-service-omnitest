"""集中配置。凭据只从环境变量取，代码里不写死私钥内容。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class DeviceConfig:
    """一台被 MCP 暴露出去的设备。"""

    id: str
    name: str
    model: str
    kind: str                 # host | instrument
    host: str
    port: int
    user: str
    key_env: str              # 环境变量名，其值是私钥【文件路径】；与 webssh 的 keyRef 同一约定
    via: str | None = None    # 仪器类设备经宿主机中转
    tags: list[str] = field(default_factory=list)

    @property
    def key_path(self) -> str | None:
        p = os.environ.get(self.key_env)
        if not p:
            return None
        return os.path.expanduser(p)


BENCH = DeviceConfig(
    id="bench",
    name="峰岹台架工控机",
    model="SK-20251218QPBB / Windows 11",
    kind="host",
    host=os.environ.get("BENCH_HOST", "172.25.5.166"),
    port=int(os.environ.get("BENCH_PORT", "5011")),
    user=os.environ.get("BENCH_USER", "administrator"),
    key_env="FORTIOR_WIN_KEY",
    tags=["ssh", "windows", "session0"],
)

SCOPE = DeviceConfig(
    id="scope",
    name="RIGOL DS1104Z Plus 示波器",
    model="DS1104Z Plus · VISA over USB",
    kind="instrument",
    host=BENCH.host,
    port=BENCH.port,
    user=BENCH.user,
    key_env="FORTIOR_WIN_KEY",
    via="bench",
    tags=["visa", "usbtmc"],
)

DEVICES: dict[str, DeviceConfig] = {BENCH.id: BENCH, SCOPE.id: SCOPE}

# 台架机上的既有工具与路径（来自 fortior-test-bench skill 的实测记录）
FC_PULL = r"C:\fc_pull"
FGPOLL = FC_PULL + r"\FgPoll.exe"
SCOPECTL = FC_PULL + r"\ScopeCtl.exe"
DEEPCAPTURE4 = FC_PULL + r"\DeepCapture4.exe"
MOTORDEBUG_LOG_DIR = r"C:\Users\Administrator\AppData\Local\MotorDebug\logs"

# VISA 读不到有效测量时 Rigol 返回的哨兵值
VISA_NAN = 9.9e37

SSH_CONNECT_TIMEOUT = float(os.environ.get("BENCH_SSH_TIMEOUT", "12"))
EXEC_TIMEOUT = float(os.environ.get("BENCH_EXEC_TIMEOUT", "60"))

# ---------------------------------------------------------------- 批准 PIN
# 红线批准的第二道秘密。与 BRIDGE_TOKEN 分开：BRIDGE_TOKEN 是"调用票"，会被打进
# 浏览器包，任何拿到前端产物的人都有；BRIDGE_APPROVER_PIN 只存在于桥的 .env 与
# 服务端进程内存，前端不得以 VITE_ 前缀变量的形式携带它，只能由人在确认卡上现场输入。
APPROVER_PIN = os.environ.get("BRIDGE_APPROVER_PIN", "")
# 连续输错几次锁定、锁多久（秒）
APPROVER_PIN_MAX_FAILS = int(os.environ.get("BRIDGE_APPROVER_PIN_MAX_FAILS", "5"))
APPROVER_PIN_LOCK_SECONDS = float(os.environ.get("BRIDGE_APPROVER_PIN_LOCK_SECONDS", "60"))
