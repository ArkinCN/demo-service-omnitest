import { useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import {
  AlertOctagon,
  Archive,
  Check,
  CheckCheck,
  CircleSlash,
  Eye,
  CheckCircle2,
  Download,
  FileSignature,
  FolderPlus,
  Layers,
  ListChecks,
  Lock,
  PlayCircle,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Wand2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Avatar, Button, Segmented, StatusDot, Tooltip, cn } from '../components/ui'
import { FLOWS, FLOW_BY_PATH } from '../data/flows'
import type { FlowId } from '../data/types'
import { FLOW_ICON, FLOW_SHORT, MODULE_ICON, MODULE_SHORT } from './icons'
import { useKnowledgeTotal } from '../features/knowledge/data'
import { RUN_PHASE_LABEL, flowStateOf, useAppStore } from '../state/useAppStore'
import { useFlowActions } from '../features/redline'
import { ProductCascader } from './ProductCascader'

/** 动作条图标：按动作 id 映射，缺省给一枚通用图标 */
const ACTION_ICON: Record<string, LucideIcon> = {
  upload: Upload,
  'new-class': FolderPlus,
  'to-exp': Sparkles,
  'manage-entry': ListChecks,
  autofill: Wand2,
  'save-tpl': Save,
  validate: CheckCircle2,
  lock: Lock,
  'pick-wf': Layers,
  'import-std': Upload,
  'edit-wf': ListChecks,
  baseline: ShieldCheck,
  start: PlayCircle,
  precheck: ShieldCheck,
  stop: Square,
  estop: AlertOctagon,
  'adopt-back': CheckCheck,
  'ignore-all': CircleSlash,
  rollback: RotateCcw,
  'view-evidence': Search,
  'gen-report': FileSignature,
  preview: Eye,
  export: Download,
  'archive-kb': Archive,
  search: Search,
}

/**
 * 把自动化阶段 id 映射到对应的五流程 id（route 取 /init 等）。
 * 阶段与流程不是一一对应（7 阶段 vs 5 流程），这里按 route 归属到流程，
 * 让顶部 stepper 能跟着自动化阶段点亮/失败。
 */
function flowOfAutomationStage(stageId: string | null): FlowId | null {
  if (!stageId) return null
  switch (stageId) {
    case 'init-params':
      return 'init'
    case 'load-cases':
      return 'req'
    case 'check-env':
    case 'run-cases':
    case 'collect-result':
      return 'run'
    case 'gen-report':
    case 'download-report':
      return 'report'
    default:
      return null
  }
}

/** 五流程 stepper：圆形序号 / 打勾，短名 ≤6 字。知识库不在其中。
 *  自动化运行期间，当前阶段对应的流程高亮脉冲、已完成成功态、失败错误态。
 *
 *  2026-10-09 改造（用户反馈）：
 *   ① 「上方的 UI 太宽」——容器原为 `flex-1`，被拉伸占满顶栏剩余宽度，观感横跨全屏。
 *      现去掉 `flex-1`，改为**按内容自适应宽度 + 自身居中**（`relative` + `mx-auto` 语义），
 *      并把阶段内边距（px-2.5→px-2）、阶段间距（mx-1.5→mx-1）、连接线（w-4/lg:w-7→w-3/lg:w-5）各收一档。
 *   ② 「阶段之间需要有动效」——原来每项各自 `bg-p50` 淡入淡出，**无位移**。
 *      现改为**单一绝对定位高亮块**（`FLOW_PILL`），随激活项 `translateX` 平滑滑动过去。
 *      测量用 `useLayoutEffect` + `ResizeObserver`（断点/窗口变化时重测），避免错位。
 */
function FlowStepper() {
  const { pathname } = useLocation()
  // 模块路由（/knowledge）不属于任何一步，此时 stepper 不点亮任何一步
  const current = FLOW_BY_PATH[pathname] ?? FLOWS[0]
  const onFlow = !!FLOW_BY_PATH[pathname]
  const scene = useAppStore((s) => s.scene)
  const confirmed = useAppStore((s) => s.confirmed)
  // 自动化运行态：订阅阶段列表与当前阶段，用于顶栏实时点亮
  const autoRunning = useAppStore((s) => s.automationRunStatus === 'running')
  const autoStages = useAppStore((s) => s.automationStages)
  const autoCurrent = useAppStore((s) => s.automationCurrentStageId)

  // ── 滑动高亮块：测量当前激活项相对 nav 的 offsetLeft/offsetWidth ──────────────
  const navRef = useRef<HTMLElement>(null)
  // null = 尚未测量 / 非流程页（不显示高亮），避免首帧从 0 位滑入的抖动
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const measure = () => {
      if (!onFlow) {
        setPill(null)
        return
      }
      const el = nav.querySelector<HTMLElement>('[data-active="true"]')
      if (!el) {
        setPill(null)
        return
      }
      // offsetLeft/offsetWidth 相对 offsetParent；nav 已设 relative → 恰好是相对 nav 的坐标
      setPill({ x: el.offsetLeft, w: el.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(nav)
    // 断点切换（lg）会改变连接线宽度 → 触发 nav 尺寸变化，ResizeObserver 已覆盖；
    // 另监听字体加载完成后的一次重测，避免 web font 落地后宽度跳动导致错位。
    if (document.fonts?.ready) void document.fonts.ready.then(measure)
    return () => ro.disconnect()
  }, [current.id, onFlow, autoCurrent, autoRunning])

  return (
    <nav ref={navRef} aria-label="五流程" className="relative flex min-w-0 items-center justify-center">
      {/* 滑动高亮底：纯装饰（aria-hidden），随激活项做 transform 位移。
          --flow-pill-dur 由 CSS 控制（prefers-reduced-motion 下降级为 0）。 */}
      {pill && onFlow ? (
        <span
          aria-hidden
          data-testid="flow-stepper-pill"
          className="flow-pill absolute inset-y-1 rounded-full bg-p50"
          style={{ transform: `translateX(${pill.x}px)`, width: pill.w }}
        />
      ) : null}
      {FLOWS.map((f, i) => {
        const state = flowStateOf(f.id, current.id, scene, confirmed)
        const on = onFlow && f.id === current.id
        const done = state === 'confirmed'
        const Icon = FLOW_ICON[f.id]
        // 自动化：当前阶段命中的流程 → 高亮脉冲；该流程已有成功阶段 → 成功态；失败 → 错误态
        const autoFlow = autoRunning ? flowOfAutomationStage(autoCurrent) : null
        const autoIsCurrent = autoRunning && autoFlow === f.id
        const autoStageForFlow = autoStages.find((s) => flowOfAutomationStage(s.id) === f.id)
        const autoDone = autoRunning && autoStageForFlow?.status === 'success'
        const autoFailed = autoRunning && autoStageForFlow?.status === 'failed'
        return (
          <div key={f.id} className="flex min-w-0 items-center">
            {i > 0 ? (
              <span
                className={cn(
                  // 2026-10-09 收窄：连接线 mx-1.5→mx-1、w-4→w-3、lg:w-7→lg:w-5
                  'relative z-10 mx-1 h-px w-3 shrink-0 transition-colors lg:w-5',
                  autoIsCurrent ? 'automation-arrow' : autoDone ? 'bg-p700' : 'bg-line',
                )}
              />
            ) : null}
            <NavLink
              to={f.path}
              data-active={on ? 'true' : undefined}
              title={`${f.index} ${f.label}${f.precondition ? ` · ${f.precondition}` : ''}`}
              className={cn(
                // 2026-10-09：底色改由上面的滑动高亮块承担，这里只留 hover 的轻反馈；
                // relative + z-10 让文字/圆标盖在高亮块之上。px-2.5→px-2、gap-2→gap-1.5 收窄。
                'relative z-10 flex h-[40px] shrink-0 items-center gap-1.5 rounded-full px-2 transition-colors duration-150',
                on ? '' : 'hover:bg-p50/60',
              )}
            >
              <span
                className={cn(
                  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-all duration-200 [&>svg]:block',
                  autoFailed
                    ? 'bg-alert text-white'
                    : autoIsCurrent
                      ? 'grad-ink text-white shadow-tpink automation-pulse'
                      : on
                        ? 'grad-ink text-white shadow-tpink'
                        : done || autoDone
                          ? 'bg-p100 text-p700'
                          : 'border border-line bg-white text-t3',
                )}
              >
                {autoFailed ? (
                  <AlertOctagon size={14} strokeWidth={2.5} />
                ) : done || autoDone ? (
                  <Check size={14} strokeWidth={2.5} />
                ) : on ? (
                  <Icon size={14} strokeWidth={2} />
                ) : (
                  f.index
                )}
              </span>
              <span
                className={cn(
                  'text-[13px] whitespace-nowrap transition-colors',
                  autoFailed
                    ? 'text-alert'
                    : on
                      ? 'font-semibold text-p700'
                      : done || autoDone
                        ? 'text-t2'
                        : 'text-t3',
                )}
              >
                {FLOW_SHORT[f.id]}
              </span>
              {state === 'alert' ? <StatusDot status="alert" /> : null}
            </NavLink>
          </div>
        )
      })}
    </nav>
  )
}

const KnowledgeIcon = MODULE_ICON.knowledge

export function TopBar() {
  const { pathname } = useLocation()
  const onFlow = !!FLOW_BY_PATH[pathname]
  const current = FLOW_BY_PATH[pathname] ?? FLOWS[0]
  const benchBusy = useAppStore((s) => s.benchBusy)
  const benchUser = useAppStore((s) => s.benchUser)
  const pending = useAppStore((s) => s.interlockPending)
  const demoMode = useAppStore((s) => s.demoMode)
  const setDemoMode = useAppStore((s) => s.setDemoMode)
  // 取数是异步的，用 hook 订阅才会在落地后重渲；同步函数取值会永远停在 0
  const kbTotal = useKnowledgeTotal()
  const bind = useFlowActions()
  const runPhase = useAppStore((s) => s.runPhase)
  const gateTotal = useAppStore((s) => s.gateTotal)
  const gateAcked = useAppStore((s) => s.gateAcked)
  const autoRunning = useAppStore((s) => s.automationRunStatus === 'running')
  // ⚠️ 点击**不再直接开跑**（2026-10-05 用户实测「点了界面一闪而过」）：
  // 只置引导位 → 弹全屏引导屏讲清五步/预计耗时/会真下发设备启动 →
  // 人在屏上点「开始测试」才真调 startAutomation()。
  const setAutomationIntent = useAppStore((s) => s.setAutomationIntent)
  const stopAutomation = useAppStore((s) => s.stopAutomation)

  // 动作条右端那行字只在流程 3 报运行态：别的流程没有「启动」这回事，
  // 报「待启动」等于给一条不存在的进度。
  const gateBlocked = current.id === 'run' && !(gateTotal > 0 && gateAcked.length >= gateTotal)
  const statusText =
    current.id !== 'run' ? '就绪' : gateBlocked ? '闸门未放行' : RUN_PHASE_LABEL[runPhase]
  const statusTone: 'empty' | 'done' | 'alert' =
    current.id !== 'run'
      ? 'done'
      : gateBlocked
        ? 'empty'
        : runPhase === 'estopped'
          ? 'alert'
          : 'done'

  return (
    <header className="shrink-0">
      {/* 顶栏 64 · 品牌 / 六流程 stepper / 场景包与人 */}
      <div className="flex h-[64px] items-center gap-4 border-b border-line bg-surface"
        style={{ paddingInline: 'clamp(18px, 1.7vw, 32px)' }}>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="grad-ink flex h-[32px] w-[32px] items-center justify-center rounded-tps text-[15px] font-bold text-white shadow-tpink">
            O
          </span>
          <span className="text-[19px] leading-none font-bold tracking-tight text-t1">
            Omni<span className="text-p700">Test</span>
          </span>
        </div>

        {/* 「智能测试」一键自动化入口：初始化左侧。运行中变「终止」，点一下停掉整个自动化流程。
            ⚠️ 非运行态点击只**打开引导屏**（不直接开跑），人在引导屏确认后才启动——
            这样才有「点了发生什么」的可感知反馈，而不是界面一闪而过。 */}
        <Tooltip
          content={
            autoRunning
              ? '自动化回归进行中，点此终止'
              : '一键自动化回归：全屏接管 · 自动选定参数 → 按五步推进 → 产出报告，全程可见可终止'
          }
        >
          <Button
            size="sm"
            data-action={autoRunning ? 'automation-stop' : 'automation-start'}
            variant={autoRunning ? 'danger' : 'default'}
            icon={<PlayCircle size={14} strokeWidth={1.75} />}
            onClick={autoRunning ? stopAutomation : () => setAutomationIntent(true)}
          >
            {autoRunning ? '终止' : '自动化测试'}
          </Button>
        </Tooltip>

        {/* 2026-10-09：给 stepper 套一层**居中槽**——槽用 flex-1 吸收剩余空间，
            但 stepper 自身按内容宽度自适应（不再拉伸），于是整条**收窄居中**在顶栏中部。 */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <FlowStepper />
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {/* 知识库是基础模块不是第六步：与 stepper 之间隔一条竖线，
              视觉上跟五步主线断开 */}
          <span className="h-[26px] w-px bg-line" />
          <Tooltip content="知识库 · 五条流程共用的基础模块">
            <NavLink
              to="/knowledge"
              className={({ isActive }) =>
                cn(
                  'flex h-[30px] items-center gap-1.5 rounded-full border px-2.5 transition-colors',
                  isActive
                    ? 'border-ink bg-ink-wash text-p700'
                    : 'border-line bg-white text-t2 hover:border-ink hover:text-p700',
                )
              }
            >
              <KnowledgeIcon size={14} strokeWidth={1.75} />
              <span className="text-[12px]">{MODULE_SHORT.knowledge}</span>
              <span className="num text-[11px] text-t3">{kbTotal}</span>
            </NavLink>
          </Tooltip>
          <ProductCascader />
          {/* 演示 / 全量：只切展示面，两边读的都是同一份场景包，不删任何数据 */}
          <Tooltip content="演示只露场景包 demo_profile 点名的那几项；全量把登记过的全表摊开，供评审对照。两边数据同源。">
            <span>
              <Segmented
                ariaLabel="演示模式"
                size="sm"
                value={demoMode ? 'demo' : 'full'}
                onChange={(v) => setDemoMode(v === 'demo')}
                items={[
                  { value: 'demo', label: '演示' },
                  { value: 'full', label: '全量' },
                ]}
              />
            </span>
          </Tooltip>
          <Tooltip content={benchBusy ? `台架被 ${benchUser} 占用中` : '台架空闲，可排队启动'}>
            <span className="flex h-[30px] items-center gap-1.5 rounded-full border border-line bg-white px-2.5">
              <StatusDot status={benchBusy ? 'alert' : 'done'} pulse={!benchBusy} />
              <span className="text-[12px] text-t2">{benchBusy ? '占用' : '空闲'}</span>
            </span>
          </Tooltip>
          <Tooltip content={pending ? `安全联锁还有 ${pending} 项待确认` : '安全联锁就绪'}>
            <span className="flex h-[30px] items-center gap-1.5 rounded-full border border-line bg-white px-2.5 text-t2">
              <ShieldCheck size={14} strokeWidth={1.75} className={pending ? 'text-warn' : 'text-p600'} />
              <span className="num text-[12px]">{pending ? pending : '就绪'}</span>
            </span>
          </Tooltip>
          <Avatar name="张" size={30} />
        </div>
      </div>

      {/* 动作条 48 · 次表面浅绿，左动作右状态。模块页没有流程动作，整条不渲染 */}
      {onFlow ? (
      <div className="flex h-[48px] items-center gap-2 border-b border-line bg-p50"
        style={{ paddingInline: 'clamp(18px, 1.7vw, 32px)' }}>
        {current.actions.slice(0, 4).map((a) => {
          const Icon = ACTION_ICON[a.id] ?? Sparkles
          const b = bind(a.id)
          // 置灰理由一律现算：闸门差几条、有没有勾采纳项，都从 store 取，
          // 不再写死在 data/flows.ts 里（08c 第零节「点不动的三处」第 2 条）
          const reason = b.disabled ? (b.reason ?? a.disabledReason) : undefined
          const btn = (
            <Button
              key={a.id}
              size="sm"
              disabled={b.disabled}
              onClick={b.onClick}
              data-action={a.id}
              variant={a.primary ? 'primary' : a.danger ? 'danger' : 'default'}
              icon={<Icon size={14} strokeWidth={1.75} />}
            >
              {a.label}
            </Button>
          )
          return reason ? (
            <Tooltip key={a.id} content={reason} side="bottom">
              <span className="cursor-not-allowed">{btn}</span>
            </Tooltip>
          ) : (
            btn
          )
        })}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-t2">
          <StatusDot status={statusTone} pulse={runPhase === 'running'} />
          {statusText}
        </span>
      </div>
      ) : null}
    </header>
  )
}
