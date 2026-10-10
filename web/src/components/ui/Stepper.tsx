import { Minus, Plus } from 'lucide-react'
import { cn } from './cn'

/**
 * 数值加减：圆形加减按钮夹着大号数字 + 小号单位。
 *
 * ⚠️ `value` 允许为 `null`（2026-09-28 新增，为「占位/待现场确认」字段服务）：
 * 这类字段在场景包里没有初始数值（值是「未知」），但**恰恰最需要人去填**。
 * 传 null 时输入框显示为空、以 placeholder 提示要填什么，
 * 而不是像以前那样因为「没有数字」而整行退化成不可编辑的只读文本。
 * 老调用点都传数字，行为完全不变。
 */
export function Stepper({
  value,
  unit,
  step = 1,
  min,
  max,
  precision = 0,
  onChange,
  disabled,
  className,
  label,
  size = 'md',
  emptyHint = '待填',
}: {
  /** 当前值；null = 还没有值（占位/待现场确认），显示为空输入框 */
  value: number | null
  unit?: string
  step?: number
  min?: number
  max?: number
  precision?: number
  onChange?: (next: number) => void
  disabled?: boolean
  className?: string
  label?: string
  size?: 'sm' | 'md'
  /** value 为 null 时输入框里的灰字提示 */
  emptyHint?: string
}) {
  const clamp = (n: number) => {
    let v = n
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return Number(v.toFixed(precision))
  }
  /** 空值时以 0 为基准步进（再被 min 夹住）；有值就正常加减 */
  const bump = (dir: 1 | -1) => onChange?.(clamp((value ?? 0) + dir * step))
  const d = size === 'sm' ? 22 : 24

  const round =
    'inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-white text-t2 ' +
    'transition-colors duration-150 hover:border-p400 hover:bg-p50 hover:text-p700 disabled:opacity-40 [&>svg]:block'

  return (
    <div className={cn('inline-flex shrink-0 items-center gap-1.5', disabled && 'opacity-50', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => bump(-1)}
        aria-label={`${label ?? '数值'} 减小`}
        style={{ width: d, height: d }}
        className={round}
      >
        <Minus size={13} strokeWidth={2} />
      </button>
      <span className="inline-flex items-baseline gap-1">
        <input
          aria-label={label}
          // null → 空串（受控输入不能给 null，React 会当非受控）
          value={value === null ? '' : value.toFixed(precision)}
          placeholder={value === null ? emptyHint : undefined}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim()
            // 允许清空（回到「还没填」态），不把空串硬塞成 0——
            // 0 是一个**有意义的真实值**（如转速 0），不能拿它冒充「未填」。
            if (raw === '') return
            const n = Number(raw)
            if (!Number.isNaN(n)) onChange?.(clamp(n))
          }}
          className={cn(
            'num w-[58px] min-w-0 border-0 bg-transparent p-0 text-right font-semibold text-t1 focus:outline-none',
            size === 'sm' ? 'text-[15px]' : 'text-[17px]',
            value === null && 'text-t3',
          )}
        />
        {unit ? <span className="w-[26px] shrink-0 text-[12px] text-t3">{unit}</span> : null}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => bump(1)}
        aria-label={`${label ?? '数值'} 增大`}
        style={{ width: d, height: d }}
        className={round}
      >
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
