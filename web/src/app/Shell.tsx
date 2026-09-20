import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { TopBar } from './TopBar'
import { RedlineConfirm } from '../features/redline'
import { useAppStore } from '../state/useAppStore'

/** 一句话即时反馈。只报刚刚真发生的事，四秒后自散，不做可点的通知中心。 */
function Notice() {
  const notice = useAppStore((s) => s.notice)
  const setNotice = useAppStore((s) => s.setNotice)
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(t)
  }, [notice, setNotice])
  if (!notice) return null
  return (
    <div
      role="status"
      data-testid="notice"
      className="animate-rise fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-tps border border-line bg-surface px-3.5 py-2 text-[12.5px] text-t1 shadow-tp2"
    >
      {notice}
    </div>
  )
}

/** 应用壳：基准画布 1920×1080（16:9）。顶栏 64 + 动作条 48 + 内容区。
 *  内容区外边距横 32 纵 24；1440 / 1600 宽度下栅格按比例收缩，不裁切。 */
export function Shell() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-page">
      <TopBar />
      <main
        className="flex min-h-0 flex-1"
        style={{ padding: 'clamp(16px, 1.7vw, 32px) clamp(18px, 1.7vw, 32px)' }}
      >
        <Outlet />
      </main>
      {/* 六条红线共用这一张确认卡，全局挂一处 */}
      <RedlineConfirm />
      <Notice />
    </div>
  )
}
