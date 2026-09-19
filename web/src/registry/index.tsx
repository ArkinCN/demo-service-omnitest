import {
  createElement,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import type { CardId, FlowId, ScenePackage } from '../data/types'

/* ===========================================================================
   扩展注册表：别的 agent 把组件放在 src/features/<name>/ 下，
   在该目录的 index.ts 里调用 registerPanelCard / registerLeftPanel，
   再由 src/features/index.ts 统一 import 一次即可接入，Shell 不需要改。
   =========================================================================== */

export interface PanelCardContext {
  flow: FlowId
  scene: ScenePackage
}

export interface PanelCardRegistration {
  /** 卡片库标识（src/data/cards.ts）。用库内标识即可替换默认占位卡片。 */
  id: CardId
  label: string
  caption?: string
  /** 限定出现在哪些流程，'*' 表示全部 */
  flows?: FlowId[] | '*'
  /** 卡片缩略内容 */
  render: (ctx: PanelCardContext) => ReactNode
  /** 放大后的内容，缺省时复用 render */
  renderExpanded?: (ctx: PanelCardContext) => ReactNode
  /** 数字越小越靠前，默认 100 */
  order?: number
}

export interface LeftPanelRegistration {
  flow: FlowId
  component: ComponentType<{ flow: FlowId; scene: ScenePackage }>
}

const cards = new Map<string, PanelCardRegistration>()
const leftPanels = new Map<FlowId, LeftPanelRegistration>()
const assistants = new Map<FlowId, LeftPanelRegistration['component']>()

let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version += 1
  listeners.forEach((l) => l())
}

/** 注册一张右上资源面板卡片 */
export function registerPanelCard(reg: PanelCardRegistration) {
  cards.set(reg.id, reg)
  bump()
}

/** 注册某条流程路由的左栏内容（整块替换默认参数栏） */
export function registerLeftPanel(
  flow: FlowId,
  component: LeftPanelRegistration['component'],
) {
  leftPanels.set(flow, { flow, component })
  bump()
}

/** 注册某条流程的 D 区助手对话（整块替换默认演示对话） */
export function registerAssistant(
  flow: FlowId,
  component: LeftPanelRegistration['component'],
) {
  assistants.set(flow, component)
  bump()
}

export function hasAssistant(flow: FlowId) {
  return assistants.has(flow)
}

export function renderAssistant(
  flow: FlowId,
  props: { flow: FlowId; scene: ScenePackage },
): ReactNode {
  const c = assistants.get(flow)
  return c ? createElement(c, props) : null
}

export function getPanelCards(flow: FlowId): PanelCardRegistration[] {
  return [...cards.values()]
    .filter((c) => !c.flows || c.flows === '*' || c.flows.includes(flow))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function hasLeftPanel(flow: FlowId) {
  return leftPanels.has(flow)
}

/** 渲染注册进来的左栏；未注册时返回 null，由壳层画默认参数栏 */
export function renderLeftPanel(
  flow: FlowId,
  props: { flow: FlowId; scene: ScenePackage },
): ReactNode {
  const reg = leftPanels.get(flow)
  return reg ? createElement(reg.component, props) : null
}

/** 让 Shell 在有新注册时重渲染 */
export function useRegistryVersion() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
    () => version,
  )
}

