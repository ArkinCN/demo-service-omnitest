import type { FlowId } from '../data/types'
import { useAppStore } from '../state/useAppStore'
import { AssistantPanel } from './AssistantPanel'
import { LeftPanel } from './LeftPanel'
import { ResourcePanel } from './ResourcePanel'

/** 一屏三块：左栏参数 380 · 右上面板（hero）· 右下助手。块间距 24。 */
export function FlowScreen({ flow }: { flow: FlowId }) {
  const scene = useAppStore((s) => s.scene)

  return (
    <div
      className="grid min-h-0 w-full flex-1"
      style={{
        gridTemplateColumns: 'minmax(300px, 380px) minmax(0, 1fr)',
        gap: 'clamp(14px, 1.25vw, 24px)',
      }}
    >
      <LeftPanel flow={flow} scene={scene} />
      <div
        className="right-rows grid min-h-0 min-w-0"
        style={{ gap: 'clamp(14px, 1.25vw, 24px)' }}
      >
        <ResourcePanel flow={flow} scene={scene} />
        <AssistantPanel flow={flow} scene={scene} />
      </div>
    </div>
  )
}
