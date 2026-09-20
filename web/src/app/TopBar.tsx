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

/** 五流程 stepper：圆形序号 / 打勾，短名 ≤6 字。知识库不在其中。 */
function FlowStepper() {
  const { pathname } = useLocation()
  // 模块路由（/knowledge）不属于任何一步，此时 stepper 不点亮任何一步
  const current = FLOW_BY_PATH[pathname] ?? FLOWS[0]
  const onFlow = !!FLOW_BY_PATH[pathname]
  const scene = useAppStore((s) => s.scene)
  const confirmed = useAppStore((s) => s.confirmed)

  return (
    <nav aria-label="五流程" className="flex min-w-0 flex-1 items-center justify-center">
      {FLOWS.map((f, i) => {
        const state = flowStateOf(f.id, current.id, scene, confirmed)
        const on = onFlow && f.id === current.id
        const done = state === 'confirmed'
        const Icon = FLOW_ICON[f.id]
        return (
          <div key={f.id} className="flex min-w-0 items-center">
            {i > 0 ? <span className="mx-1.5 h-px w-4 shrink-0 bg-line lg:w-7" /> : null}
            <NavLink
              to={f.path}
              title={`${f.index} ${f.label}${f.precondition ? ` · ${f.precondition}` : ''}`}
              className={cn(
                'flex h-[40px] shrink-0 items-center gap-2 rounded-full px-2.5 transition-colors duration-150',
                on ? 'bg-p50' : 'hover:bg-p50/60',
              )}
            >
              <span
                className={cn(
                  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-all duration-200 [&>svg]:block',
                  on
                    ? 'grad-ink text-white shadow-tpink'
                    : done
                      ? 'bg-p100 text-p700'
                      : 'border border-line bg-white text-t3',
                )}
              >
                {done ? <Check size={14} strokeWidth={2.5} /> : on ? <Icon size={14} strokeWidth={2} /> : f.index}
              </span>
              <span
                className={cn(
                  'text-[13px] whitespace-nowrap transition-colors',
                  on ? 'font-semibold text-p700' : done ? 'text-t2' : 'text-t3',
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

        <FlowStepper />

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
