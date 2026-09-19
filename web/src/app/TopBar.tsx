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
import { Avatar, Button, StatusDot, Tooltip, cn } from '../components/ui'
import { FLOWS, FLOW_BY_PATH } from '../data/flows'
import { FLOW_ICON, FLOW_SHORT } from './icons'
import { flowStateOf, useAppStore } from '../state/useAppStore'
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

/** 六流程 stepper：圆形序号 / 打勾，短名 ≤6 字 */
function FlowStepper() {
  const { pathname } = useLocation()
  const current = FLOW_BY_PATH[pathname] ?? FLOWS[0]
  const scene = useAppStore((s) => s.scene)
  const confirmed = useAppStore((s) => s.confirmed)

  return (
    <nav aria-label="六流程" className="flex min-w-0 flex-1 items-center justify-center">
      {FLOWS.map((f, i) => {
        const state = flowStateOf(f.id, current.id, scene, confirmed)
        const on = f.id === current.id
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

export function TopBar() {
  const { pathname } = useLocation()
  const current = FLOW_BY_PATH[pathname] ?? FLOWS[0]
  const benchBusy = useAppStore((s) => s.benchBusy)
  const benchUser = useAppStore((s) => s.benchUser)
  const pending = useAppStore((s) => s.interlockPending)
  const disabledAction = current.actions.find((a) => a.disabled)

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
          <ProductCascader />
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

      {/* 动作条 48 · 次表面浅绿，左动作右状态 */}
      <div className="flex h-[48px] items-center gap-2 border-b border-line bg-p50"
        style={{ paddingInline: 'clamp(18px, 1.7vw, 32px)' }}>
        {current.actions.slice(0, 4).map((a) => {
          const Icon = ACTION_ICON[a.id] ?? Sparkles
          const btn = (
            <Button
              key={a.id}
              size="sm"
              disabled={a.disabled}
              variant={a.primary ? 'primary' : a.danger ? 'danger' : 'default'}
              icon={<Icon size={14} strokeWidth={1.75} />}
            >
              {a.label}
            </Button>
          )
          return a.disabled && a.disabledReason ? (
            <Tooltip key={a.id} content={a.disabledReason} side="bottom">
              <span className="cursor-not-allowed">{btn}</span>
            </Tooltip>
          ) : (
            btn
          )
        })}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-t2">
          <StatusDot status={disabledAction ? 'empty' : 'done'} />
          {disabledAction ? '闸门未放行' : '就绪可启动'}
        </span>
      </div>
    </header>
  )
}
