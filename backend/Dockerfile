# OmniTest 后端镜像（FastAPI + gunicorn）
#
# 关键约束（与部署体系一致）：
#   - 基础镜像必须带 -bookworm 后缀：Debian 13(trixie) 缺 libgl1-mesa-glx 等包，
#     opencv / pdf 处理类依赖会装不上。
#   - pip 走国内镜像（阿里云）：服务器直连 pypi.org 很慢。
#   - 启动必须用 gunicorn，不用 uvicorn/Flask 内置服务器。
#   - ⚠️ 本项目 README 要求「单 worker」：db/session.py 连接池是按单 worker 设计的
#     （pool_size=100 + max_overflow=300）。worker 数务必保持 1（见 gunicorn.conf.py）。
#
# ⚠️ 目录布局（关键，别乱改）：
#   app/core/paths.py 用 CORE_DIR.parents[3] 推导 C_DIR，用 parents[4] 推导仓库根。
#   即它硬性要求容器内路径为 **<repo>/c/backend/app/core/paths.py**（四层 parent）。
#   所以 backend 不能平铺到 /app，必须放在 <repo>/c/backend。
#   本镜像取 repo=/srv/omnitest，布局：
#       /srv/omnitest/c/backend/**            ← 后端源码
#       /srv/omnitest/c/web/public/**         ← 场景包与知识库静态数据（PUBLIC_DIR）
#       /srv/omnitest/c/data/kb/documents/**  ← 知识库抽取稿（KB_EXTRACT_DIR 默认）
#   web/ 与 data/ 只读挂载进来即可，不需要前端构建产物。
FROM python:3.11-slim-bookworm

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    OMNITEST_REPO=/srv/omnitest

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 系统依赖：build-essential 用于编译期；curl 供健康检查/排障
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

# 按 paths.py 要求的层级建立布局：<repo>/c/backend
WORKDIR /srv/omnitest/c/backend

# 先装依赖，利用镜像层缓存
COPY requirements.txt .
# ⚠️ requirements.txt 有两处缺口，均在此补装（不改客户锁定的 requirements.txt）：
#   1. gunicorn  —— 部署要求用 gunicorn 起服务，requirements 里只有 uvicorn。
#   2. openpyxl  —— services/report_workbook.py 用它生成 xlsm 报告。
#   3. pymupdf   —— 源码有 import pymupdf（PDF 处理），requirements 未列。
RUN pip install --no-cache-dir -r requirements.txt \
        gunicorn==21.2.0 \
        openpyxl==3.1.5 \
        pymupdf==1.24.14 \
        -i https://mirrors.aliyun.com/pypi/simple/

# 再拷后端源码
COPY . .

# 运行期目录（与 docker-compose 的挂载点一致）
RUN mkdir -p /var/log/demo uploads/avatars uploads/kb uploads/kb_vector uploads/reports .deploy/logs

EXPOSE 5100

# gunicorn.conf.py 与 app 都在 /srv/omnitest/c/backend 下，WORKDIR 即此处
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
