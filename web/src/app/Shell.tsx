import { Outlet } from 'react-router'
import { TopBar } from './TopBar'

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
    </div>
  )
}
