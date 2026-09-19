import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from './cn'

/** 分组折叠：图标 + 短标题 ≤6 字 + 右侧计数 + 折叠箭头 */
export function Collapsible({
  title,
  index,
  icon,
  meta,
  right,
  defaultOpen = true,
  children,
  className,
  dense,
}: {
  title: string
  index?: string
  icon?: ReactNode
  meta?: ReactNode
  right?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  className?: string
  dense?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cn('border-b border-line-soft last:border-b-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group flex w-full items-center gap-2 px-4 text-left transition-colors duration-150 hover:bg-p50/70',
          dense ? 'h-[30px]' : 'h-[36px]',
        )}
      >
        <ChevronRight
          size={14}
          strokeWidth={2}
          className={cn(
            'shrink-0 text-t3 transition-transform duration-200',
            open && 'rotate-90 text-p600',
          )}
        />
        {icon ? <span className="shrink-0 text-p600 [&>svg]:block">{icon}</span> : null}
        {index && !icon ? <span className="num text-[12px] text-t3">{index}</span> : null}
        <span
          className={cn(
            'truncate font-semibold tracking-tight text-t1',
            dense ? 'text-[12px]' : 'text-[13px]',
          )}
        >
          {title}
        </span>
        {meta ? <span className="tick ml-auto">{meta}</span> : null}
        {right ? <span className="ml-auto flex items-center gap-1.5">{right}</span> : null}
      </button>
      {open ? <div className="animate-fade pb-1">{children}</div> : null}
    </div>
  )
}
