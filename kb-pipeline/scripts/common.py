"""KB pipeline 公共常量与小工具。"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INPUT = BASE / "input"
CONFIG = BASE / "config"
KB_OUT = Path(os.environ.get(
    "KB_OUT",
    "/mnt/f/Main/File/2_Projects/峰岹/40_工程/agent-test-web-data/kb",
))

TAXONOMY = {"l1": "motor", "l2": "cooling-fan", "l3": "fortior-fu6832"}
PROCESS_TAGS = ["初始化配置", "测试需求", "启动测试", "调优", "报告"]


def load_registry() -> dict:
    return json.loads((CONFIG / "registry.json").read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def est_tokens(text: str) -> int:
    """粗略 token 估计：CJK 字符按 1 个 token，其余按 4 字符 1 个 token。"""
    cjk = len(re.findall(r"[一-鿿]", text))
    rest = len(text) - cjk
    return cjk + max(1, rest // 4) if text else 0
