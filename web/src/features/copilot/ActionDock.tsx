import { useEffect, useMemo, useState } from 'react'
import { FLOW_BY_ID } from '../../data/flows'
import type { FlowId } from '../../data/types'
import { useAppStore } from '../../state/useAppStore'
import { defaultViewOf } from '../canvas/defaultView'
import { getPack } from '../scene/pack'
import { ActionBar } from './ActionBar'
import { buttonsOf, loadActions, type ActionDef, type ActionScope } from './actions'
import { buildEnvelope } from './context'
import { setHeldEnv, setPending } from './held'

/* ===========================================================================
   预置动作按钮条的装配件：读按钮定义、算上下文包、把点击接到对话上。

   收尾轮（W6）起走 AgentChat 的正经接口，并行期那套「宿主侧 DOM 接管三件套」
   已整体下架：
     · 挂位  原先往 .ac-root 里 portal 一个节点 → 现在传 AgentChat 的 actionSlot
     · 发送  原先往 .ac-textarea 写值再点 .ac-send → 现在用 AgentChatApi.send()
     · 忙态  原先 MutationObserver 盯 .ac-header__state[data-busy] → 现在收
             onBusyChange 回调
   本组件因此不再碰 agent-chat 的任何 class 名，也不再需要 composer.ts。

   任何一块 agent-chat 对话都能用：把 send 与 busy 传进来即可，
   /knowledge 页的助手也照此挂（scope 传 'knowledge'）。
   =========================================================================== */

export function ActionDock({
  scope,
  send,
  busy,
}: {
  scope: ActionScope
  /** 代发一条消息，取自 AgentChat 的 onReady 句柄 */
  send: (text: string) => void
  /** 对话是否在跑一轮，取自 AgentChat 的 onBusyChange */
  busy: boolean
}) {
  const pack = getPack()
  const sceneId = useAppStore((s) => s.sceneId)
  const scene = useAppStore((s) => s.scene)
  const path = useAppStore((s) => s.path)
  const overrides = useAppStore((s) => s.overrides)
  const touched = useAppStore((s) => s.touched)
  const confirmed = useAppStore((s) => s.confirmed)
  const benchBusy = useAppStore((s) => s.benchBusy)
  const benchUser = useAppStore((s) => s.benchUser)
  const interlockPending = useAppStore((s) => s.interlockPending)
  const picked = useAppStore((s) => s.canvasView[scope as FlowId])
  const canvasSelected = useAppStore((s) => s.canvasSelected)
  const model = useAppStore((s) => s.model)

  // canvasView 第三轮改成按流程存，这里取本 scope 那一份；
  // 人没点过就是场景包给的默认值（知识库模块没有 C 区，落兜底值不参与判断）
  const canvasView = picked ?? defaultViewOf(scope as FlowId, scene)

  const [defs, setDefs] = useState<ActionDef[]>([])

  const env = useMemo(
    () =>
      buildEnvelope({
        flow: scope,
        flowLabel: FLOW_BY_ID[scope as keyof typeof FLOW_BY_ID]?.label ?? scope,
        pack,
        sceneId,
        path,
        operator: benchUser,
        overrides,
        touched,
        confirmed,
        benchBusy,
        benchUser,
        interlockPending,
        canvasView,
        canvasSelected,
        model,
        transcriptSummary: null,
      }),
    [
      scope,
      pack,
      sceneId,
      path,
      overrides,
      touched,
      confirmed,
      benchBusy,
      benchUser,
      interlockPending,
      canvasView,
      canvasSelected,
      model,
    ],
  )

  // 适配器在 send 里要按这份上下文包展开脚本，而 send 发生在渲染之外
  useEffect(() => {
    setHeldEnv(env)
  }, [env])

  useEffect(() => {
    let alive = true
    void loadActions(sceneId).then((file) => {
      if (alive) setDefs(buttonsOf(file, scope))
    })
    return () => {
      alive = false
    }
  }, [sceneId, scope])

  return (
    <ActionBar
      defs={defs}
      env={env}
      busy={busy}
      onPick={(d) => {
        setPending(d)
        send(d.prompt)
      }}
    />
  )
}
