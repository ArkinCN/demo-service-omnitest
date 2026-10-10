"""占位报告 xlsm 生成（2026-09-28 新增）。

## 为什么要有这个模块

`reports.py` 的三档行为里，「模板缺失」一档原先只产出一份 JSON 元数据
（`report-placeholder/v1`）——它证明了「生成 → 下载」链路通，但**看不出报告长什么样**。
用户要求：占位件也做成 **xlsm**（能在 Excel 里打开、能看到本轮的真题数据），
理由是「先看效果，后续加模板」。

## 与正式报告的关系（关键，别搞混）

| 档位 | 谁生成 | 产物 | 是不是交付件 |
|---|---|---|---|
| 模板存在 | `writeFile_rust`（客户工具） | 客户模板填充后的 xlsm | ✅ 是 |
| **模板缺失** | **本模块**（openpyxl） | **本模块自建版式的 xlsm** | ❌ **不是** |

**本模块产出的 xlsm 版式是自己设计的，不是客户模板的样子。**
所以不论它多像报告，它都只是**占位件**——三道标注必须带（见 `PLACEHOLDER_BANNER`）。

为什么不用 openpyxl 直接生成「正式报告」：`writeFile_rust/README.md` 说明了客户模板
自带 VBA 宏、多工作表（LV/SV/HV 測試波型）与特定单元格映射；这些**只能从模板继承**，
凭空造不出来。造一个「像正式的」反而是冒充（`reports.py` 头部的纪律）。

## 繁体处理（用户口径「一律用中文，繁体进行优化」）

- 工作表名 / 表头 / 标签一律**简体**；
- 数据值里若含繁体（来自模板原文或场景包旧字段），经 `_to_simplified` 归一。

⚠️ 这与 `c/web/DESIGN.md` 第 10.7 节的「模板原文只在报告预览纸面按原样出现」
**口径不同**：那条约束的是**前端预览的纸面**，本模块产出的是**独立文件**，
用户明确要求全中文简体。两处不冲突（不同产物），但**改任一处前先看清是哪一处**。

## 依赖

只用 `openpyxl`（后端**已有** 3.1.5，实测无需新增依赖）。
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------- 常量

#: 自建模板横幅 —— **必须出现在第一张表的首行**，让人打开就知道版式是系统自建的、可替换
PLACEHOLDER_BANNER = (
    "本报告由系统自建模板生成（客户 Motor_Checklist 模板未上传），含本轮真题数据；"
    "版式非客户正式模板，可替换——上传客户模板后重新生成即为正式报告。"
)

#: 工作表名（简体；客户模板里是「LV 測試波型」这种繁体名）
SHEET_MAIN = "报告概要"

#: 产物种类的中文名。与前端 `flow-report/assemble.ts` 的 `ARTIFACT_LABEL` 同口径，
#: 未知 kind 原样显示（不编中文名）。
ARTIFACT_LABEL: dict[str, str] = {
    "config-snapshot": "配置快照",
    "requirement-baseline": "需求基线",
    "run-artifact": "轮次产物包",
    "verdict-table": "判定结果表",
    "gap-list": "未达标项清单",
    "param-change": "参数改动版本",
    "report-instance": "报告实例",
}

#: 表头字段的中文名（简体）。模板原文是繁体（客戶名稱 / 韌體版本），
#: 用户要求报告一律简体，故在此显式映射——**不做通用繁简转换**（见 `_to_simplified` 说明）。
HEADER_LABEL: dict[str, str] = {
    "model": "机型",
    "project_name": "项目名称",
    "firmware_version": "固件版本",
    "inlet_start_addr": "Inlet 起始位址",
    "outlet_start_addr": "Outlet 起始位址",
    "bootloader": "Bootloader",
    "customer_name": "客户名称",
    "customer_engineer": "客户工程师",
    "email": "Email",
    "phone": "联系电话",
}


# ---------------------------------------------------------------- 繁简归一

#: 常用繁体 → 简体的**逐字映射**。
#:
#: ⚠️ 为什么只做逐字映射、不引第三方库：
#:   ① 依赖纪律——后端已锁定依赖清单，为一个显示需求引 `opencc` 不划算；
#:   ② 项目里前端同类需求（`c/web/src/features/shared/zh.ts` 的 `simp()`）**也是逐字映射**，
#:      口径保持一致，两处改一起改。
#: 覆盖范围：项目里**实际出现过**的繁体字（模板字段、场景包文案、工作表名）。
_S2T: dict[str, str] = {
    "稱": "称", "電": "电", "壓": "压", "轉": "转", "速": "速", "測": "测",
    "試": "试", "波": "波", "型": "型", "韌": "韧", "體": "体", "聯": "联",
    "繫": "系", "話": "话", "戶": "户", "員": "员", "產": "产", "項": "项",
    "規": "规", "範": "范", "設": "设", "計": "计", "參": "参", "數": "数",
    "結": "结", "論": "论", "報": "报", "告": "告", "樣": "样", "張": "张",
    "錄": "录", "檔": "档", "軟": "软", "執": "执", "啟": "启", "動": "动",
    "過": "过", "程": "程", "驗": "验", "證": "证", "確": "确", "認": "认",
    "檢": "检", "環": "环", "節": "节", "點": "点", "線": "线", "馬": "马",
    "達": "达", "軸": "轴", "極": "极", "對": "对", "頻": "频", "率": "率",
    "載": "载", "諧": "谐", "誤": "误", "差": "差", "範": "范", "圍": "围",
    "值": "值", "單": "单", "位": "位", "態": "态", "監": "监", "護": "护",
    "觸": "触", "發": "发", "溫": "温", "興": "兴", "業": "业", "務": "务",
    "術": "术", "機": "机", "構": "构", "處": "处", "顯": "显", "示": "示",
}


def _to_simplified(s: str) -> str:
    """把字符串里的繁体字按 `_S2T` 逐字换成简体。

    未登记的字符原样保留——**宁可少转，不可错转**。
    少数繁体字与简体字是「一词多形」或香港用字（如「著/着」「裡/里」），
    机械替换会出错，所以不放进表里；这类靠上面的 `HEADER_LABEL` 显式命名兜住。
    """
    return "".join(_S2T.get(c, c) for c in s)


# ---------------------------------------------------------------- 样式

_TITLE_FONT = Font(name="微软雅黑", size=14, bold=True, color="1F2A24")
_LABEL_FONT = Font(name="微软雅黑", size=10, bold=True, color="5B6B62")
_VALUE_FONT = Font(name="微软雅黑", size=10, color="1F2A24")
_BANNER_FONT = Font(name="微软雅黑", size=10, bold=True, color="B7791F")
_SECTION_FONT = Font(name="微软雅黑", size=11, bold=True, color="2E5E45")

_FILL_BANNER = PatternFill("solid", fgColor="FFF7E6")
_FILL_HEAD = PatternFill("solid", fgColor="EAF2EC")

_THIN = Side(style="thin", color="E3E8E4")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)

_WRAP = Alignment(vertical="top", wrap_text=True)
_LEFT = Alignment(vertical="center", horizontal="left")


# ---------------------------------------------------------------- 主体


def build_placeholder_workbook(
    *,
    run_id: str,
    header: dict[str, str],
    missing_header_keys: list[str],
    verdict: dict[str, Any] | None,
    artifact_kinds: list[str],
    snapshot_counts: dict[str, int] | None,
    reason: str,
    output: Path,
) -> Path:
    """生成占位报告 xlsm，写到 `output`，返回该路径。

    入参全部是**已装配好的真题数据**（由 `reports.py` 从轮次产物里取），
    本函数**不读库、不猜值**：缺的字段就写「由上游带入（未提供）」，绝不编。

    Args:
        run_id: 轮次号（写进文件，便于与库中记录对应）
        header: 表头字段 → 值（只含取到的）
        missing_header_keys: 未取到的表头字段 key（显示为「未提供」）
        verdict: 判定汇总 `{total,pass,fail,missing,authoritative}`，None = 本轮无判定数据
        artifact_kinds: 该轮实际有的产物 kind 列表
        snapshot_counts: 配置快照的三类计数 `{本体属性,控制参数,报告表头}`
        reason: 为什么走了占位（写进文件，如实交代）
        output: 输出路径（父目录会自动创建）
    """
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_MAIN

    col_a_width = 22
    col_b_width = 52
    ws.column_dimensions[get_column_letter(1)].width = col_a_width
    ws.column_dimensions[get_column_letter(2)].width = col_b_width

    r = 1  # 行游标

    # ── ① 占位横幅（必须首行，且合并单元格以免被列宽裁掉）
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
    c = ws.cell(row=r, column=1, value=PLACEHOLDER_BANNER)
    c.font = _BANNER_FONT
    c.fill = _FILL_BANNER
    c.alignment = _WRAP
    ws.row_dimensions[r].height = 46
    r += 2

    # ── ② 标题与轮次信息
    ws.cell(row=r, column=1, value="测试报告（系统自建模板）").font = _TITLE_FONT
    r += 1
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    for label, value in (
        ("轮次号", run_id),
        ("生成时间", now),
        ("报告状态", "系统自建模板（可替换）"),
        ("生成原因", _to_simplified(reason)),
    ):
        ws.cell(row=r, column=1, value=label).font = _LABEL_FONT
        ws.cell(row=r, column=2, value=value).font = _VALUE_FONT
        ws.cell(row=r, column=2).alignment = _WRAP
        r += 1
    r += 1

    # ── ③ 报告表头（来自 config-snapshot）
    r = _section(ws, r, "一、报告表头")
    order = list(header.keys())
    # 未取到的排后面，且**按模板字段顺序**显示——不按字典序，人读起来才是模板的顺序
    for k, v in header.items():
        r = _kv(ws, r, HEADER_LABEL.get(k, k), _to_simplified(str(v)))
    for k in missing_header_keys:
        r = _kv(ws, r, HEADER_LABEL.get(k, k), "由上游带入（未提供）", muted=True)
    if not order and not missing_header_keys:
        r = _kv(ws, r, "（无）", "本轮没有任何表头字段", muted=True)
    r += 1

    # ── ④ 判定汇总
    r = _section(ws, r, "二、判定汇总")
    if verdict:
        r = _kv(ws, r, "判据总数", str(verdict.get("total", 0)))
        r = _kv(ws, r, "通过", str(verdict.get("pass", 0)))
        r = _kv(ws, r, "不通过", str(verdict.get("fail", 0)))
        # 「未采集」单独一行并加说明：它**不是**「不通过」，
        # 混在一起会让人以为「没测的就是不合格」
        r = _kv(ws, r, "未采集", str(verdict.get("missing", 0)))
        r = _kv(
            ws,
            r,
            "数据来源",
            "后端判定（权威）" if verdict.get("authoritative") else "前端预览（非权威）",
        )
        ws.cell(row=r, column=1, value="说明").font = _LABEL_FONT
        ws.cell(
            row=r,
            column=2,
            value="「未采集」不等于「不通过」：这些判据所需的现场实测量本轮一条都没采到，"
            "因此既判不出通过也判不出不通过。",
        ).font = _VALUE_FONT
        ws.cell(row=r, column=2).alignment = _WRAP
        r += 2
    else:
        r = _kv(ws, r, "（无）", "本轮没有判定数据（未产出判定结果表）", muted=True)
        r += 1

    # ── ⑤ 配置快照摘要
    r = _section(ws, r, "三、配置快照摘要")
    if snapshot_counts:
        for k, v in snapshot_counts.items():
            r = _kv(ws, r, k, f"{v} 项")
    else:
        r = _kv(ws, r, "（无）", "本轮没有配置快照", muted=True)
    r += 1

    # ── ⑥ 产物清单
    r = _section(ws, r, "四、本轮产物清单")
    if artifact_kinds:
        for k in artifact_kinds:
            r = _kv(ws, r, ARTIFACT_LABEL.get(k, k), k, muted=True)
    else:
        r = _kv(ws, r, "（无）", "本轮没有落任何产物", muted=True)
    r += 1

    # ── ⑦ 页脚：怎么换成正式报告
    r = _section(ws, r, "五、如何换成正式报告")
    for line in (
        "1. 取得客户模板 Motor_Checklist 公用模板 .xlsm；",
        "2. 把 report-template.json 的 template_file 指向该文件；",
        "3. 重新调用生成接口 —— 系统改走 writeFile_rust 出正式报告，接口与前端均无需改动。",
    ):
        ws.cell(row=r, column=1, value=line).font = _VALUE_FONT
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        r += 1

    # ── 收尾：冻结首行 + 打印设置（只是个像样的文件该有的样子）
    ws.freeze_panes = "A3"
    ws.sheet_properties.tabColor = "B7791F"  # 琥珀：一眼看出是占位件

    output.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(output))
    return output


def _section(ws, row: int, title: str) -> int:
    """写一个分节标题，返回下一行行号。"""
    c = ws.cell(row=row, column=1, value=title)
    c.font = _SECTION_FONT
    c.fill = _FILL_HEAD
    ws.cell(row=row, column=2).fill = _FILL_HEAD
    return row + 1


def _kv(ws, row: int, key: str, value: str, *, muted: bool = False) -> int:
    """写一行「标签 | 值」，返回下一行行号。`muted` 用浅灰，表示「这项没取到」。"""
    kc = ws.cell(row=row, column=1, value=key)
    kc.font = _LABEL_FONT
    kc.alignment = _LEFT
    kc.border = _BORDER
    vc = ws.cell(row=row, column=2, value=value)
    vc.font = Font(name="微软雅黑", size=10, color="9AA69F") if muted else _VALUE_FONT
    vc.alignment = _WRAP
    vc.border = _BORDER
    return row + 1
