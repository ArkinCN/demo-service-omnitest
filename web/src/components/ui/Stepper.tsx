import { Minus, Plus } from 'lucide-react'
import { cn } from './cn'

/** 数值加减：圆形加减按钮夹着大号数字 + 小号单位 */
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
}: {
  value: number
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
}) {
  const clamp = (n: number) => {
    let v = n
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return Number(v.toFixed(precision))
  }
  const bump = (dir: 1 | -1) => onChange?.(clamp(value + dir * step))
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
          value={value.toFixed(precision)}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (!Number.isNaN(n)) onChange?.(clamp(n))
          }}
          className={cn(
            'num w-[58px] min-w-0 border-0 bg-transparent p-0 text-right font-semibold text-t1 focus:outline-none',
            size === 'sm' ? 'text-[15px]' : 'text-[17px]',
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
