"""报告生成与下载（阶段 4.4 引入；2026-09-28 修 G-06 / G-07；2026-10-10 改口径）。

## 口径变更（2026-10-10 用户拍板，先看这段再看代码）

**系统内置模板（`report_workbook.py` 产出）就是客户认可的正式报告模板。**
因此原先的三档（ok / placeholder / blocked）收成两档：

| 情形 | 走哪条路 | status |
|---|---|---|
| 用户**没有**上传客户模板（默认） | 系统内置模板产出报告（`_self_built_report`） | **ok** |
| 用户**已上传**客户模板 + 填充程序齐备 | `write-file-rust` 填充客户模板 | ok |
| 用户已上传客户模板但**缺填充程序** | 不产出，如实报错 | **blocked** |
| 生成过程抛错 | 不产出，如实报错 | blocked |

两条纪律：
  1. **缺填充程序时不静默降级**：用户明确要客户模板，却给一份系统内置版式的报告，
     那是最危险的一种「看起来成功」——所以如实报 blocked 并说明缺什么。
  2. **历史文件不失效**：下载端点仍保留 `*.placeholder.xlsm` / `*.placeholder.json`
     兜底顺序，改版前生成的老报告照样下得到。

## 客户模板通路（保留但不默认走）

writeFile_rust CLI（见 `writeFile_rust/README.md`）：
    write-file-rust --template <xlsm> --images <dir> [--csv <csv>] --output <xlsm>

启用方式：把客户 .xlsm 传进 `report_templates_dir()`（或调 `POST /api/reports/template`），
并把 `write-file-rust.exe` 放到 `WRITE_FILE_RUST` 指向的位置。两者齐备即自动改走该通路。
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
from app.services.report_workbook import build_report_workbook

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
      - 判定明细 ← 同一份 `verdicts[]` 逐条取 `req_id / name / state`
        （2026-10-10 编号 4 美化新增，供报告文件列出「哪几条判了什么」）
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
    # 逐条判定明细（2026-10-10 编号 4 美化新增）：报告文件据此列出
    # 「哪几条判了什么」，让判据总数与通过数之间能逐条核对。
    verdict_items: list[dict[str, Any]] = []
    vt = by_kind.get("verdict-table")
    if isinstance(vt, dict) and isinstance(vt.get("verdicts"), list):
        states = [
            (v or {}).get("state", "") if isinstance(v, dict) else ""
            for v in vt["verdicts"]
        ]
        n_pass = sum(1 for s in states if s == "pass")
        n_fail = sum(1 for s in states if s == "fail")
        # 通过率（2026-10-10 新增，需求单编号 3）
        #   B 口径：通过率 = 通过 ÷（通过 + 不通过）。
        #   「未采集」「本台架不适用」「人工判定」三类都不进分子也不进分母——
        #   把没测到的算进分母，等于把「没测」当成「不合格」，那是造假。
        #   分母为 0 时给 None：展示层显示「—」，**不许显示 0%**
        #   （0% 会被读成「全不通过」，与实际语义相反）。
        judged = n_pass + n_fail
        verdict = {
            "total": len(states),
            "pass": n_pass,
            "fail": n_fail,
            "missing": sum(1 for s in states if s in ("missing", "未采集")),
            # 「本台架不适用」与「人工判定」也各自计数（2026-10-10 随通过率一并补）：
            # 通过率的分母把这两类排除了，报告里就必须看得见它们有多少条——
            # 否则「判据总数 34、通过 + 不通过才 8」会让人以为少了 26 条。
            "not_applicable": sum(1 for s in states if s in ("not_applicable", "本台架不适用")),
            "manual": sum(1 for s in states if s == "manual"),
            "pass_rate": (n_pass / judged) if judged else None,
            "authoritative": bool(vt.get("authoritative")),
        }
        # 明细只取「报告要用的三个字段」，state 原样透传（前端与 xlsm 各自映射中文，
        # 两边同词：通过 / 不通过 / 未采集 / 人工判定 / 本台架不适用）。
        verdict_items = [
            {
                "req_id": (v or {}).get("req_id") or "",
                "name": (v or {}).get("name") or "",
                "state": (v or {}).get("state") or "",
            }
            for v in vt["verdicts"]
            if isinstance(v, dict)
        ]

    return {
        "header": header,
        "missing_header_keys": missing,
        "verdict": verdict,
        "verdict_items": verdict_items,
        "artifact_kinds": [a.artifact_kind for a in artifacts],
        "snapshot_counts": counts,
    }


def _self_built_report(run_id: str, data: dict) -> Path:
    """用**系统内置模板**生成报告：真文件、可下载、能在 Excel 里打开。

    2026-10-10 口径变更（用户拍板）——**这就是正式报告**：
      · 文件名不再带 `placeholder`（改用正式名 `report-<id>.xlsm`）；
      · 首行琥珀「可替换」横幅**已按用户要求删除**；
      · 接口返回 `status: "ok"`。

    数据取自 `_collect_report_data`（只取真数据，缺的如实留「未提供」）。

    ⚠️ 下载端点的兜底顺序**仍保留** `*.placeholder.xlsm` / `*.placeholder.json`：
    那是改版前生成的历史文件，不因这次改口径把旧报告变成 404。
    """
    dest = _report_path(run_id, "xlsm")
    build_report_workbook(
        run_id=run_id,
        header=data.get("header") or {},
        missing_header_keys=data.get("missing_header_keys") or [],
        verdict=data.get("verdict"),
        verdict_items=data.get("verdict_items") or [],
        artifact_kinds=data.get("artifact_kinds") or [],
        snapshot_counts=data.get("snapshot_counts"),
        source_note="系统内置模板",
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
    """生成报告。两档见模块头（ok / blocked）。

    ⚠️ 本轮**不含波形图**：波形需真机采集（`capture_scope` 从未真跑过，
    且需现场有人把电机跑起来），本轮无真机。`image_dir` 仍保留入参，
    客户模板通路启用后可直接用。
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

    # ── 路径 1：用户**真的上传了客户模板** → 必须走客户模板填充工具
    if tpl_exists:
        if not WRITE_FILE_RUST.exists():
            # 明确要客户模板却缺填充程序：如实报 blocked，**不静默降级**成系统内置模板
            # （降级会让人以为拿到的是客户模板版式，那是最危险的一种「看起来成功」）。
            return success_response(data={
                "run_id": run_id, "status": "blocked", "artifacts": kinds,
                "reason": (
                    f"已上传客户模板（{Path(tpl).name}），但填充程序不存在：{WRITE_FILE_RUST}。"
                    "请把 write-file-rust.exe 放到该位置，或删除已上传的客户模板以改用系统内置模板。"
                ),
            }, message="报告生成失败（缺填充程序，未产出文件）")
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

    # ── 路径 2：没有客户模板 → 系统内置模板，**这就是正式报告**
    #
    # 2026-10-10 用户拍板：系统内置模板即客户认可的正式报告模板。
    # 因此这里返回 status="ok"、文件名不带 placeholder、首行不再有「可替换」横幅。
    # 数据取自 `_collect_report_data`（只取真数据，缺的如实留「未提供」）。
    # 抓不到的异常类别（磁盘满/权限）一律如实报 blocked，禁裸 catch。
    data = _collect_report_data(session, run_id)
    try:
        dest = _self_built_report(run_id, data)
    except Exception as exc:  # noqa: BLE001 —— 生成失败必须如实报，不能假装成功
        logger.exception(f"report: self-built build failed for {run_id}")
        return success_response(data={
            "run_id": run_id, "status": "blocked", "artifacts": kinds,
            "reason": f"报告生成失败：{type(exc).__name__}: {exc}",
        }, message="报告生成失败（未产出文件）")
    logger.info(f"report: generated (system built-in template) for {run_id}")
    return success_response(data={
        "run_id": run_id, "status": "ok", "file": dest.name,
        "bytes": dest.stat().st_size, "artifacts": kinds,
        "download_url": f"/api/reports/{run_id}/download",
        "note": (
            "报告已生成（xlsm）：含本轮真题数据（表头 / 判定汇总 / 判定明细 / 产物清单）。"
            "判定结论按后端权威结果如实呈现；「未采集」与「本台架不适用」均不计入通过率分母。"
        ),
    }, message="报告已生成")


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
    # 查找顺序（**正式名优先，历史文件兜底**）：
    #   ① report-<id>.xlsm            —— 正式报告（2026-10-10 起，系统内置模板也用它）
    #   ② report-<id>.placeholder.xlsm —— **改版前**生成的占位 xlsm（2026-09-28 ~ 10-09）
    #   ③ report-<id>.placeholder.json —— 更早的「只有元数据」版占位件
    # ②③ 只为兼容历史轮次：改口径不该让旧报告的下载变成 404
    # （历史记录不该因为改了格式而失效）。
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
