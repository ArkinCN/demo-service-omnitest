"""USB/VISA 依赖环境预置（2026-10-08 新增）。

背景（实测根因）：
- 示波器 USB-TMC 走 pyvisa-py 的 USB 后端，底层是 pyusb。
- pyusb 通过 `ctypes.util.find_library("libusb-1.0")` 定位 libusb-1.0.dll。
- 在 Windows + conda 环境里，libusb-1.0.dll 位于 `<env>\Library\bin\`，**默认不在 PATH**。
- 一旦找不到该 DLL，pyusb 会**静默退化**到旧的 libusb0 后端（libusb0.dll），
  用错 USB API 导致 `claim_interface` 失败 → 表现为「能枚举到设备却打不开」。
- pyvisa_py.usb 在 **import 时**就探测并固定后端，因此本函数**必须在 import pyvisa 之前**调用。

解决：在 import pyvisa/pyusb 之前，
  ① 尝试 `import libusb_package`（自带 libusb-1.0.dll，最可靠）；
  ② 否则把 conda `<env>\Library\bin`（或系统常见路径）前置进 os.environ["PATH"]。

幂等、无副作用；失败时不抛错（由上层如实报枚举错误）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_APPLIED = False


def _candidate_dll_dirs() -> list[str]:
    """libusb-1.0.dll 可能所在的目录（按可靠性排序）。"""
    dirs: list[str] = []
    # conda 环境：<env>\Library\bin（pyusb/win 版 libusb 常在此）
    exe_dir = Path(sys.executable).resolve().parent
    dirs.append(str(exe_dir / "Library" / "bin"))
    # venv 的 Scripts 同级 Library\bin（部分布局）
    dirs.append(str(exe_dir.parent / "Library" / "bin"))
    # 常见系统位置
    dirs.append(r"C:\Windows\System32")
    return dirs


def _try_libusb_package() -> bool:
    """优先用 libusb_package（自带 DLL，无需改 PATH）。成功返回 True。"""
    try:
        import libusb_package  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def ensure_usb_backend() -> str:
    """确保 pyusb 能加载 libusb-1.0 后端。返回采取的策略名，便于日志。

    必须在 `import pyvisa` / `import usb.core` **之前**调用。
    策略顺序：libusb_package > PATH 前置 > 无（由上层报错）。
    """
    global _APPLIED
    if _APPLIED:
        return "already"
    _APPLIED = True

    if _try_libusb_package():
        # libusb_package 存在时，pyvisa_py 0.8+ 与 pyusb 均可经其加载 DLL；
        # 再把其目录也前置进 PATH，兼容仍走 find_library 的旧路径。
        try:
            import libusb_package
            lib = libusb_package.get_library_path()
            d = os.path.dirname(lib)
            if d and d not in os.environ.get("PATH", ""):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        except Exception:  # noqa: BLE001
            pass
        return "libusb_package"

    for d in _candidate_dll_dirs():
        if Path(d).is_dir() and d not in os.environ.get("PATH", ""):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            # 命中即止：首个含 libusb-1.0.dll 的目录已足够
            if any(Path(d).glob("libusb-1.0.dll")):
                return f"path:{d}"
    return "none"
