import type { ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button, Tooltip, cn } from '../../components/ui'

/** 卡体：定高不滚动是壳层规格，但卡内长列表需要自己滚，这里统一给一个滚动容器。 */
export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('h-full min-h-0 overflow-y-auto pr-0.5', className)}>{children}</div>
}

/** 子组标题条：名称 + 右侧计数 */
export function GroupBar({
  title,
  count,
  right,
  onClick,
  active,
}: {
  title: string
  count?: number | string
  right?: ReactNode
  onClick?: () => void
  active?: boolean
}) {
  const inner = (
    <>
      <span className="truncate">{title}</span>
      {count !== undefined ? <span className="num ml-auto shrink-0 text-t3">{count}</span> : null}
      {right}
    </>
  )
  const cls = cn(
    'flex h-[20px] w-full items-center gap-1.5 px-1.5 text-[11px]',
    active ? 'bg-ink-wash text-ink' : 'bg-sunk text-t2',
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'text-left hover:text-ink')}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  )
}

/** 一行两列：标签 + 值 */
export function KV({
  k,
  v,
  alert,
  title,
}: {
  k: string
  v: ReactNode
  alert?: boolean
  title?: string
}) {
  return (
    <div className="flex items-baseline gap-2 py-[2px]" title={title}>
      <span className="shrink-0 text-[11px] text-t3">{k}</span>
      <span className={cn('num ml-auto truncate text-[11.5px]', alert ? 'text-alert' : 'text-t1')}>{v}</span>
    </div>
  )
}

/** 细边框标签 */
export function Tag({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'ink' | 'alert' | 'mute'
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'shrink-0 rounded-tps border px-1 text-[10px] leading-[15px] whitespace-nowrap',
        tone === 'ink' && 'border-ink bg-ink-wash text-ink',
        tone === 'alert' && 'border-alert text-alert',
        tone === 'mute' && 'border-line-soft text-t3',
        tone === 'neutral' && 'border-line text-t2',
      )}
    >
      {children}
    </span>
  )
}

/** 横向占比条，只用墨绿明度，不引第三色相 */
export function Bar({ ratio, alert }: { ratio: number; alert?: boolean }) {
  return (
    <span className="inline-block h-[4px] w-[52px] shrink-0 rounded-full bg-sunk align-middle">
      <span
        className={cn('block h-full rounded-full', alert ? 'bg-alert' : 'bg-ink')}
        style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }}
      />
    </span>
  )
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-t3">
      {text}
    </div>
  )
}

/** 列表行 */
export function Row({
  children,
  onClick,
  active,
  alert,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  alert?: boolean
  title?: string
}) {
  const cls = cn(
    'flex w-full items-center gap-1.5 border-b border-line-soft px-1.5 py-[3px] text-left text-[11.5px] last:border-b-0',
    active && 'bg-ink-wash',
    alert && !active && 'bg-alert-wash/50',
  )
  return onClick ? (
    <button type="button" title={title} onClick={onClick} className={cn(cls, 'hover:bg-ink-wash/60')}>
      {children}
    </button>
  ) : (
    <div title={title} className={cls}>
      {children}
    </div>
  )
}

/**
 * 左栏底部主按钮。六条流程共用同一形态：通栏、lg、primary 实底渐变、
 * CheckCircle2 图标，文案统一 「确认<对象> · <数字><量词>」。
 * 前置条件没满足时不换形态、不置灰——理由只挂 tooltip（DESIGN.md §4 文案纪律 4）。
 */
export function ConfirmFooter({
  label,
  count,
  unit,
  hint,
  onClick,
}: {
  label: string
  count: number | string
  unit: string
  hint: ReactNode
  onClick?: () => void
}) {
  return (
    <footer className="shrink-0 border-t border-line-soft bg-white/85 px-4 py-3 backdrop-blur">
      <Tooltip content={hint} className="w-full">
        <Button
          block
          size="lg"
          variant="primary"
          icon={<CheckCircle2 size={15} strokeWidth={2} />}
          onClick={onClick}
        >
          {label} · {count} {unit}
        </Button>
      </Tooltip>
    </footer>
  )
}
