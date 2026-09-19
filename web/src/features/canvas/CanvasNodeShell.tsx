/* ===========================================================================
   画板节点的统一外壳。

   外观口径与 DESIGN.md 第 3 节一致：节点就是一张 PanelCard——卡头 38（图标徽章 +
   14px 卡名 + 放大按钮），卡体放 CardArt 线条稿或几行事实，卡底一行连接态。
   画板不另起一套卡片样式，避免同一产品里出现两种卡。
   =========================================================================== */
import { createElement, type ReactNode } from 'react'
import { PanelCard, Tooltip, cn } from '../../components/ui'
import { CANVAS_NODE_ICON } from '../../app/icons'
import { CardArt } from '../../app/CardArt'
import type { CanvasNode } from '../../data/types'
import { CANVAS_NODE_META, LINK_STATE_TEXT, type CanvasLinkState } from './model'

/** 卡底事实行：键 ≤4 字、值 ≤10 字，整句进 tooltip 不进卡面 */
export type NodeFact = [string, string]

export function NodeFacts({ facts }: { facts: NodeFact[] }) {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-1">
      {facts.slice(0, 3).map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2 text-[12px] leading-none">
          <span className="w-[42px] shrink-0 text-t3">{k}</span>
          <span className="num truncate text-t2">{v}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 节点外壳。
 * state 只三态：已接入（主色）/ 未接入（中性灰）/ 异常（暗红），与工具条描边同口径。
 */
export function CanvasNodeShell({
  node,
  state,
  foot,
  onExpand,
  children,
}: {
  node: CanvasNode
  state?: CanvasLinkState
  /** 卡底右侧的一行弱注，例如接入形态或通道名 */
  foot?: string
  onExpand?: () => void
  children?: ReactNode
}) {
  const meta = CANVAS_NODE_META[node.type]
  return (
    <PanelCard
      className="h-full w-full"
      icon={createElement(CANVAS_NODE_ICON[node.type], { size: 13, strokeWidth: 1.9 })}
      title={node.label}
      onExpand={onExpand}
      headerRight={
        meta.tag ? (
          <Tooltip content={`${meta.sub} · 经 MCP 服务接入`}>
            <span className="rounded-tpx bg-p50 px-1.5 py-0.5 text-[12px] leading-none text-p700">
              {meta.tag}
            </span>
          </Tooltip>
        ) : undefined
      }
      bodyClassName="p-2"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">{children ?? (node.card ? <CardArt id={node.card} /> : null)}</div>
        {state || foot ? (
          <div className="mt-1 flex shrink-0 items-center gap-1.5 text-[12px] leading-none text-t3">
            {state ? (
              <>
                <span
                  className={cn(
                    'h-[6px] w-[6px] shrink-0 rounded-full',
                    state === 'online' ? 'bg-p400' : state === 'fault' ? 'bg-alert' : 'bg-t3/40',
                  )}
                />
                <span>{LINK_STATE_TEXT[state]}</span>
              </>
            ) : null}
            {foot ? <span className="ml-auto truncate">{foot}</span> : null}
          </div>
        ) : null}
      </div>
    </PanelCard>
  )
}
