feat: 第四轮接线与视觉/案例修复三轮落地——设备桥接入页面、红线六动作统一闸门、案例收口；新增 spike 双组件与 08 系列开发交付文档

本次同步 182 个文件（新增 148、修改 34），+24675 / -259 行。来源工作区：
`~/agent-test-web`（→ web/）、`~/lab/spike-canvas` 与 `~/lab/spike-device-mcp`（→ components/）、
`/mnt/f/Main/File/2_Projects/峰岹/40_工程/agent-test-web-data/scenes/`（→ data/scenes/）、
`/mnt/f/Main/File/2_Projects/峰岹/峰岹agent/09-实验室demo线/20260919-通用Agent测试系统v2.0/`（→ docs/）。

## 一、三轮修复要点

### 1. 视觉缺陷修复（CHANGELOG-fix-visual-20260920.md）
修 `docs/03-截图/CHANGES-v2.1-to-v3.0.md` 第 13 节人眼复检列出的 5 条，外加截图脚本静默失败。

- `scripts/shootfinal.mjs` 的 `final-zoom-evidence.png` 口径错误：原先在知识库模块页点放大按钮，
  该页三栏改版后已无任何放大按钮，点击超时被 `.catch(() => {})` 吞掉仍照旧出图。
  新口径改挂流程 2（测试需求）画板上的「知识库依据」节点。
- 两份截图脚本所有静默 catch 换成 `warn()` 记录，收尾有警告即 `process.exit(1)`；
  放大类截图新增浮层断言（`.tp-modal, [role="dialog"]` 计数为 0 即记警告）；
  新增 `OUTDIR` 环境变量，自查时不覆盖交付图。

### 2. R-14 案例简化收口（CHANGELOG-fix-r14-20260920.md）
依据用户录音意见 R-14「案例搞太复杂，演示是个 demo，故事不好讲」，
设计口径出自 `docs/06-第三轮改版/06d-案例简化与demo故事线.md` 第 3、4 节。

- 判定卡现在真能判出结论。改前流程 3 是「通过 0 / 不通过 0 / 未采集 6」、流程 4「未达标 0」
  却挂 6 条推荐参数，两页之间因果断裂。改后判据 TR-START-01（起动成功率，100 次启停回归）
  判为不通过，流程 4 左栏落进一条未达标项。
- 实现落在 `web/src/features/flow-run/evaluate.ts`：`runtimeMeasures()` 新增可选场景包入参，
  从 `datasets.json` 的 `package_stats` 段取已标注批次的通过次数（散热风扇包登记 2026-08-11
  启动故障 98 次实验的标注结果：尝试 101、已标注 98、通过 67、失败 30、作废 1）；
  判据表达式按合取短路求值（通过 67 次 ≠ 要求 100 次，假 ∧ 未知 = 假）。
  未登记 `package_stats` 的场景包（合成的玻璃升降器包）照旧落「未采集」。

### 3. 第四轮接线（CHANGELOG-wire-20260920.md）
起因是《部署、联调与演示标准作业程序》第零节列的「点不动的三处」，加上第 1.2 节
「设备桥没有接进页面」，四处一并接上。

- 新增 `web/src/features/remote/bridge.ts`（250 行）：设备桥 HTTP 客户端，
  覆盖 `GET /devices`、`GET /devices/{id}/status`、`POST /devices/{id}/tools/{name}`、
  凭据批准与驳回，外加订阅钩子 `useBridgeDevice()`（首拉全量、之后 5 秒轮状态）。
- 新增 `web/src/features/redline/`：`RedlineConfirm.tsx` 确认卡、`flowActions.ts`（295 行）动作行为表。
  红线六动作（启动、停止、急停、写回参数、导出、归档）一律经 `useAppStore.requestRedline()`
  排队弹卡，人点「确认执行」才执行，无第二条执行路径；批准函数 `approveConfirmation()`
  唯一合法调用点是 store 的 `approveRedline()`，副驾两个包只能排队、调不到批准。
- 接桥时走三段式，闸口在桥不在前端：不带 `confirm_token` 调一次 → 桥拒绝并签发 pending 凭据
  → 人点确认后 `POST /confirmations/{token}/approve` → 带同票同参重调才执行。
  凭据四道约束（单次使用、180 秒过期、绑工具名、绑参数指纹）只在桥里实现一次。
  桥不可达时确认卡照弹，并在卡上写明本次不向台架下发控制命令。
- 配套新增 `web/.env.example`、`web/scripts/{walk-wire,count-r14,shot-r14}.mjs`，
  `web/README.md` 第 10 节补接线与桥配置说明。

## 二、新增组件

- `components/spike-canvas/`（21 个文件）：画板技术选型对比 spike，React Flow 与手写 SVG
  两条实现并排，含 6 张对照截图。
- `components/spike-device-mcp/`（35 个文件）：设备桥与 MCP 服务端 spike，
  `device_bench/` 四个模块（config / confirm / backend / server）、`bridge.py` HTTP 桥、
  `mcp_client_check.py` 客户端核验，以及 `evidence/` 下 21 份实跑证据 JSON 与 1 份版本记录 `00-versions.txt`
  （含 6 例 REFUSED 拒绝证据与 1 份确认审计链）。

## 三、文档清单（→ docs/）

| 文档 | 说明 |
| --- | --- |
| `03-主文档-多场景Agent测试系统页面原型与业务逻辑-v3.2.md` | 主文档，页面与业务逻辑全貌 |
| `03-截图/v3.2/`（37 张） | v3.2 交付截图，含在线/离线设备节点与红线确认全链路 |
| `03-截图/CHANGES-v2.1-to-v3.0.md` | v2.1 → v3.0 变更与人眼复检问题清单 |
| `04-同事实施任务详单-v3.1.md` | 分工与任务拆解 |
| `04-同事实施任务详单-v3.0-审稿意见.md` | 对 v3.0 详单的审稿意见 |
| `05-交接文档-给接手模型-v1.3.md` | 系统边界、已完成范围与未尽事项 |
| `08a-开发接口契约-v1.1.md`（2033 行） | 开发接口契约 |
| `08b-场景包契约/`（29 个文件） | 场景包契约：`README-场景包契约-v1.1.md`、12 份 JSON Schema、`validate.py`、`packs.json`、`examples/minimal-scene/` 完整样例包 |
| `08c-部署联调与演示SOP-v1.1.md`（783 行） | 部署、联调与演示标准作业程序 |
| `08d-验收用例清单-v1.0.md` | 验收用例清单 |
| `08a08c-审稿意见.md` | 对 08a、08c 的审稿意见 |
| `08b-审稿意见.md` | 对 08b 场景包契约的审稿意见 |

## 四、场景包修复（→ data/scenes/ 与 web/public/scenes/）

两处内容修复，源包与 web 静态副本同步：

1. `motor.cooling-fan.fortior-fu6832/experience.json`：两条经验条目的 `parameters_resolved`
   由 `true` 改为 `false` 并补 `_status` 说明。原因是 `Pole_Pairs`（客户头文件 Customer.h:56）
   与 `FG_PULSE_PERIOD`（Customer.h:334）虽在本包登记，但登记位置是 `product-attributes.json`
   的本体属性，不在 `control-parameters.json` 的 70 个可调控制参数里，按未解析处理，待客户确认。
2. `automotive.body-motor.window-regulator/test-requirements.json`：`derived_from` 由自由文本
   `"safety-interlocks.json fault_bitmap 位 0x0080"` 改为结构化数组
   `["safety-interlocks.fault_bitmap.0x0080"]`，对齐 08b 契约的引用格式。

另同步 `_build/` 生成与自检脚本：`automotive/_build/selfcheck.py`（新增）、
`automotive/_build/gen_a.py`、`motor/_build/{gen_b.py,selfcheck.py}`。

## 五、门禁结果

| 门禁 | 结果 |
| --- | --- |
| `npm ci`（仓内 web/） | 退出码 0 |
| `npm run build`（tsc -b && vite build） | 退出码 0 |
| `npx tsc -b`（仓内 web/） | 退出码 0，零类型错误 |
| `python3 -c "import device_bench"` 及三个子模块 | 四个模块全部导入成功 |
| 密钥扫描（`git diff --cached` 全量 + 新文件） | 零命中。`.env`、`*.pem`、`*.key`、`id_rsa*` 均未入库；两份 `.env.example` 中非占位值只有主机地址、端口与私钥文件路径，密钥本体不在仓库内 |

排除项：`node_modules/`、`dist/`、`shots3~shots6/`、`.bak-src-*/`、`tmp/`、`.env`、
`__pycache__/`、`*.tsbuildinfo`、`evidence/*.log`、`*.pid`、场景包 `*.bak-20260920`。


## 六、红线两级鉴权（批准 PIN）修复

最后一轮改动，来源是 `docs/07i-交互打通独立核验.md` 第十节记下的 P1（严重）、P2 与 P3（中）、
P5 与 P4 的一部分（低）。完整记录见 `web/CHANGELOG-fix-redline-pin-20260920.md` 与
`docs/07j-红线绕过修复记录.md`，桥侧设计说明见 `components/spike-device-mcp/README.md` 3.1 节。

### 6.1 被修的问题

构建产物 `dist/assets/index-*.js` 里内嵌了设备桥的调用票 `BRIDGE_TOKEN`，而桥的人工批准接口
`POST /confirmations/{token}/approve` 的全部鉴权就是这一个 token。拿到构建产物的人可以自己签一张
凭据、自己批准、再带票执行，红线三段式整道闸口可被绕过。另有两条中级问题：副驾的 `autoConfirm`
分支能在无人点击时 `resolve(true)`；批准人署名与操作者名写死「张工」，自动放行与真人批准在台账里
分不开。

### 6.2 桥侧（components/spike-device-mcp/）

鉴权拆成两级。`BRIDGE_TOKEN`（请求头 `x-bridge-token`）按公开处理，能列设备、查状态、调工具、
驳回凭据，调红线工具只拿得到一张 `pending` 凭据；`BRIDGE_APPROVER_PIN`（请求头 `x-approver-pin`）
只在桥的 `.env` 与桥进程内存里，不进任何 `VITE_` 变量、不进任何构建产物，唯一作用是把 `pending`
批成 `approved`。

- 两处比较统一改 `hmac.compare_digest`，常量时间。
- 没带 PIN 或 PIN 不对一律 403，凭据保持 `pending`：不消耗、不作废、不降级。
- 连续错 5 次锁 60 秒（`BRIDGE_APPROVER_PIN_MAX_FAILS`、`BRIDGE_APPROVER_PIN_LOCK_SECONDS` 可调），
  锁定期间 PIN 正确也拒，没带 PIN 同样计一次失败；计数全进程一份，不按来源 IP 分桶。
- `BRIDGE_APPROVER_PIN` 未设置、或与 `BRIDGE_TOKEN` 同值时桥拒绝启动。
- 台账新增 `approved_by`（前端传来的操作者名）与 `approve_channel`（`human_pin`）两个字段。
- `GET /health` 与 `GET /devices/{id}/status` 回 `approve_requires_pin` 与 `approver_pin_gate`。

### 6.3 前端侧（web/）

- `src/features/redline/RedlineConfirm.tsx` 新增批准 PIN 输入框（`type="password"`，
  `data-testid="redline-pin"`）。PIN 只活在该组件的 `useState` 里，换凭据即清空、卡关闭即消失，
  不写 `localStorage`、不进全局 store、不进模块级变量。
- `src/state/useAppStore.ts` 的 `approveRedline` 签名改为 `(pin: string) => Promise<void>`，
  PIN 逐次作为实参传给 `approveConfirmation`，不缓存。
- 删除 `src/features/agent-chat/AgentChat.tsx` 的 `autoConfirm` 分支与同名 prop；
  `src/features/agent-chat/api.ts` 的第二处批准调用点改走 `requestRedlineAsync()`。
  全工程批准桥凭据的路径因此只剩一条：确认卡 → `approveRedline` → `approveConfirmation`。
- 操作者名改从 store 的 `operator` 字段读（默认仍「张工」，`setOperator` 可改），
  写死的 `CONFIRM_ACTOR` 与导出常量 `OPERATOR` 一并删除。
- `src/features/remote/bridge.ts` 不再把调用票编进构建产物，交付页面由操作员现场
  `omnitestSetBridgeToken('<token>')` 给票（存本机 `localStorage`）；本地开发照旧读 `.env`。
- 助手三枚恒灰的红线按钮查清原因并接上：写回草稿接 store 的 `adoptedKeys` / `adoptMeta`，
  经验草稿按已跑轮数如实给摘要，导出待点给回放态产物索引并在字段里写明 `replay: true`。
  三者在条件不满足时仍为 `null`、按钮仍置灰，不伪造运行时证据。

### 6.4 本轮新增文档（→ docs/）

| 文件 | 内容 |
| --- | --- |
| `07i-交互打通独立核验.md` | 第四轮接线的独立核验报告，红线绕过问题的来源 |
| `07j-红线绕过修复记录.md` | 本轮修复记录 |

`05-交接文档-给接手模型-v1.3.md` 用链接已回填版覆盖仓内旧副本。

### 6.5 本轮门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run build`（仓内 web/，tsc -b && vite build） | 退出码 0 |
| `npx tsc -b`（仓内 web/） | 退出码 0 |
| 密钥扫描（`git diff --cached` 全量比对两份 `.env` 的真实值） | `BRIDGE_TOKEN`、`BRIDGE_APPROVER_PIN`、`VITE_BRIDGE_TOKEN` 三个值命中均为 0；无 `BEGIN ... PRIVATE KEY`；`.env`、`*.pem`、`*.key`、`id_rsa*` 均未入库 |


Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
