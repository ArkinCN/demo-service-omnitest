import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CircleSlash,
  FileBarChart,
  Gauge,
  PlayCircle,
  SlidersHorizontal,
  Zap,
} from 'lucide-react'
import { Button, Panel, PanelHeader, Tooltip, cn } from '../../components/ui'
import { ConsoleChatPanel } from './ConsoleChatPanel'
import { FanTrendView } from '../fan-trend/FanTrendView'
import { getPack } from '../scene/pack'
import { useAppStore } from '../../state/useAppStore'
import type {
  AutomationLiveState,
  AutomationLogEntry,
  AutomationSummary,
  AutomationToolState,
} from '../../state/useAppStore'
import type { BackendVerdict } from '../flow-run/api'
import { fmtClock, fmtElapsed, fmtPct } from '../shared/format'
import {
  buildParamViews,
  buildVerdictViews,
  type ParamView,
  type StageStats,
  type StageView,
  type VerdictStats,
  type VerdictView,
} from './automationViewModel'

/* ===========================================================================
   自动化回归 · 全屏运行台（三栏）

   三栏各答一个问题：
     左「在用哪些参数、现在到哪一步了」→ 参数来源 + 真实动作三态；
     中「台架采到什么」→ 复用 FanTrendChart（双纵轴、缺测断线）+ 执行日志；
     右「判得怎么样」→ 四类计数分列 + 判据逐条实测值。

   ⚠️ 三条硬纪律：
     ① 空态给「未开始/暂无」文案，**不显示 0**（0 会被读成「测了但没通过」）；
     ② 缺测（null）显示「未采集」并给原因，**不补零、不插值**；
     ③ 动作三态由编排器按 promise 生命周期围栏，**不存在写死的动画脚本**。
   =========================================================================== */

/** 参数来源徽标的色调：本轮采纳最重、文档值最轻 */
const SOURCE_CLS: Record<ParamView['source'], string> = {
  本轮采纳: 'bg-ink text-white',
  初始化快照: 'bg-p100 text-p700',
  场景包文档值: 'bg-sunk text-t3',
  不适用: 'bg-sunk text-t3',
}

/* ===========================================================================
   中栏「实时趋势 ↔ 执行日志」可拖分隔条（2026-10-09）

   起因：中栏原为「趋势 min-h-220px + 日志 flex-1」——日志把剩余高度全吃掉，
   上方趋势区被压得偏小（用户反馈「上面的区域太小、下面的太大」）。

   口径与流程页「面板 ↔ AI 助手」那条分隔条**同源**（`app/FlowScreen.tsx`）：
     · 布局用 fr 栅格，不用写死像素高 → 视口变化时比例自动保持；
     · 分隔条自带行高（吃掉原来的两区之间 gap），栅格 gap:0，避免条上下各多一道空档；
     · 拖动事件绑 window（指针会滑出 20px 窄条，绑自身会中途丢事件）；
     · 常显 grip + role="separator" + aria-* + 方向键 + 双击复位（键盘可达，不只有鼠标）。
   与流程页的差异：比例是**单一键**（运行台不属于某条流程），且额外把两侧像素下限
   纳入 clamp —— 拖到任何位置都不会把趋势图或日志压没，也不会把底部状态条挤出屏幕。
   =========================================================================== */

/** 终态文案：状态条与趋势卡胶囊共用，避免同一件事两处说法不一致 */
const TERMINAL_LABEL: Record<'completed' | 'failed' | 'stopped', string> = {
  completed: '已完成',
  failed: '失败',
  stopped: '已终止',
}

/** 默认：趋势 55% / 日志 45%（双击复位回到此值） */
const DEFAULT_LOG_RATIO = 0.45
/** 静态兜底区间（实测高度不足时向上/向下收紧） */
const MIN_LOG_RATIO = 0.18
const MAX_LOG_RATIO = 0.82
/** 趋势区像素下限：沿用它原来的 min-h-[220px]，也正好保住 FanTrendChart 的 full 档 */
const TREND_MIN_H = 220
/** 日志区像素下限：沿用它原来的 min-h-[140px] */
const LOG_MIN_H = 140
/**
 * 助手卡像素下限（2026-10-10 新增）。
 *
 * 与流程页 `app/FlowScreen.tsx` 的 `ASSISTANT_MIN_H` **同源同值**：助手卡在下方
 * 第三行出现时，输入框 / 停止按钮 / 模型·权限行必须完整可见。实测「头部 44 +
 * 动作条 34 + 输入框 58 + 模型行 40 + 内边距」≈ 215px，取 216。
 *
 * ⚠️ 这是**模式下限**：日志态用 LOG_MIN_H、助手态用本值，喂给 `clampLogRatio`
 * 的第三个参数。若不按模式取，助手态会被旧的 140px 下界夹回、底部被裁。
 */
const CONSOLE_AI_MIN_H = 216
/** 分隔条行高：原两区之间 10px gap 全收进条里 */
const HANDLE_H = 20
/** 值 = 日志区占比字符串（与流程页的 flow-assistant-ratio:* 键区分） */
const SPLIT_KEY = 'automation-console-split-ratio'

/**
 * 把日志占比夹到「两侧像素下限都成立」的区间。
 *
 * 静态兜底 [0.18, 0.82] 只防极端值；矮视口（1280×720 一类）下两侧底线相加
 * 可能超出容器，故必须用**实测高度**再夹一次，否则拖到端点会让栅格溢出、
 * 把底部状态条与「终止」按钮挤出屏幕。容器高度未知（首帧 / 已卸载）时退回静态兜底。
 *
 * ⚠️ 第三个参数 `thirdMinH` 是**第三行（日志卡 / 助手卡）的像素下限**：
 * 日志态 140、助手态 216（见 CONSOLE_AI_MIN_H）。像素夹取必须用它，否则
 * 助手态会被日志态的 140px 下界夹回、助手卡底部被裁。
 */
function clampLogRatio(r: number, containerH: number, thirdMinH: number = LOG_MIN_H): number {
  let lo = MIN_LOG_RATIO
  let hi = MAX_LOG_RATIO
  if (containerH > 0) {
    const byPixels = thirdMinH / containerH
    const byTrend = 1 - TREND_MIN_H / containerH
    // 像素约束比静态兜底更紧时才收紧；否则保留静态区间
    lo = Math.max(lo, Math.min(byPixels, hi))
    hi = Math.min(hi, Math.max(byTrend, lo))
  }
  return Math.min(hi, Math.max(lo, r))
}

/**
 * 读磁盘上的日志占比。
 *
 * 持久值只按**日志口径**（LOG_MIN_H）夹一次即可：它是「用户想要的日志比例」，
 * 与当前是日志态还是助手态无关；真正渲染时再由 `eff` 按模式下限现算。
 */
function readLogRatio(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_LOG_RATIO
  const raw = Number(localStorage.getItem(SPLIT_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOG_RATIO
  return clampLogRatio(raw, 0, LOG_MIN_H)
}

const pct = (r: number) => Math.round(r * 100)

export function AutomationConsole({
  stages,
  stageStats,
  live,
  tools,
  logs,
  verdicts,
  onStop,
  terminalStatus,
  onShowResult,
}: {
  stages: StageView[]
  /** 阶段统计（成功/失败/跳过/总数），来自编排器状态，非时间推算 */
  stageStats: StageStats
  live: AutomationLiveState
  tools: AutomationToolState[]
  logs: AutomationLogEntry[]
  /** 后端权威判定（最后一次 runAndCollect 的结果） */
  verdicts: BackendVerdict[]
  onStop: () => void
  /**
   * 整轮终态（2026-10-09 新增）。`undefined` = 仍在跑。
   *
   * 为什么需要它：本节在**终态也会常驻**（结果弹窗收起后底座要留着，
   * 人才能接着看本轮数据）。此时「终止」按钮已无意义（对已终态调用 stop 是空操作），
   * 底部状态条也不该再说「准备中…」——那会被读成「还没跑」。
   */
  terminalStatus?: 'completed' | 'failed' | 'stopped'
  /** 终态且弹窗已收起时注入：重开完成弹窗（**只开弹窗，不触发任何执行**） */
  onShowResult?: () => void
}) {
  const pack = getPack()
  const overrides = useAppStore((s) => s.overrides)
  const snapshotValues = useAppStore((s) => s.snapshotValues)
  const adoptedApplied = useAppStore((s) => s.adoptedApplied)
  const adoptedKeys = useMemo(() => adoptedApplied.map((a) => a.key), [adoptedApplied])

  /* 参数视图：走与流程 3 左栏同一条回落链，调优采纳后会如实变成新值 */
  const params = useMemo(
    () => buildParamViews(pack, overrides, snapshotValues, { adoptedKeys, limit: 12 }),
    [pack, overrides, snapshotValues, adoptedKeys],
  )
  const { rows, stats } = useMemo(() => buildVerdictViews(verdicts), [verdicts])

  const cur = stages.find((s) => s.isCurrent)
  /* 秒级滴答：让「本阶段已用时」走动（起止时刻来自编排器，前端只做减法） */
  const now = useNow()
  const elapsedLive = useMemo(() => liveElapsedOf(stages, now), [stages, now])

  /* ---------------------------------------------- 第三行「日志 ↔ AI 助手」双态
   *
   * 2026-10-10 需求：日志卡右上角圆形 AI 按钮，点一下日志上卷、助手卡从下升起，
   * 再点（或点助手内「收起」）反向切回。原理是**双卡常驻 + transform 卷动**：
   *   · 两卡都保持挂载（absolute 叠在同一个卡片栈里）→ 日志滚动位置不丢、
   *     助手对话与进行中的回答不被切换打断（切走时只把卡片移出视野，不卸载）；
   *   · 位移用 transform.driver（GPU 合成、无布局抖动），motion-reduce 下降级为瞬时。
   *
   * `panel` 只影响两块：第三行的**像素下限**（日志 140 / 助手 216）与两卡的位移。
   * 它**不改日志数据逻辑、不新增任何轮询或硬件调用**（运行台纪律：不另起轮询、
   * 不启停台架），因此助手开合与测试运行完全解耦。
   */
  const [panel, setPanel] = useState<'log' | 'ai'>('log')
  const aiActive = panel === 'ai'
  /** 第三行像素下限随模式取（见 CONSOLE_AI_MIN_H 注释） */
  const thirdMinH = aiActive ? CONSOLE_AI_MIN_H : LOG_MIN_H

  /* ---------------------------------------------- 中栏「趋势 ↔ 日志」分隔条 */
  const [ratio, setRatio] = useState(readLogRatio)
  const splitRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  /** 拆分栅格实测高度：clamp 要用它把两侧像素下限算成比例区间 */
  const [splitH, setSplitH] = useState(0)

  const persistRatio = useCallback(
    (r: number) => {
      const h = splitRef.current?.getBoundingClientRect().height ?? splitH
      // 拖动得到的「日志占比」按**日志口径**夹取后落盘：持久值语义单一（用户想要的
      // 日志比例），与当前模式无关；渲染时再按 thirdMinH 现算，避免助手态污染存值。
      const next = clampLogRatio(r, h, LOG_MIN_H)
      setRatio(next)
      try {
        localStorage.setItem(SPLIT_KEY, String(next))
      } catch {
        // 隐私模式下 localStorage 可能被禁；记不住不影响本次调整
      }
    },
    [splitH],
  )

  /* 容器高度跟随窗口/布局变化重算（窗口缩放、底部状态条换行等） */
  useEffect(() => {
    const el = splitRef.current
    if (!el) return
    const measure = () => setSplitH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* 高度变化的重新收口：视口变矮后旧比例可能已越界，夹回合法区间。
   * ⚠️ 依赖里带上 thirdMinH：切到助手态下限抬高（140→216）后也要夹一次，
   * 否则旧比例可能让助手卡底部越界。 */
  useEffect(() => {
    setRatio((r) => clampLogRatio(r, splitH, thirdMinH))
  }, [splitH, thirdMinH])

  /**
   * 拖拽：按下分隔条后监听 window 的 move/up，而不是条自己的。
   * 指针很容易在拖动中滑出这条 20px 的细条，绑在自己身上会中途丢事件。
   * 日志在下面：从底部往上量，得到的就是日志应占的比例。
   */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const box = splitRef.current?.getBoundingClientRect()
      if (!box || box.height <= 0) return
      const fromBottom = (box.bottom - e.clientY) / box.height
      persistRatio(fromBottom)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // ⚠️ 运行台会被整体卸载（跑完切结果页）：卸载时也要把锁住的光标/选区还原，
      // 否则会残留 row-resize 光标挂在 body 上，影响后续页面。
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
  }, [persistRatio])

  const startDrag = () => {
    dragging.current = true
    // 拖动全程锁住光标与选区，否则手一快就选中了半屏文字
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const eff = clampLogRatio(ratio, splitH, thirdMinH)
  const splitRows = `minmax(${TREND_MIN_H}px, ${(1 - eff).toFixed(4)}fr) ${HANDLE_H}px minmax(${thirdMinH}px, ${eff.toFixed(4)}fr)`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 三栏栅格：左栏口径与人测页面左栏**同源**（app/FlowScreen.tsx 的 minmax(300px,380px)）；
          右栏保持原档位；1280 以下（未进 xl）兜底窄一档，避免三栏互相挤压。 */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,340px)_minmax(0,1fr)_300px] gap-2.5 overflow-y-auto 2xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_320px] xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_280px]">
        {/* ── 左栏：参数 + 执行动作 ──
            2026-10-10 样式统一（用户要求「照搬人测页面左栏」）：
              · 容器改用共享 Panel（surface-1：白底 + 圆角 + 柔阴影）；
              · 段头改用共享 PanelHeader（h-[44px] / px-4 / gap-2.5 / 标题 16px / 图标 17px），
                与人测左栏的「参数」标题条完全同规格；
              · 两段之间不再留卡片缝隙，改由 PanelHeader 自带的 border-b 分隔（人测同款）；
              · 行元素对齐人测 ParamRow 口径（min-h-[32px] / py-1 / pl-3 pr-3 / 名称 13px）。
            ⚠️ 只统一观感：菜单项内容、排序、来源徽标与「本轮采纳」语义全部保持原样。 */}
        <Panel>
          <PanelHeader
            icon={<SlidersHorizontal size={17} strokeWidth={1.9} />}
            title="自动选定的测试参数"
            right={<span className="num text-[12px] text-t3">{params.length}</span>}
          />
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {params.length ? (
              params.map((p) => (
                <Tooltip
                  key={p.key}
                  className="w-full"
                  content={`${p.fullName} · 来源：${p.source}${
                    p.adopted ? '（本轮调优自动采纳）' : ''
                  }`}
                >
                  <div
                    className={cn(
                      'flex min-h-[32px] items-center gap-2 border-l-2 py-1 pr-3 pl-3 transition-colors',
                      p.adopted ? 'border-l-p700 bg-ink-wash' : 'border-l-transparent',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-t1">{p.name}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-medium',
                        SOURCE_CLS[p.source],
                      )}
                    >
                      {p.source}
                    </span>
                    <span className="num shrink-0 text-[13px] font-semibold text-t1">
                      {p.display}
                      {p.unit ? (
                        <span className="ml-0.5 text-[11px] font-normal text-t3">{p.unit}</span>
                      ) : null}
                    </span>
                  </div>
                </Tooltip>
              ))
            ) : (
              <p className="px-3 py-3 text-center text-[12px] text-t3">
                场景包未加载，暂无参数可显示
              </p>
            )}
          </div>

          <ToolBlock tools={tools} />
        </Panel>

        {/* ── 中栏：实时趋势 + 执行日志（可拖分隔条）+ 状态条 ── */}
        <div className="flex min-h-[320px] flex-col gap-2.5">
          {/*
            拆分栅格：趋势 / 分隔条 / 日志 三行，gap:0 —— 行间距完全由 20px 的条承担。
            ⚠️ 若这里再留 gap，条上下会各多一道空档（流程页曾修过此坑）。
            两侧像素下限写进行模板（minmax），比例越界时栅格自动兜住，
            不会把图表压没、也不会把底部状态条挤出屏幕。
          */}
          <div
            ref={splitRef}
            className="grid min-h-0 flex-1 overflow-hidden"
            style={{ gridTemplateRows: splitRows, gap: '0' }}
          >
          <section className="flex min-h-0 flex-col rounded-tps border border-line-soft bg-surface">
                 <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
            <Activity size={14} strokeWidth={1.9} className="shrink-0 text-p700" />
               <h2 className="text-[12.5px] font-semibold text-t1">实时趋势</h2>
                      <TrendPill cur={cur} live={live} terminalStatus={terminalStatus} />
                 <span className="num ml-auto text-[11.5px] text-t3">
                        {live.plan
                     ? `计划 ${live.plan.planned_duration_s}s${
                           live.plan.actual_duration_s != null
                    ? ` · 实际 ${live.plan.actual_duration_s}s`
              : ''
              }${live.plan.overrun ? '（已延期）' : ''}`
           : ''}
                      </span>
                    </header>
            <div className="min-h-0 flex-1 p-2">
              {/*
                与 /run 人测页**同一套**时序曲线 UI（工具行 + 四通道读数行 + 趋势/波形
                切换 + 回到全程），复用 `FanTrendView` 受控展示卡——两处不再各写一份。
                数据仍来自编排器实时流（`automationLive`），这里**不另起轮询、不启停台架**，
                免得与编排器抢单设备锁（409）。
                chartMinH 传 140：本卡所在的中栏趋势行下限是 220px，工具行与读数行叠加
                后要留出空间，紧凑降级交给 FanTrendChart 既有的 full/slim/tiny。
              */}
              <FanTrendView
                plan={live.plan}
                samples={live.samples}
                phaseLabel={live.plan?.status}
                error={live.plan?.error}
                runId={live.plan?.run_id ?? null}
                chartMinH={140}
                emptyHint={
                  cur?.id === 'run'
                    ? '正在下发台架启动指令，拿到首批样本后这里会实时绘制占空比 / 电压 / 电流 / 转速曲线（缺测断线不补零）'
                    : '台架尚未启动。本步骤之前不会产生任何曲线——这里只画真采到的数据。'
                }
              />
            </div>
          </section>

          {/*
            可拖拽分隔条：常显抓握手柄（用户曾反馈「没注意到有这个条」，故不藏）。
            role="separator" + aria-* 让读屏软件知道这是可调整的分隔，方向键也能调。
            交互与视觉口径与流程页 app/FlowScreen.tsx 那条**同源**，保持手感一致。
          */}
          <div
            role="separator"
            data-testid="auto-console-splitter"
            aria-orientation="horizontal"
            aria-label="调整实时趋势与执行日志的高度"
            aria-valuenow={pct(eff)}
            aria-valuemin={pct(MIN_LOG_RATIO)}
            aria-valuemax={pct(MAX_LOG_RATIO)}
            tabIndex={0}
            onPointerDown={startDrag}
            onDoubleClick={() => persistRatio(DEFAULT_LOG_RATIO)}
            onKeyDown={(e) => {
              // ArrowUp = 日志区变大（与流程页「上键把下方区域拉大」同向）
              const step = e.shiftKey ? 0.05 : 0.02
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                persistRatio(ratio + step)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                persistRatio(ratio - step)
              }
            }}
            className="group flex cursor-row-resize items-center justify-center focus-visible:outline-none"
            title="拖动调整实时趋势与执行日志的高度（双击复位）"
          >
            <span className="flex items-center gap-1 rounded-full bg-p50/70 px-2.5 py-[3px] transition-colors group-hover:bg-p50 group-focus-visible:bg-p50">
              <span className="h-[2px] w-5 rounded-full bg-t3/60 transition-colors group-hover:bg-ink group-focus-visible:bg-ink" />
              <span className="h-[4px] w-14 rounded-full bg-t2/70 transition-all group-hover:h-[5px] group-hover:bg-ink group-focus-visible:h-[5px] group-focus-visible:bg-ink" />
              <span className="h-[2px] w-5 rounded-full bg-t3/60 transition-colors group-hover:bg-ink group-focus-visible:bg-ink" />
            </span>
          </div>

          {/*
            第三行「日志卡 ↔ AI 助手卡」卷动卡片栈（2026-10-10）。
            · 双卡 absolute 叠放、都保持挂载 → 切换不卸载、不丢状态；
            · 位移用 transform 卷动（日志 -100% 收向顶部、助手 +100% 升起），
              motion-reduce 下 CSS 已取消过渡 → 瞬时切换；
            · 圆形 AI 按钮**不随卷动位移**（固定在卡片栈右上角、悬浮于卡片之上），
              两态恒可点击；两卡头部各留右侧避让，按钮不遮任何既有内容。
          */}
          <div className="relative min-h-0">
            <div className="relative h-full overflow-hidden rounded-tps">
              <div
                className={cn(
                  'absolute inset-0 transition-transform duration-300 ease-[cubic-bezier(0.22,0.75,0.3,1)] motion-reduce:transition-none',
                  aiActive ? '-translate-y-full' : 'translate-y-0',
                )}
                inert={aiActive}
                aria-hidden={aiActive}
              >
                <LogStream logs={logs} />
              </div>
              <div
                className={cn(
                  'absolute inset-0 transition-transform duration-300 ease-[cubic-bezier(0.22,0.75,0.3,1)] motion-reduce:transition-none',
                  aiActive ? 'translate-y-0' : 'translate-y-full',
                )}
                inert={!aiActive}
                aria-hidden={!aiActive}
              >
                <ConsoleChatPanel onCollapse={() => setPanel('log')} />
              </div>
            </div>
            <ConsoleAiButton active={aiActive} onClick={() => setPanel((p) => (p === 'ai' ? 'log' : 'ai'))} />
          </div>
          </div>

          <div className="grad-ink flex shrink-0 items-center gap-2 rounded-tps px-3 py-2 text-white">
                      <PlayCircle size={14} strokeWidth={1.9} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        {terminalStatus
                          ? `本轮已结束（${TERMINAL_LABEL[terminalStatus]}）${
                              cur?.message ? ` · 末阶段：${cur.message}` : ''
                            }`
                          : cur
                            ? `${cur.name} · ${cur.message || '进行中'}`
                            : '准备中…'}
               </span>
                      {/* 已采样本条数：让「跑到哪了」有个硬指标（0 条就是还没采到，不粉饰） */}
                        <span className="num shrink-0 text-[11.5px] opacity-80">
                          已采 {live.samples.length} 条
                       </span>
              {/*
                终态不再报「本阶段已用时」：此刻没有「当前阶段」了，
                那个数字会停在最后一刻、看着像还在跑（与状态条同一口径）。
              */}
              {!terminalStatus ? (
                <span className="num shrink-0 text-[11.5px] opacity-80">
                    本阶段 {elapsedLive === null ? '—' : fmtElapsed(elapsedLive)}
                      </span>
              ) : null}
            {/*
              「终止」只在运行态出现：对已终态调用 stop 是空操作（编排器直接 return），
              留一个点了没反应的按钮比不放更糟。终态原位换「查看执行结果」——
              它只重开弹窗，**不触发任何执行**（不新增第二个启动/重跑入口）。
            */}
            {terminalStatus ? (
              onShowResult ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FileBarChart size={13} strokeWidth={1.9} />}
                  onClick={onShowResult}
                  data-testid="auto-console-show-result"
                  className="border-white/40 bg-white/10 text-white hover:bg-white/20"
                >
                  查看执行结果
                </Button>
              ) : null
            ) : (
              <Button
                variant="danger"
                size="sm"
                icon={<CircleSlash size={13} strokeWidth={2} />}
                onClick={onStop}
                data-testid="auto-console-stop"
              >
                终止
              </Button>
            )}
          </div>
        </div>

        {/* ── 右栏：进度 + 判据统计 + 判据列表 ── */}
        <div className="flex min-h-0 flex-col gap-2.5">
          <ProgressCard stageStats={stageStats} />
          <VerdictPanel stats={stats} rows={rows} />
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 子组件 */

/**
 * 秒级滴答：返回当前时刻（ms），只用于让「本阶段已用时」走动。
 * ⚠️ 它只是重渲染的节拍源，**不产生任何业务状态**，也不当计时器基准
 * （真实耗时一律用编排器写的 startTime/endTime 做减法）。
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/**
 * 当前阶段的实时已用时（ms）。
 *
 * ⚠️ 阶段未结束时编排器不给 endTime（`elapsed` 为 null），此时若直接取 0 会让
 * 「本阶段已用时」永远显示 0s，看着像卡住了。所以按 startTime 实时减——
 * startTime 也是编排器写的，这里只做减法，不自己起计时器。
 */
function liveElapsedOf(stages: StageView[], now: number): number | null {
  const cur = stages.find((s) => s.isCurrent)
  if (!cur) return null
  if (cur.elapsed !== null) return cur.elapsed
  if (cur.startTime === null) return null
  return Math.max(0, now - cur.startTime)
}

/**
 * 趋势卡右上角状态胶囊：当前档位 / 真实 vs 模拟 / 缺测说明。
 *
 * ⚠️ 终态没有「当前阶段」了，此时不再显示「待命」——那会把人读成
 * 「还没开始跑」，可实际上本轮刚刚跑完（且数据就在图上）。
 */
function TrendPill({
  cur,
  live,
  terminalStatus,
}: {
  cur?: StageView
  live: AutomationLiveState
  terminalStatus?: 'completed' | 'failed' | 'stopped'
}) {
  const last = live.samples.length ? live.samples[live.samples.length - 1] : null
  const rpm = last && typeof last.rpm === 'number' ? `${Math.round(last.rpm)} rpm` : null
  const why = [...live.samples].reverse().find((s) => s.quality?.rpm)?.quality?.rpm
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-ink-wash px-2 py-[3px] text-[11.5px] text-t2">
      <span
        className={cn(
          'h-[6px] w-[6px] shrink-0 rounded-full',
          /* 终态点不再呼吸：那不是「正在跑」的信号 */
          terminalStatus ? 'bg-p600' : 'automation-pulse bg-p700',
        )}
      />
      <span className="shrink-0">
        {terminalStatus ? `本轮已结束（${TERMINAL_LABEL[terminalStatus]}）` : cur ? cur.name : '待命'}
      </span>
      {last ? (
        <>
          <span className="text-t3">·</span>
          <span className="num shrink-0">
            {last.commanded_pwm_pct}% 档
          </span>
        </>
      ) : null}
      <span className="text-t3">·</span>
      <span className="num shrink-0 text-p700">
        {rpm ?? `转速未采集${why ? `（${why}）` : ''}`}
      </span>
      {live.plan?.simulation ? (
        <span className="shrink-0 text-alert">· 模拟数据</span>
      ) : null}
    </span>
  )
}

/** 左栏「执行动作」区块：真实调用三态，由编排器按 promise 生命周期围栏。
 *  2026-10-10 样式统一：并入左栏同一张 Panel（不再单独成卡），段头用共享 PanelHeader、
 *  行元素用人测页面左栏的行口径；三态语义与文案一字未改。 */
function ToolBlock({ tools }: { tools: AutomationToolState[] }) {
  return (
    <>
      <PanelHeader
        icon={<Zap size={17} strokeWidth={1.9} />}
        title="执行动作"
        right={<span className="num text-[12px] text-t3">{tools.length}</span>}
      />
      <div className="min-h-[160px] flex-1 overflow-y-auto py-1">
        {tools.length ? (
          tools.map((t) => (
            <Tooltip key={t.id} className="w-full" content={t.message ?? t.label}>
              <div className="flex min-h-[32px] items-center gap-2 py-1 pr-3 pl-3">
                <span
                  className={cn(
                    'h-[6px] w-[6px] shrink-0 rounded-full',
                    t.status === 'failed'
                      ? 'bg-alert'
                      : t.status === 'done'
                        ? 'bg-p600'
                        : t.status === 'skipped'
                          ? 'bg-t3/40'
                          : 'automation-pulse bg-ink',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    t.status === 'done' || t.status === 'skipped' ? 'text-t3' : 'text-t1',
                  )}
                >
                  {t.label}
                </span>
                <span className="num shrink-0 text-[11.5px] text-t3">
                  {t.status === 'running'
                    ? '进行中'
                    : t.status === 'done'
                      ? '已完成'
                      : t.status === 'failed'
                        ? '失败'
                        : '已跳过'}
                </span>
              </div>
            </Tooltip>
          ))
        ) : (
          <p className="px-3 py-3 text-center text-[12px] text-t3">
            尚未开始执行，第一个动作出现后这里会逐条列出
          </p>
        )}
      </div>
    </>
  )
}

/** 中栏执行日志流：深色底 + 等宽字体，四级色 */
const LOG_CLS: Record<AutomationLogEntry['level'], string> = {
  info: 'text-white/75',
  success: 'text-[#7FD1A8]',
  warn: 'text-[#F0C36D]',
  error: 'text-[#F09A9E]',
}

function LogStream({ logs }: { logs: AutomationLogEntry[] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  // 新的日志在末尾，滚到底部才能看到最新一条（倒序不装，用原生滚动更符合阅读习惯）
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  return (
    <section className="flex min-h-0 flex-col rounded-tps bg-[#1A2320]">
      {/* ⚠️ 头部右侧留 52px：右上角悬浮着圆形 AI 按钮（不随卷动位移），
          不给「N 条」计数让位的话会被按钮压住。 */}
      <header className="flex shrink-0 items-center gap-1.5 py-1.5 pr-[52px] pl-3 text-[10.5px] font-semibold tracking-[0.08em] text-white/45 uppercase">
        执行日志
        <span className="num ml-auto tracking-normal">{logs.length} 条</span>
      </header>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {logs.length ? (
          logs.map((l) => (
            <div key={l.seq} className="automation-log-line mono flex gap-2 text-[11px] leading-[18px]">
              <span className="num shrink-0 text-white/30">{fmtClock(l.at)}</span>
              <span className={cn('min-w-0 flex-1 break-words', LOG_CLS[l.level])}>{l.message}</span>
            </div>
          ))
        ) : (
          <p className="py-2 text-[11px] text-white/35">
            等待第一条执行记录…（参数落库、闸门代确认、指令下发、各档采集、判定结果都会出现在这里）
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * 卡片栈右上角的圆形「AI」按钮（2026-10-10）。
 *
 * 定位：悬浮在卡片之上、绝对右上角，**不随卷动位移**（两态同一位、恒可点击）。
 * 语义随状态切换（`aria-pressed` / `aria-label` / tooltip），两态都用同一枚按钮。
 * 视觉：墨绿渐充实心 + 白色加粗「AI」，悬浮阴影营造漂浮感；hover 轻微放大、
 * active 下压、focus-visible 显式描边环；助手态加一圈激活光环以示「已展开」。
 */
function ConsoleAiButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="auto-log-ai-toggle"
      aria-pressed={active}
      aria-label={active ? '返回执行日志' : '切换到 AI 助手'}
      title={active ? '返回执行日志' : '切换到 AI 助手'}
      onClick={onClick}
      className={cn(
        'grad-ink absolute top-1.5 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-full',
        'text-[12px] font-bold text-white shadow-tpink transition-transform',
        'hover:scale-105 active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        active ? 'ring-2 ring-p100' : '',
      )}
    >
      AI
    </button>
  )
}

/** 右栏执行进度卡：阶段完成数 / 总数 + 进度条（取真实阶段状态，不按时间假推） */
function ProgressCard({ stageStats }: { stageStats: StageStats }) {
  const done = stageStats.done + stageStats.skipped
  const total = stageStats.total
  const failed = stageStats.failed > 0
  return (
    <section className="shrink-0 rounded-tps border border-line-soft bg-surface px-3 py-2.5">
      <h2 className="text-[12.5px] font-semibold text-t1">执行进度</h2>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="num text-[24px] leading-none font-bold text-p700">{done}</span>
        <span className="num text-[12px] text-t3">/ {total} 个阶段</span>
      </div>
      <div className="mt-2 h-[6px] w-full overflow-hidden rounded-full bg-p100">
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', failed ? 'bg-alert' : 'grad-ink')}
          style={{ width: fmtPct(done, total) === '—' ? '0%' : fmtPct(done, total) }}
        />
      </div>
    </section>
  )
}

/** 右栏判据面板：四类计数分列 + 判据逐条（不适用单列，逐条写明缺什么） */
function VerdictPanel({ stats, rows }: { stats: VerdictStats; rows: VerdictView[] }) {
  const cells: { label: string; n: number; cls: string }[] = [
    { label: '通过', n: stats.pass, cls: 'text-p700' },
    { label: '不通过', n: stats.fail, cls: stats.fail > 0 ? 'text-alert' : 'text-t3' },
    { label: '未采集', n: stats.missing, cls: 'text-t2' },
    { label: '本台架不适用', n: stats.notApplicable, cls: 'text-t3' },
  ]
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-tps border border-line-soft bg-surface">
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-3 py-2">
        <AlertTriangle size={14} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[12.5px] font-semibold text-t1">判定结果</h2>
        <span className="num ml-auto text-[11.5px] text-t3">{stats.total === null ? '待判定' : `${stats.total} 条`}</span>
      </header>
      <div className="grid shrink-0 grid-cols-4 gap-1 border-b border-line-soft px-3 py-2">
        {cells.map((c) => (
          <div key={c.label} className="flex flex-col items-center gap-0.5">
            <span className={cn('num text-[17px] leading-none font-bold', c.cls)}>
              {stats.total === null ? '—' : c.n}
            </span>
            <span className="text-center text-[10px] leading-tight text-t3">{c.label}</span>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {rows.length ? (
          rows.map((v) => (
            <Tooltip key={v.reqId} className="w-full" content={`${v.reqId} · ${v.detail || v.name}`}>
              <div
                className={cn(
                  'mb-1 flex items-center gap-1.5 rounded-tps px-2 py-1.5',
                  v.tone === 'fail' ? 'bg-alert-wash' : 'bg-sunk',
                )}
              >
                <span
                  className={cn(
                    'h-[6px] w-[6px] shrink-0 rounded-full',
                    v.tone === 'pass'
                      ? 'bg-p600'
                      : v.tone === 'fail'
                        ? 'bg-alert'
                        : v.tone === 'manual'
                          ? 'bg-warn'
                          : 'bg-t3/40',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-t1">{v.name}</span>
                <span
                  className={cn(
                    'num max-w-[45%] shrink-0 truncate text-[10.5px]',
                    v.tone === 'fail' ? 'text-alert' : 'text-t3',
                  )}
                >
                  {v.valueText}
                </span>
              </div>
            </Tooltip>
          ))
        ) : (
          <p className="px-1 py-3 text-center text-[11.5px] leading-5 text-t3">
            本轮判定还没出来。判定由后端出权威结论，跑完一轮后逐条列出——
            缺测的项会写「未采集」，本台架测不了的会写明缺哪台设备。
          </p>
        )}
      </div>
    </section>
  )
}
