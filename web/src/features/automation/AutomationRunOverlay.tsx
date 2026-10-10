import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../components/ui'
import { FLOWS } from '../../data/flows'
import { useAppStore } from '../../state/useAppStore'
import { buildStageViews, buildVerdictViews } from './automationViewModel'
import { AutomationConsole } from './AutomationConsole'
import { AutomationIntro } from './AutomationIntro'
import { AutomationResult } from './AutomationResult'
import { AutomationStageFlow } from './AutomationStageFlow'

/* ===========================================================================
   自动化回归 · 全屏接管容器（三屏路由）

   2026-10-08：由「居中模态卡」改为**整屏接管**。
   为什么改：自动化会横跨五个流程跑。弹窗遮住底层页面时，人既看不到参数被
   改成什么、也看不到台架采到的曲线，「一键」就变成了盲跑。

   2026-10-09（本轮）：**结果由「整屏结果页」改为「运行台之上的完成弹窗」**。
   为什么改：跑完之后人最想做的两件事是「看这轮采到的曲线/日志/判定」和
   「看结论」。老实现把结果做成整屏页，一关就整层卸载 → 回到人测页，本轮
   数据（趋势/日志/进度/判定）当场消失，想复查只能重跑。现在：

     · 终态不再让整层卸载，`AutomationConsole` 常驻（三栏、分隔条、图表、
       滚动位置全部保住 —— running→result 不重挂载是刻意的）；
     · `AutomationResult` 变成浮在上面的模态弹窗，`dismissed` 只控制弹窗显隐；
     · 弹窗「关闭」= 收起弹窗（停留运行台，可随时从底部「查看执行结果」再开）；
     · 右上角 ✕（文案「退出自动化测试」）= 退出全屏回归，回人测流程页。

   三态与优先级（沿用既有判定，避免「点了闪一下又变结果」的老毛病）：
     终态 > 运行态 > 引导态。终态一旦成立就常驻运行台 + 弹窗（弹窗可收起）。

   纪律：
     一、运行态**不给关闭入口**（防误触打断真机流程），只有终止按钮能停；
     二、数据全部来自 store 切片（编排器事件驱动），本文件不自己算耗时；
     三、保留既有 data-testid / data-phase 契约，验收脚本不用改。
   =========================================================================== */

type Phase = 'intro' | 'running' | 'result'

export function AutomationRunOverlay() {
  const intent = useAppStore((s) => s.automationIntent)
  const runStatus = useAppStore((s) => s.automationRunStatus)
  const stages = useAppStore((s) => s.automationStages)
  const currentId = useAppStore((s) => s.automationCurrentStageId)
  const summary = useAppStore((s) => s.automationSummary)
  const tools = useAppStore((s) => s.automationTools)
  const logs = useAppStore((s) => s.automationLogs)
  const live = useAppStore((s) => s.automationLive)
  const verdicts = useAppStore((s) => s.automationVerdicts)
  const gateAcked = useAppStore((s) => s.gateAcked)
  const startAutomation = useAppStore((s) => s.startAutomation)
  const stopAutomation = useAppStore((s) => s.stopAutomation)
  const clearAutomation = useAppStore((s) => s.clearAutomation)
  const setAutomationIntent = useAppStore((s) => s.setAutomationIntent)

  /**
   * 本地「弹窗已收起」位。
   *
   * ⚠️ 它**只控制完成弹窗的显隐**，不再让整层 overlay 卸载（2026-10-09 改）。
   * 老实现是 `dismissed → phase=null`，关掉结果卡等于退出全屏，运行台数据全丢。
   * 新轮次启动时复位（intent false→true 边沿），保证新一轮跑完弹窗照常弹出。
   */
  const [dismissed, setDismissed] = useState(false)
  const wasIntent = useRef(false)
  if (intent && !wasIntent.current) {
    wasIntent.current = true
    if (dismissed) setDismissed(false)
  }
  if (!intent && wasIntent.current) wasIntent.current = false

  const isFinal = runStatus === 'completed' || runStatus === 'failed' || runStatus === 'stopped'
  const phase: Phase | null = isFinal
    ? 'result'
    : runStatus === 'running'
      ? 'running'
      : intent
        ? 'intro'
        : null
  /** 终态类型（非终态为 undefined）；运行台据此把「终止」换掉、状态条改文案 */
  const terminalStatus: 'completed' | 'failed' | 'stopped' | undefined = isFinal
    ? (runStatus as 'completed' | 'failed' | 'stopped')
    : undefined
  /** 完成弹窗是否打开：只有终态且人没收起它时才盖在运行台上 */
  const resultDialogOpen = isFinal && !dismissed

  const { views, stats: stageStats } = buildStageViews(
    stages,
    FLOWS.map((f) => ({ id: f.id, index: f.index, name: f.label })),
    currentId,
  )
  const { stats: liveVerdictStats } = buildVerdictViews(verdicts)

  /**
   * 完成弹窗用的判定统计（2026-10-09 修）。
   *
   * ⚠️ **不能只用 `buildVerdictViews(verdicts)`**：`verdicts` 是右栏的**实时**判定表，
   * 它不持久化（见 AutomationLiveState），刷新恢复或快照恢复后就是空数组 →
   * `total=null` → 弹窗徽章与「判定通过比」双双显示「—」，明明本轮判了 20 条却像没测。
   * （实测：`_syncAutomation` 落终态后徽章渲染成「—」，而 `summary.metrics.total=20`。）
   *
   * 口径（诚实优先，不编数字）：
   *   · `summary.metrics.total > 0` → **以后端/编排器落库的 metrics 为准**（权威且跨刷新有效）；
   *   · metrics 全 0（判定表还没来）→ 退回实时判定表统计，取不到仍是 `total=null`（显示「—」）；
   *   · 两处都取不到 → 保持「—」，**绝不用 0 冒充**。
   */
  const verdictStats =
    summary.metrics.total > 0
      ? {
          pass: summary.metrics.pass,
          fail: summary.metrics.fail,
          missing: summary.metrics.missing,
          notApplicable: summary.metrics.notApplicable,
          total: summary.metrics.total,
        }
      : liveVerdictStats

  /* 整屏接管期间锁掉底层滚动：不应还能滚到背后的人测页 */
  useEffect(() => {
    if (!phase) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [phase])

  /**
   * 收起完成弹窗（停留运行台）。
   *
   * ⚠️⚠️ 这里**绝不能调 `clearAutomation()`**（2026-10-09 实测栽过）：
   * `clearAutomation()` 会把 `automationRunStatus` 复位成 `idle`，于是
   * `phase` 立刻变 null → 整层 overlay 卸载。表现是「点关闭不但没停留，
   * 反而直接退出了全屏回归」，且运行台数据全丢——正是本次要修的那个问题
   * 换了个触发点复现。收起弹窗只动 `dismissed` 这一个本地位。
   */
  const dismissResult = () => setDismissed(true)
  /**
   * 退出全屏回归：回人测流程页。
   * ⚠️ 不加「运行中则忽略」的守卫：运行态根本不给 ✕ 入口（见 HeaderBar），
   * 调用方只可能是引导态/结果态，多一层守卫反而会掩盖入口回归的问题。
   */
  const exitOverlay = () => {
    setDismissed(true)
    setAutomationIntent(false)
    clearAutomation()
  }
  /** 重新运行＝回到引导屏（仍让人确认一次现场安全，不直接开跑） */
  const retry = () => {
    setDismissed(true)
    clearAutomation()
    setAutomationIntent(true)
  }
  const viewReport = () => {
    exitOverlay()
    void import('../../router').then(({ router }) => router.navigate('/report'))
  }
  const redownload = () => {
    void import('../flow-report/reportApi').then(async ({ downloadUrl, resolveReportRunId }) => {
      const st = useAppStore.getState()
      try {
        const rid = await resolveReportRunId(st.sceneId, st.runId)
        const a = document.createElement('a')
        a.href = downloadUrl(rid)
        a.download = ''
        document.body.appendChild(a)
        a.click()
        a.remove()
      } catch (e) {
        // 失败如实抛出到控制台；不给用户「已下载」的假反馈
        console.error('[automation] 重新下载报告失败：', e)
        st.setNotice(`重新下载失败：${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  const closeIntro = () => exitOverlay()

  /*
   * ⚠️ 无运行态时**必须整层不渲染**（2026-10-09 修「打开项目一片空白」）。
   *
   * 真因：本组件挂在 Shell 根部、常驻挂载。老实现漏了这层守卫 → `phase === null`
   * （intent=false 且 runStatus=idle，即平时打开页面）时，外层
   * `<div class="automation-takeover fixed inset-0 z-50 flex flex-col bg-page">`
   * 照样渲染：一个 **z-50 的全屏 div，内部三个分支全不渲染 → 空壳**。
   * 且 `bg-page` 并非有效工具类（样式表里没有），该层是**透明**的 →
   * 底层人测页被完全盖住却一个像素都不画，DOM 里什么都在（rootLen 9 万+），
   * 视觉上就是「一片空白」。Playwright 实测：`elementFromPoint(10,10)` 命中
   * 的正是这个 `.automation-takeover`。
   *
   * 修法：保持「挂载常驻」不变（卸载会丢 running→result 的常驻运行台），
   * 只在**渲染层**加守卫——三态都不成立时返回 null。
   */
  if (!phase) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="一键自动化回归"
      data-testid="automation-overlay"
      data-phase={phase}
      className="automation-takeover fixed inset-0 z-50 flex flex-col bg-page"
    >
      {/* 引导屏：同样给顶栏，保持「这是全屏模式」的认知一致 */}
      {phase === 'intro' ? (
        <>
          <HeaderBar phase={phase} runId={null} onClose={closeIntro} />
          <AutomationIntro
                gateAcked={gateAcked.length}
                onStart={startAutomation}
             onCancel={closeIntro}
              />
        </>
      ) : null}

      {/*
        运行台（运行态与终态共用同一分支）：
        ⚠️ 刻意**不拆成两个分支**——running→result 若换分支，Console 会被卸载重建，
        图表、日志滚动位置、分隔条比例全部重置。终态只是「多盖一层弹窗」，
        底座必须原样留着，人收起弹窗才能接着看本轮数据。
      */}
      {phase === 'running' || phase === 'result' ? (
        <>
          <HeaderBar
            phase={phase}
            runId={summary.runId}
            views={views}
            onClose={phase === 'running' ? undefined : closeIntro}
          />
          <main className="relative flex min-h-0 flex-1 flex-col p-3">
            <AutomationConsole
                stages={views}
                stageStats={stageStats}
                live={live}
              tools={tools}
              logs={logs}
              verdicts={verdicts}
              onStop={stopAutomation}
              terminalStatus={terminalStatus}
              onShowResult={isFinal && dismissed ? () => setDismissed(false) : undefined}
            />

            {/* 完成弹窗：浮在运行台之上，收起后运行台全貌可见 */}
            {resultDialogOpen ? (
              <AutomationResult
                status={runStatus as 'completed' | 'failed' | 'stopped'}
                stages={views}
                stats={verdictStats}
                summary={summary}
                onDismiss={dismissResult}
                onRetry={retry}
                onViewReport={viewReport}
                onRedownload={redownload}
              />
            ) : null}
          </main>
        </>
      ) : null}
    </div>
  )
}

/** 全屏顶栏：品牌 + 模式标 + 五步骤流光条 + 轮次号 + 退出 */
function HeaderBar({
  phase,
  runId,
  views,
  onClose,
}: {
  phase: Phase
  runId: string | null
  views?: ReturnType<typeof buildStageViews>['views']
  onClose: (() => void) | undefined
}) {
  return (
    <header
      className="flex h-[max(56px,var(--auto-header-h,56px))] shrink-0 items-center gap-3 border-b border-line bg-surface px-4"
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="grad-ink flex h-[28px] w-[28px] items-center justify-center rounded-tps text-[14px] font-bold text-white shadow-tpink">
          O
        </span>
        <span className="text-[16px] leading-none font-bold tracking-tight text-t1">
          Omni<span className="text-p700">Test</span>
        </span>
        <span className="rounded-full bg-p100 px-2 py-[3px] text-[10.5px] font-medium text-p700">
          全屏自动回归
        </span>
      </div>

      {views && views.length ? (
        <div className="flex min-w-0 flex-1 items-center px-2">
          <AutomationStageFlow views={views} />
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}

      {runId ? <span className="num shrink-0 text-[11.5px] text-t3">轮次 {runId.slice(0, 8)}</span> : null}

      {/* 运行态不给退出入口：真机流程只能靠「终止」停，误关会让人以为跑完了 */}
      {onClose ? (
        <button
          type="button"
          aria-label="退出自动化测试"
          data-testid="automation-close"
          onClick={onClose}
          className={cn(
            'inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-tpx border border-transparent text-t3 transition-colors',
            phase === 'running'
              ? 'cursor-not-allowed opacity-40'
              : 'cursor-pointer hover:bg-p50 hover:text-p700',
          )}
          title={phase === 'running' ? '运行中不可退出，请先终止' : '退出自动化测试'}
        >
          <X size={15} strokeWidth={2} />
        </button>
      ) : null}
    </header>
  )
}
