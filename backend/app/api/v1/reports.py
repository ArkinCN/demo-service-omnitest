"""报告生成与下载（阶段 4.4 引入；2026-09-28 修 G-06 / G-07）。

主文档 4.4 硬约束：**不自研 Excel 写入，复用客户 writeFile_rust**。
本模块做的是「把系统产物整理成 writeFile_rust 要的输入形态并调它」的适配层。

writeFile_rust CLI（见 `writeFile_rust/README.md`）：
    write-file-rust --template <xlsm> --images <dir> [--csv <csv>] --output <xlsm>

⚠️ 两个阻塞的**当前状态**（原文写在文件头，2026-09-28 核实后更正）：
  1. ~~writeFile_rust 未编译~~ → **已过时**：`writeFile_rust/write-file-rust.exe`
     （22.48 MB）已存在，可直接调用。
  2. **模板 .xlsm 不在本机**（真阻塞）：`report-template.json` 的 `template_file`
     指向客户软件目录（`[源] ClientSoftware/...`），全仓搜 `.xlsm` = 0 个。

因此**三档行为**（真跑通与不冒充两者都要）：
  ┌ 模板存在        → 走 write-file-rust 真生成      → status: "ok"
  ├ 模板缺失        → 生成**占位报告**（真文件、可下载）→ status: "placeholder"
  └ 生成失败        → 不产出，如实报错                 → status: "blocked"

**占位报告也要真产出、真下载**——用户要求「本轮真跑通一次」；同时在
文件名、接口 status、note 三处标注「模板未到位」，不让人误以为这是最终交付件。
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.api.deps import get_current_user, get_db
from app.core.exceptions import BadRequestException, NotFoundException
from app.core.logger import logger
from app.core.paths import PROJECT_ROOT, report_templates_dir, reports_dir
from app.models.run import Artifact, Run
from app.models.user import User
from app.schemas.common import success_response
from app.services.report_workbook import build_placeholder_workbook

#: 报告表头里**由上游（流程 2 初始化配置）提供**的字段。
#: 与前端 `c/web/src/features/flow-report/assemble.ts` 的 `UPSTREAM_HEADER_KEYS`
#: **逐字一致**——这是契约（模板字段与来源流程的对应关系），两处必须同改。
UPSTREAM_HEADER_KEYS = [
    "model",
    "project_name",
    "firmware_version",
    "inlet_start_addr",
    "bootloader",
    "outlet_start_addr",
]

router = APIRouter(prefix="/api", tags=["Reports"])

# write-file-rust 可执行文件（源码侧只读目录里的编译产物）。
# **调用不算修改**——它只读模板、写输出，不改源码目录。
WRITE_FILE_RUST = PROJECT_ROOT / "writeFile_rust" / "write-file-rust.exe"

# 报告生成超时。模板不大，但 Excel 写入 + 图片压缩可能慢，给足 120 秒。
GEN_TIMEOUT_S = 120


def _safe_name(s: str) -> str:
    """文件名白名单：run_id 来自 URL，直接拼进路径会有目录穿越风险。"""
    return "".join(c for c in s if c.isalnum() or c in "-_")[:64] or "run"


def _report_path(run_id: str, ext: str) -> Path:
    return reports_dir() / f"report-{_safe_name(run_id)}.{ext}"


def _uploaded_template() -> str:
    """用户上传的客户模板（若存在）。返回路径，不存在返回空串。"""
    d = report_templates_dir()
    if not d.is_dir():
        return ""
    for p in sorted(d.glob("*.xlsm")):
        if p.is_file():
            return str(p)
    return ""


def _read_template_path(session: Session, run_id: str) -> str:
    """找模板路径。

    顺序：① 请求体显式给的 template_path；② **用户上传的模板**（报告页「上传模板文件」，
    backend/uploads/report_templates/*.xlsm）；③ 场景包里 report-template.json 登记的
    `template_file`。**不做路径猜测**——登记值不在本机就如实报缺失。
    """
    # ② 用户上传的模板（优先于场景包登记值：用户显式上传的才是「当前要用的」）
    uploaded = _uploaded_template()
    if uploaded:
        return uploaded
    # ③ 场景包的 report-template.json（前端 public 下，后端按项目根推导）
    p = PROJECT_ROOT / "c" / "web" / "public" / "scenes"
    for scene_dir in sorted(p.glob("*")) if p.is_dir() else []:
        rt = scene_dir / "report-template.json"
        if not rt.exists():
            continue
        try:
            data = json.loads(rt.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        raw = (data.get("template_file") or "").strip()
        if not raw:
            continue
        # 登记值可能是 `[源] ClientSoftware/xxx.xlsm` 这种「未随包提供」的路径，
        # 或一条绝对路径。两种情况都返回它，由调用方判断存在性。
        if raw.startswith("[源]") or raw.startswith("/") or ":" in raw:
            return raw
        return str(scene_dir / raw)
    return ""


def _collect_report_data(session: Session, run_id: str) -> dict:
    """从轮次产物里取「报告要用的真题数据」。

    ⚠️ **只取真数据，缺的如实空着**——这是本模块最容易写坏的地方：
    为了让报告「看起来完整」而给缺失字段编一个值，比留空危险得多
    （人会照着假值做判断）。所以未取到的字段会进 `missing_header_keys`，
    由 `report_workbook` 显示成「由上游带入（未提供）」。

    各段取法与前端 `flow-report/assemble.ts` **同口径**（两处都要改一起改）：
      - 表头 ← ① **已确认的 `report-instance`**（报告页「确认表头」落的，优先）
                ② `config-snapshot` 的 `product_attributes`（只认**真快照**：
                   必须带 `product_attributes` 数组；`persistRun` 落的那份简化版只记场景与时刻）
      - 判定 ← `verdict-table` 的 `verdicts[].state`
      - 产物 ← 该轮实际有的 `artifact_kind`

    ⚠️ 表头两条来源的**优先级是刻意的**（2026-09-30）：报告页人确认过的表头
    才是「本轮最终采用值」，config-snapshot 只是它的上游初始来源。若只读
    config-snapshot，报告页补的 4 项（客户名称/工程师/Email/电话）永远不进报告——
    那正是「确认了表头但报告表头没变」的根因。
    """
    artifacts = session.exec(select(Artifact).where(Artifact.run_id == run_id)).all()
    by_kind: dict[str, Any] = {}
    for a in artifacts:
        by_kind[a.artifact_kind] = a.content

    # ── 表头
    header: dict[str, str] = {}
    missing: list[str] = list(UPSTREAM_HEADER_KEYS)
    counts: dict[str, int] | None = None

    # ① 已确认的 report-instance（报告页「确认表头」落库）——**优先**
    #
    # 只认 status == 'confirmed' 且 header 是 dict 的那份：每轮 persistRun 还落了一份
    # status:'draft' 的草稿（只有 note），拿它当表头会把报告表头清空。
    # 确认值可含**全部**表头字段（不只上游 6 项），故不受 UPSTREAM_HEADER_KEYS 限制。
    conf = by_kind.get("report-instance")
    if isinstance(conf, dict) and conf.get("status") == "confirmed":
        # 确认产物里带了模板表头的完整定义（fields），据此把「本流程该填但没填」
        # 的项也纳入 missing，报告里如实显示「未提供」，不让人误以为漏了整段。
        conf_fields = conf.get("fields")
        if isinstance(conf_fields, list):
            for f in conf_fields:
                if isinstance(f, dict) and f.get("key") and f["key"] not in missing:
                    missing.append(str(f["key"]))
        ch = conf.get("header")
        if isinstance(ch, dict):
            for k, v in ch.items():
                if not k or v is None or str(v) == "":
                    continue
                header[str(k)] = str(v)
                if k in missing:
                    missing.remove(k)

    snap = by_kind.get("config-snapshot")
    if isinstance(snap, dict) and isinstance(snap.get("product_attributes"), list):
        for a in snap["product_attributes"]:
            if not isinstance(a, dict):
                continue
            k = a.get("key")
            v = a.get("value")
            if not k or v is None or v == "":
                continue
            # 上游 6 项：**确认值优先**——人确认过的值覆盖快照原值（上面已写入的不再覆盖）
            if k in UPSTREAM_HEADER_KEYS and str(k) not in header:
                header[str(k)] = str(v)
                if k in missing:
                    missing.remove(k)
        # 三类计数：_class 缺省按本体属性算（老快照没有 _class，向后兼容）
        cls = {"attr": 0, "control": 0, "header": 0}
        for a in snap["product_attributes"]:
            if not isinstance(a, dict):
                continue
            c = a.get("_class") or "attr"
            if c in cls:
                cls[c] += 1
        counts = {
            "本体属性": cls["attr"],
            "控制参数": cls["control"],
            "报告表头": cls["header"],
        }

    # ── 判定汇总
    verdict: dict[str, Any] | None = None
    vt = by_kind.get("verdict-table")
    if isinstance(vt, dict) and isinstance(vt.get("verdicts"), list):
        states = [
            (v or {}).get("state", "") if isinstance(v, dict) else ""
            for v in vt["verdicts"]
        ]
        verdict = {
            "total": len(states),
            "pass": sum(1 for s in states if s == "pass"),
            "fail": sum(1 for s in states if s == "fail"),
            "missing": sum(1 for s in states if s in ("missing", "未采集")),
            "authoritative": bool(vt.get("authoritative")),
        }

    return {
        "header": header,
        "missing_header_keys": missing,
        "verdict": verdict,
        "artifact_kinds": [a.artifact_kind for a in artifacts],
        "snapshot_counts": counts,
    }


def _placeholder_report(run_id: str, reason: str, data: dict) -> Path:
    """生成占位报告：**真文件、可下载、能在 Excel 里打开**。

    2026-09-28 用户要求：占位件也做成 **xlsm**（能看到本轮的真题数据），
    而不是原先那份只有元数据的 JSON ——「先看效果，后续加模板」。

    ⚠️ 它仍是**占位件**，不是交付件。三道标注缺一不可：
      ① 文件名带 `placeholder`；② 首行琥珀横幅；③ 接口 `status: "placeholder"`。
    理由见模块头：自建版式与客户模板的版式/VBA 宏/工作表结构都不同，
    不标注就会被当成正式报告。

    ⚠️ 仍然**不生成 json**：上一版是 JSON，这版换成 xlsm——
    用户要的是「能打开看效果」，JSON 做不到。但**下载端点的兜底顺序保留 JSON**，
    这样旧轮次（改版前生成的）仍能下到，不会因为这次改动把历史文件变成 404。
    """
    dest = _report_path(run_id, "placeholder.xlsm")
    build_placeholder_workbook(
        run_id=run_id,
        header=data.get("header") or {},
        missing_header_keys=data.get("missing_header_keys") or [],
        verdict=data.get("verdict"),
        artifact_kinds=data.get("artifact_kinds") or [],
        snapshot_counts=data.get("snapshot_counts"),
        reason=reason,
        output=dest,
    )
    return dest


@router.post("/reports/generate")
async def generate_report(
    run_id: str,
    template_path: str | None = None,
    image_dir: str | None = None,
    csv_path: str | None = None,
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """生成报告。三档行为见模块头（ok / placeholder / blocked）。

    ⚠️ 本轮**不含波形图**：波形需真机采集（`capture_scope` 从未真跑过，
    且需现场有人把电机跑起来），本轮无真机。`image_dir` 仍保留入参，
    模板到位后可直接用。
    """
    # 轮次必须存在——否则「生成成功」的是一份指向空轮次的报告
    run = session.exec(select(Run).where(Run.run_id == run_id)).first()
    if run is None:
        raise NotFoundException(f"轮次不存在：{run_id}")

    kinds = [
        a.artifact_kind
        for a in session.exec(select(Artifact).where(Artifact.run_id == run_id)).all()
    ]

    tpl = template_path or _read_template_path(session, run_id)
    tpl_exists = bool(tpl) and not tpl.startswith("[源]") and Path(tpl).exists()

    # ── 档位 1：模板存在 + 工具存在 → 真生成
    if tpl_exists and WRITE_FILE_RUST.exists():
        out = _report_path(run_id, "xlsm")
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = [str(WRITE_FILE_RUST), "--template", tpl, "--images", image_dir or str(out.parent)]
        if csv_path:
            cmd += ["--csv", csv_path]
        cmd += ["--output", str(out)]
        logger.info(f"report: running write-file-rust for {run_id}")
        try:
            # write-file-rust 是控制台程序；后端以无控制台方式运行时（服务/守护）会弹黑框。
            # Windows 下加 CREATE_NO_WINDOW 抑制（仅该平台有该常量）。
            _run_kwargs = dict(
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=GEN_TIMEOUT_S, check=False,
            )
            if hasattr(subprocess, "CREATE_NO_WINDOW"):
                _run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            proc = subprocess.run(cmd, **_run_kwargs)
        except subprocess.TimeoutExpired:
            return success_response(data={
                "run_id": run_id, "status": "blocked", "artifacts": kinds,
                "reason": f"write-file-rust 超过 {GEN_TIMEOUT_S}s 未完成",
            }, message="报告生成超时（未产出文件）")
        if proc.returncode == 0 and out.exists():
            return success_response(data={
                "run_id": run_id, "status": "ok", "file": out.name,
                "bytes": out.stat().st_size, "artifacts": kinds,
                "download_url": f"/api/reports/{run_id}/download",
            }, message="报告已生成")
        tail = (proc.stderr or "").strip().splitlines()[-1:] or [""]
        return success_response(data={
            "run_id": run_id, "status": "blocked", "artifacts": kinds,
            "reason": f"write-file-rust 退出码 {proc.returncode}：{tail[0][:300]}",
        }, message="报告生成失败（未产出文件）")

    # ── 档位 2：模板缺失 → 系统自建模板报告（真文件、可下载，两处标注）
    #
    # 2026-09-28 用户要求：占位件做成 **xlsm**（能在 Excel 里打开、含本轮真题数据），
    # 而不是只有元数据的 JSON ——「先看效果，后续加模板」。
    # 2026-09-29 用户拍板：不等甲方模板，自建模板填数据出报告，做好可替换即可。
    # 数据取自 `_collect_report_data`（只取真数据，缺的如实留「未提供」）。
    reason = (
        f"使用系统自建模板（客户模板登记值：{tpl or '未登记'}）"
        + ("" if WRITE_FILE_RUST.exists() else "；且 write-file-rust.exe 不存在")
    )
    data = _collect_report_data(session, run_id)
    try:
        dest = _placeholder_report(run_id, reason, data)
    except Exception as exc:  # noqa: BLE001 —— 生成失败必须如实报，不能假装成功
        logger.exception(f"report: placeholder build failed for {run_id}")
        return success_response(data={
            "run_id": run_id, "status": "blocked", "artifacts": kinds,
            "reason": f"自建模板报告生成失败：{type(exc).__name__}: {exc}",
        }, message="报告生成失败（未产出文件）")
    logger.warning(f"report: placeholder generated for {run_id} — {reason}")
    return success_response(data={
        "run_id": run_id, "status": "placeholder", "file": dest.name,
        "bytes": dest.stat().st_size, "artifacts": kinds,
        "reason": reason,
        "download_url": f"/api/reports/{run_id}/download",
        "note": (
            "报告已用系统自建模板生成（xlsm）：含本轮真题数据（表头 / 判定汇总 / 产物清单）。"
            "版式由系统自建、非客户模板，**可替换**——上传客户正式模板后重新生成即为正式报告。"
        ),
    }, message="已生成报告（系统自建模板）")


@router.get("/reports/{run_id}/download")
async def download_report(
    run_id: str,
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下载报告文件（修 G-07：此前**全后端无任何报告下载端点**）。

    找不到文件时返回 404 并**说明该怎么办**，不返回空文件——
    空文件会让人以为「报告生成了但内容是空的」，那是另一回事。
    """
    # 查找顺序（**正式优先，占位兜底**）：
    #   ① report-<id>.xlsm            —— writeFile_rust 出的正式报告（模板到位后）
    #   ② report-<id>.placeholder.xlsm —— 本系统自建的占位 xlsm（2026-09-28 起）
    #   ③ report-<id>.placeholder.json —— **旧版占位件**，仅为兼容改版前生成的历史轮次，
    #      否则这次改动会让旧文件下载变 404（历史记录不该因为改格式而失效）。
    # 同一轮可能先出占位、后换正式，所以正式排最前。
    media_by_suffix = {
        ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
        ".json": "application/json",
    }
    for name in (
        f"report-{_safe_name(run_id)}.xlsm",
        f"report-{_safe_name(run_id)}.placeholder.xlsm",
        f"report-{_safe_name(run_id)}.placeholder.json",
    ):
        p = reports_dir() / name
        if p.exists():
            return FileResponse(
                path=str(p),
                media_type=media_by_suffix.get(p.suffix, "application/octet-stream"),
                filename=p.name,
                headers={"Content-Disposition": f'attachment; filename="{p.name}"'},
            )
    raise NotFoundException(
        f"轮次 {run_id} 还没有报告文件。先调用 POST /api/reports/generate?run_id={run_id} 生成。"
    )


@router.post("/reports/template")
async def upload_report_template(
    file: UploadFile = File(...),
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上传客户报告模板（.xlsm），覆盖式更新。

    用户通过报告页「上传模板文件」把客户正式模板放进来；上传后生成报告走
    真模板（write-file-rust），文件名不带 placeholder、status=ok。
    """
    filename = file.filename or ""
    if not filename.lower().endswith(".xlsm"):
        raise BadRequestException("模板必须是 .xlsm 文件（客户 Motor Checklist 模板）")

    content = await file.read()
    if not content:
        raise BadRequestException("上传的模板是空文件")

    d = report_templates_dir()
    d.mkdir(parents=True, exist_ok=True)
    # 覆盖式：清掉旧模板，避免多份 *.xlsm 让 _uploaded_template 取到旧的
    for old in d.glob("*.xlsm"):
        try:
            old.unlink()
        except OSError:
            pass
    dest = d / f"template-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}.xlsm"
    dest.write_bytes(content)

    logger.info(f"report: template uploaded -> {dest.name} ({len(content)} bytes)")
    return success_response(data={
        "filename": filename,
        "bytes": len(content),
        "stored": dest.name,
        "note": "模板已就位。重新生成报告即为正式报告（status=ok）。",
    }, message="客户模板已上传")


@router.get("/reports/template/status")
async def report_template_status(
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """查当前报告模板状态：已上传（客户模板）还是缺位（系统自建模板）。"""
    uploaded = _uploaded_template()
    if uploaded:
        p = Path(uploaded)
        st = p.stat()
        return success_response(data={
            "ready": True,
            "filename": p.name,
            "bytes": st.st_size,
            "uploaded_at": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
            "note": "客户模板已就位，生成报告为正式报告。",
        })
    return success_response(data={
        "ready": False,
        "note": "未上传客户模板，生成报告走系统自建模板（可替换）。",
    })
