#!/usr/bin/env bash
# 知识库转化流水线 · 全量重跑
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/../.venv/bin/python"
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"      # 模型已在本地缓存，默认断网跑
export TABLEFORMER_MODE="${TABLEFORMER_MODE:-FAST}"

"$PY" "$HERE/02_parse_customer_h.py"   # 先跑，供文档实体抽取比对宏名
"$PY" "$HERE/01_convert_docs.py" "$@"
"$PY" "$HERE/03_build_index.py"
"$PY" "$HERE/04_search.py"
"$PY" "$HERE/05_build_experience.py"
"$PY" "$HERE/06_build_taxonomy.py"
"$PY" "$HERE/07_write_readme.py"
echo "done -> ${KB_OUT:-/mnt/f/Main/File/2_Projects/峰岹/40_工程/agent-test-web-data/kb}"
