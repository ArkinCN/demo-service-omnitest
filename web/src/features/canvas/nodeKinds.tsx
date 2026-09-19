/* 三种节点体：卡片型（CardArt）、事实型（三行事实）、设备型（MCP）。
   单独成文件，注册调用留在 nodes.tsx。 */
import { CardArt } from '../../app/CardArt'
import { getPanelCards } from '../../registry'
import { DeviceMcpNodeBody } from '../remote/DeviceMcpNode'
import { useDeviceState } from '../remote/device'
import type { CanvasNode, FlowId, ScenePackage } from '../../data/types'
import { CanvasNodeShell, NodeFacts, type NodeFact } from './CanvasNodeShell'
import type { CanvasLinkState } from './model'
import { useCanvasCtx } from './ctx'

/**
 * 卡片型节点：卡体优先用该卡在本流程已注册的真实渲染（场景包的图、曲线、判定表），
 * 没有注册实现时才退回 CardArt 线条稿——线条稿是通用占位，两个场景包共用一张，
 * 玻璃升降器包拿它当结构示意图会画出一把风扇，不能当默认。
 */
export function CardNode({ node, flow, scene }: { node: CanvasNode; flow: FlowId; scene: ScenePackage }) {
  const { expand } = useCanvasCtx()
  const reg = node.card ? getPanelCards(flow).find((c) => c.id === node.card) : undefined
  return (
    <CanvasNodeShell node={node} onExpand={() => expand(node)}>
      {reg ? reg.render({ flow, scene }) : node.card ? <CardArt id={node.card} /> : null}
    </CanvasNodeShell>
  )
}

/** 事实型节点：场景包里没有对应卡片的，卡体列三行事实 */
export function FactNode({
  node,
  facts,
  state,
  foot,
}: {
  node: CanvasNode
  facts: NodeFact[]
  state?: CanvasLinkState
  foot?: string
}) {
  const { expand } = useCanvasCtx()
  return (
    <CanvasNodeShell node={node} state={state} foot={foot} onExpand={() => expand(node)}>
      <NodeFacts facts={facts} />
    </CanvasNodeShell>
  )
}

export function DeviceNode({ node, scene }: { node: CanvasNode; scene: ScenePackage }) {
  const { expand } = useCanvasCtx()
  const conn = useDeviceState()
  const state: CanvasLinkState = conn === 'connected' ? 'online' : conn === 'error' ? 'fault' : 'offline'
  return (
    <CanvasNodeShell node={node} state={state} foot="命令行会话" onExpand={() => expand(node)}>
      <DeviceMcpNodeBody scene={scene} state={conn} />
    </CanvasNodeShell>
  )
}

