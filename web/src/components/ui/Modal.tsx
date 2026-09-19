import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
}

/** 居中放大浮层：资源卡片点击放大用 */
export function Modal({
  open,
  onClose,
  title,
  meta,
  footer,
  children,
  width = 960,
}: {
  open: boolean
  onClose: () => void
  title: string
  meta?: string
  footer?: ReactNode
  children: ReactNode
  width?: number
}) {
  useEscape(open, onClose)
  if (!open) return null
  return createPortal(
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,26,21,0.34)] p-10 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
        className="animate-pop flex max-h-[min(80vh,100%)] flex-col overflow-hidden rounded-tp border border-line bg-surface shadow-tp2"
      >
        <header className="flex h-[48px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
          <h3 className="text-[16px] font-semibold tracking-tight text-t1">{title}</h3>
          {meta ? <span className="truncate text-[12px] text-t3">{meta}</span> : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-tpx text-t3 transition-colors hover:bg-p50 hover:text-p700"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? (
          <footer className="flex h-[44px] shrink-0 items-center justify-end gap-2 border-t border-line-soft px-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/** 右侧抽屉：工具详情 / 文档预览用 */
export function Drawer({
  open,
  onClose,
  title,
  meta,
  children,
  width = 420,
}: {
  open: boolean
  onClose: () => void
  title: string
  meta?: string
  children: ReactNode
  width?: number
}) {
  useEscape(open, onClose)
  if (!open) return null
  return createPortal(
    <div
      className="animate-fade fixed inset-0 z-50 flex justify-end bg-[rgba(16,26,21,0.28)] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex h-full flex-col bg-surface shadow-tp2',
          'animate-rise',
        )}
      >
        <header className="flex h-[48px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
          <h3 className="text-[16px] font-semibold tracking-tight text-t1">{title}</h3>
          {meta ? <span className="truncate text-[12px] text-t3">{meta}</span> : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-tpx text-t3 transition-colors hover:bg-p50 hover:text-p700"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}
