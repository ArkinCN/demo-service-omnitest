"""知识库「合成图文稿」构建脚本。

## 解决什么问题

一份知识库文档在数据侧是**零散存放**的：
    <doc_id>/content.md      正文（docling 抽的 Markdown，图位置留 `<!-- image -->` 占位）
    <doc_id>/figures/*.png   插图（PyMuPDF 按页抽，命名 p<页码>_x<序号>）
    <doc_id>/chunks.jsonl    检索切片
    <doc_id>/entities.json   抽出的参数
    <doc_id>/source.json     元信息

前端弹窗要「图文并茂」地看，就得把正文和插图**合成一份文件**。本脚本在每份文档
目录下新建 `combined/`：
    combined/index.html   正文 + 按序插入的插图（干净、可读）
    combined/meta.json    合成元信息（对位统计，供追溯；页面不显示）

## 图与文对位规则（用户 2026-09-29 定稿）

`content.md` 里的 `<!-- image -->` 占位符**按出现顺序**与 `figures/`（按 `p页码_x序号`
排序）**一一对应**：
  - 第 N 个占位 → 第 N 张可用图（若是浏览器能渲染的格式：png/jpg/jpeg/gif/webp）；
  - **配不上图的占位符直接删除**（不留「图略」之类字样，保证文章干净、不影响阅读）；
  - **多余的图不追加**（保持文档干净）；
  - 只处理 `<!-- image -->` 这一种占位；其它 HTML 注释（docling 的结构标记）**原样保留**；
  - 非浏览器可渲染格式（如 `.emf`）视为「配不上」，对应占位删除。

## 诚实边界

⚠️ 这是**抽取稿重建成稿**，不是客户原件 PDF。且**插图可能不全**：转换阶段
`kb-pipeline/scripts/01_convert_docs.py` 有 `MAX_FIGURES=20` 上限，每份文档最多抽 20 张
——超出部分根本没被抽出。故合成稿只保证「把现有产物合成、能配上就配上、配不上就清干净」，
**不假装图全**（meta.json 里的 dropped/unused 字段如实记录差额）。

## 图片引用方式

HTML 里图片 `src` 用**后端端点 URL**（`/api/kb/documents/<doc_id>/figure?name=...`）而非
相对路径——因为前端用 iframe `srcdoc` 渲染时相对路径没有基准 URL，绝对路径才可解析。

## 用法

    <ra python> c/backend/scripts/build_kb_combined.py [--only <doc_id>]

纯标准库；路径经 `app.core.paths.kb_extract_dir()` 推导，脚本内不写盘符。
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# 让脚本能 import 到 app.core.paths（c/backend 加入 sys.path）
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.paths import kb_extract_dir  # noqa: E402

# 浏览器能直接渲染的图片格式；其余（如 .emf）视为配不上
WEB_IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
# 占位符：只认 docling 的 `<!-- image -->`（允许空白变体）
PLACEHOLDER_RE = re.compile(r"<!--\s*image\s*-->", re.I)
# 图名排序钥匙：p<页码>_x<序号>
FIG_NAME_RE = re.compile(r"^p(\d+)_x(\d+)", re.I)


def _fig_sort_key(name: str) -> tuple[int, int, str]:
    """图片排序：p页码_x序号 优先（按数值），非该命名的排最后按名字典序。"""
    m = FIG_NAME_RE.match(name)
    if m:
        return (0, int(m.group(1)), f"{int(m.group(2)):08d}")
    return (1, 0, name.lower())


def _usable_figures(fig_dir: Path) -> list[str]:
    """可用插图文件名（按对位顺序排序；过滤非浏览器可渲染格式）。"""
    if not fig_dir.is_dir():
        return []
    names = [
        p.name
        for p in fig_dir.iterdir()
        if p.is_file() and p.suffix.lower() in WEB_IMG_EXT
    ]
    names.sort(key=_fig_sort_key)
    return names


def _md_to_html_body(md: str, doc_id: str, figures: list[str]) -> tuple[str, dict]:
    """把 Markdown 正文转成干净 HTML：占位符按序换成 <img>，配不上的占位删除。

    ⚠️ 这是**轻量转换**，不引库：只处理合成稿需要的几样（标题/段落/表格/列表/代码/图片占位）。
    正文来自 content.md（受控数据），仍做 HTML 转义，避免正文里的 `<` 破坏结构。
    """
    used = 0
    dropped = 0
    out: list[str] = []

    def render_placeholder() -> str:
        nonlocal used, dropped
        if used < len(figures):
            name = figures[used]
            used += 1
            url = f"/api/kb/documents/{doc_id}/figure?name={html.escape(name, quote=True)}"
            return f'<figure class="kb-fig"><img src="{url}" alt="插图 {used}" loading="lazy"></figure>'
        dropped += 1
        return ""  # 配不上图 → 占位直接删除

    lines = md.splitlines()
    i = 0
    in_code = False
    in_table = False
    in_ul = False
    in_ol = False

    def close_lists() -> None:
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    def close_table() -> None:
        nonlocal in_table
        if in_table:
            out.append("</tbody></table>")
            in_table = False

    while i < len(lines):
        line = lines[i]
        # 图片占位单独成行（docling 常见）→ 直接替换
        if not in_code and PLACEHOLDER_RE.fullmatch(line.strip()):
            frag = render_placeholder()
            if frag:
                close_lists()
                close_table()
                out.append(frag)
            i += 1
            continue
        # 代码块
        if line.strip().startswith("```"):
            close_lists()
            close_table()
            out.append("<pre><code>" if not in_code else "</code></pre>")
            in_code = not in_code
            i += 1
            continue
        if in_code:
            out.append(html.escape(line))
            i += 1
            continue
        # 表格（`| a | b |`；紧跟 `|---|` 的分隔行）
        if line.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            close_lists()
            close_table()
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            out.append("<table><thead><tr>" + "".join(f"<th>{html.escape(c)}</th>" for c in header) + "</tr></thead><tbody>")
            in_table = True
            i += 2
            continue
        if in_table and line.lstrip().startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            out.append("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in cells) + "</tr>")
            i += 1
            continue
        close_table()
        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            close_lists()
            lvl = min(len(m.group(1)) + 1, 6)  # 文中标题整体降一级（h1 留给文档标题）
            out.append(f"<h{lvl}>{html.escape(m.group(2).strip())}</h{lvl}>")
            i += 1
            continue
        # 无序列表
        m = re.match(r"^\s*[-*]\s+(.*)$", line)
        if m:
            if in_ol:
                out.append("</ol>")
                in_ol = False
            if not in_ul:
                close_table()
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{html.escape(m.group(1).strip())}</li>")
            i += 1
            continue
        # 有序列表
        m = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if m:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            if not in_ol:
                close_table()
                out.append("<ol>")
                in_ol = True
            out.append(f"<li>{html.escape(m.group(1).strip())}</li>")
            i += 1
            continue
        # 分隔线
        if re.fullmatch(r"\s*-{3,}\s*", line):
            close_lists()
            out.append("<hr>")
            i += 1
            continue
        # 空行
        if not line.strip():
            close_lists()
            out.append("")
            i += 1
            continue
        # 普通段落：行内处理（粗体 / 行内代码），其余转义
        close_lists()
        txt = html.escape(line)
        txt = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", txt)
        txt = re.sub(r"`([^`]+)`", r"<code>\1</code>", txt)
        out.append(f"<p>{txt}</p>")
        i += 1

    close_lists()
    close_table()
    if in_code:
        out.append("</code></pre>")

    meta = {
        "placeholder_count": used + dropped,
        "figure_count": len(figures),
        "matched": used,
        "dropped_placeholders": dropped,
        "unused_figures": max(0, len(figures) - used),
    }
    return "\n".join(out), meta


_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px 22px 40px; background: #fff; color: #1f2a24;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px; line-height: 1.75;
}
h1 { font-size: 19px; margin: 4px 0 14px; }
h2 { font-size: 16px; margin: 22px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #e3e8e4; }
h3 { font-size: 14px; margin: 18px 0 8px; }
h4, h5, h6 { font-size: 13px; margin: 14px 0 6px; color: #2e5e45; }
p { margin: 8px 0; }
ul, ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
code { background: #f4f7f4; border: 1px solid #e3e8e4; border-radius: 3px; padding: 0 4px; font-size: 12px; }
pre { background: #f7f9f7; border: 1px solid #e3e8e4; border-radius: 4px; padding: 10px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; }
table { border-collapse: collapse; margin: 10px 0; width: 100%; font-size: 12px; }
th, td { border: 1px solid #e3e8e4; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f0f5f1; font-weight: 600; }
hr { border: none; border-top: 1px solid #e3e8e4; margin: 16px 0; }
.kb-fig { margin: 14px 0; text-align: center; }
.kb-fig img { max-width: 100%; height: auto; border: 1px solid #e3e8e4; border-radius: 4px; }
"""


def build_one(doc_dir: Path) -> dict | None:
    """合成一份文档；无 content.md 返回 None。"""
    md_file = doc_dir / "content.md"
    if not md_file.is_file():
        return None
    doc_id = doc_dir.name
    md = md_file.read_text(encoding="utf-8", errors="replace")
    figures = _usable_figures(doc_dir / "figures")
    body, meta = _md_to_html_body(md, doc_id, figures)

    # 标题：优先 source.json 的 title
    title = doc_id
    sj = doc_dir / "source.json"
    if sj.is_file():
        try:
            title = (json.loads(sj.read_text(encoding="utf-8")).get("title") or doc_id)
        except (json.JSONDecodeError, OSError):
            pass

    page = (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<title>{html.escape(title)}（合成图文稿）</title><style>{_CSS}</style></head><body>"
        f"<h1>{html.escape(title)}</h1>"
        '<div style="margin:0 0 14px;padding:8px 10px;border:1px solid #e3e8e4;border-radius:4px;'
        'background:#f7faf8;color:#5b6b62;font-size:12px;">'
        "系统合成图文稿（由抽取产物重建，非客户原件 PDF）。"
        "</div>"
        f"{body}</body></html>"
    )

    out_dir = doc_dir / "combined"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "index.html").write_text(page, encoding="utf-8")
    meta_full = {
        "doc_id": doc_id,
        "title": title,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "html_bytes": len(page.encode("utf-8")),
        **meta,
    }
    (out_dir / "meta.json").write_text(
        json.dumps(meta_full, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return meta_full


def main() -> int:
    ap = argparse.ArgumentParser(description="构建知识库合成图文稿")
    ap.add_argument("--only", default="", help="只处理该 doc_id")
    args = ap.parse_args()

    root = kb_extract_dir()
    if not root.is_dir():
        print(f"[FAIL] 抽取稿根目录不存在：{root}", file=sys.stderr)
        return 1

    done = 0
    for doc_dir in sorted(root.iterdir()):
        if not doc_dir.is_dir() or doc_dir.name == "combined":
            continue
        if args.only and doc_dir.name != args.only:
            continue
        # 幂等：先清空旧 combined/ 再生成
        old = doc_dir / "combined"
        if old.is_dir():
            shutil.rmtree(old)
        info = build_one(doc_dir)
        if info is None:
            continue
        done += 1
        print(
            f"[ok] {info['doc_id']}: 占位 {info['placeholder_count']} / 图 {info['figure_count']}"
            f" → 对位 {info['matched']}，删占位 {info['dropped_placeholders']}，"
            f"余图 {info['unused_figures']}，html {info['html_bytes']}B"
        )
    print(f"\n完成 {done} 份。输出：<doc_id>/combined/index.html + meta.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
