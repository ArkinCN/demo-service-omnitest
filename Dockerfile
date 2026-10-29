# syntax=docker/dockerfile:1
# ============================================================================
# OmniTest 门户单容器镜像（AI Cube Hub 接入用）
#
# 为什么长这样（门户硬约束，不是设计选择）：
#   1. 门户在**仓库根目录**执行 docker build，不支持指定 Dockerfile 路径、
#      不支持 --build-arg / --target  → 所以根目录必须有一个自包含的多阶段 Dockerfile；
#   2. 门户只创建**一个**容器，不读 docker-compose.yml
#      → 所以不能让 nginx 和 gunicorn 分居两个容器，改由 FastAPI 直接托管前端产物
#        （见 backend/app/main.py 的「前端静态托管」段）；
#   3. 门户只注入 TZ，没有 env/secrets 字段
#      → 所以演示用密钥只能写进下面的 ENV（安全口径见文件末尾说明）；
#   4. 门户健康检查窗口约 8 秒（8 次 × 1s，单次超时 3s）
#      → 所以先 compileall 预编译字节码，把冷启动压在窗口内。
#
# 台架机（真机 / 示波器）仍用原有的 docker-compose.yml + backend/Dockerfile，
# 本文件不影响那条路径。
# ============================================================================

# ── 阶段 1：构建前端（node 只在构建期存在，不进最终镜像）────────────────────
FROM node:22-slim AS web-build

# ⚠️ 构建期变量：不设时前端会退化成 mock 后端（features/copilot/backend.ts 的默认值是 'mock'），
#    助手对话、权限档位、写工具确认都会变成假的。必须在这里注入 dsh。
ENV VITE_AGENT_BACKEND=dsh

WORKDIR /build
# 先拷锁文件装依赖，利用镜像层缓存
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# 再拷源码构建（tsc -b && vite build）
COPY web/ ./
RUN npm run build

# ── 阶段 2：运行时（Python + gunicorn，单进程单容器）────────────────────────
FROM python:3.11-slim-bookworm

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    OMNITEST_REPO=/srv/omnitest \
    ENVIRONMENT=production \
    DEBUG=False \
    API_V1_PREFIX=/api/v1 \
    # 门户无法下发登录态，前端也不带 Authorization（基线既有问题），
    # 因此本地演示必须开无密码模式，所有请求以本地管理员身份执行。
    AUTH_DISABLED=true \
    AUTH_DISABLED_USERNAME=admin \
    AUTH_DISABLED_EMAIL=admin@example.internal \
    # ── 演示用密钥（门户不提供 secrets，只能内置）──────────────────────────
    # ⚠️ 这两个值随镜像与仓库公开，**只用于演示**；正式环境必须换掉。
    SECRET_KEY=ZQL0FzU1Db1YNJElnr0DKZDhQtXf6bHHnwXvayrxp9tu0yylQ0ltaZJWy3mSnoWP \
    JWT_SECRET_KEY=PYvU95VbOQLbs-RpIClOEGI-upK1gZoMGKXprDn8DF8C1N5uJ71Huh5VfTDQdYIw \
    # 无持久卷：SQLite 落在镜像内 .deploy/，容器重建即归零（已确认的演示期取舍）
    DATABASE_URL=sqlite:///.deploy/motordebug.db \
    # 大模型：演示用 key，建议在模型平台单独申请「限额」key 替换，降低泄露损失
    MOTORDEBUG_LLM_API_KEY=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 \
    MOTORDEBUG_LLM_BASE_URL=https://openrouter.ai/api \
    MOTORDEBUG_LLM_MODEL=deepseek/deepseek-v4.1-flash-1017 \
    MOTORDEBUG_LLM_FAST_MODEL= \
    KB_BACKEND=local \
    SERVER_BASE_URL=http://127.0.0.1:5100 \
    DOWNLOAD_PUBLIC_BASE_URL=http://127.0.0.1:5100 \
    # LDAP 四项在 config.py 里是**无默认值的必填项**（缺一个 Settings() 就抛
    # ValidationError，容器直接退出）。本演示不启用 LDAP（AUTH_DISABLED=true 时
    # 调度器也会跳过 LDAP 同步），这里只给占位值满足校验。
    LDAP_URL=ldap://127.0.0.1:389 \
    LDAP_ADMIN_DN=cn=Manager,dc=example,dc=internal \
    LDAP_ADMIN_PASSWORD=CHANGE_ME \
    LDAP_SEARCH_BASE=ou=example,dc=example,dc=internal

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# libusb：python-usbtmc 运行期依赖（门户容器没有设备直通，此处只保证 import 不失败）
RUN apt-get update && apt-get install -y --no-install-recommends libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# paths.py 的四层契约：<repo>/c/backend
WORKDIR /srv/omnitest/c/backend

# 先装依赖（含镜像额外需要、未写进客户锁定 requirements.txt 的几项）
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
        gunicorn==21.2.0 \
        pymupdf==1.24.14 \
        "pyserial>=3.5" \
        "pyvisa>=1.15" \
        "pyvisa-py>=0.8" \
        "pyusb>=1.2" \
        "python-usbtmc==0.8"

# 再拷后端源码
COPY backend/ ./

# 预编译字节码：镜像里 PYTHONDONTWRITEBYTECODE=1，不预编译的话每次启动都要重新编译，
# 实测冷启动会从 6.2s 继续变慢，直接顶穿门户约 8 秒的健康检查窗口。
RUN python -m compileall -q app

# 运行期目录（无持久卷，重建即丢）
# ⚠️ /var/log/demo 必须建：gunicorn.conf.py 把 accesslog/errorlog 写在这里
#    （台架机由 compose 挂载宿主机同名目录；单容器里没有挂载，不建就直接启动失败：
#     "Error: '/var/log/demo/omnitest.err.log' isn't writable"）
RUN mkdir -p uploads/avatars uploads/kb uploads/kb_vector uploads/reports .deploy/logs /var/log/demo

# 前端构建产物 + 后端运行期要读的静态数据（SCENES_DIR / KB_DATA_DIR 走 c/web/public）
COPY --from=web-build /build/dist /srv/omnitest/c/web/dist
COPY web/public /srv/omnitest/c/web/public
COPY data /srv/omnitest/c/data

EXPOSE 5100

# 门户不传 healthcheck，只有镜像自带才会被判 unhealthy 并自动重启（自愈）。
# 注意：与门户表单里的健康检查 URL 是两套，互不替代。
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5100/health', timeout=3).status==200 else 1)"

# gunicorn.conf.py：bind=0.0.0.0:5100、workers=1、preload_app=True
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
