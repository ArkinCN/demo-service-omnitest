import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FlowId } from '../../data/types'
import { registerCopilotActions } from '../../registry'
import { useAppStore } from '../../state/useAppStore'
import { AgentChat, type AgentChatApi, type SendRequest } from '../agent-chat'
import { getPack } from '../scene/pack'
import { makeAdapter, type Step } from './adapter'
import { ActionDock } from './ActionDock'
import { buttonsOf, loadActions, scopesOf, toCopilotActions } from './actions'
import { heldEnv, takePending } from './held'
import { stepsForAction } from './actionScripts'
import { scriptFor } from './scripts'
import './copilot.css'

/** 挂载即自动发起的那一问。按钮条给的是预置动作，这一句是进页面的开场。 */
const PROMPT: Record<FlowId, string> = {
  init: '产品本体属性里哪些是占位的',
  req: '判据与工作流有没有对不上的地方',
  run: '跑一次预检，然后回放本批 CH1 波形并对判据',
  tune: '为什么不合格，给候选参数和依据',
  report: '按模板填一遍，哪些字段还没填上',
}

/* ---------------------------------------------------------------------------
   登记与渲染分开。

   按钮定义一读进来就整份登记进注册表（五条流程加知识库模块），不等哪个页面挂载——
   /knowledge 是模块页、不挂 FlowCopilot，若把登记写在组件里，知识库那四枚就只有先
   逛过流程页才登记得上。渲染各页自理：本组件渲染五条流程那五组，/knowledge 页
   由知识库模块把 <ActionDock scope="knowledge" …/> 传给自己那块对话的 actionSlot。
   --------------------------------------------------------------------------- */

let registeredScene = ''
function registerForScene(sceneId: string) {
  if (registeredScene === sceneId) return
  registeredScene = sceneId
  void loadActions(sceneId).then((file) => {
    for (const scope of scopesOf(file)) {
      registerCopilotActions(scope, toCopilotActions(scope, buttonsOf(file, scope)))
    }
  })
}
registerForScene(useAppStore.getState().sceneId)
useAppStore.subscribe((s) => registerForScene(s.sceneId))

export function FlowCopilot({ flow }: { flow: FlowId }) {
  const pack = getPack()
  const sceneId = useAppStore((s) => s.sceneId)
  const operator = useAppStore((s) => s.benchUser)
  // 对话的命令式接口与忙态由 AgentChat 交回来，不再从 DOM 上反推
  const [api, setApi] = useState<AgentChatApi | null>(null)
  const [busy, setBusy] = useState(false)
  const send = useCallback((text: string) => api?.send(text), [api])

  useEffect(() => {
    registerForScene(sceneId)
  }, [sceneId])

  const adapter = useMemo(() => {
    if (!pack) return null
    /**
     * 一轮发什么，按发的是什么决定：
     * 刚点过的那枚预置动作认领得上，就放它那段脚本；否则回落到本流程的默认脚本。
     */
    const resolve = (req: SendRequest): Step[] => {
      const def = takePending()
      const snapshot = heldEnv()
      if (def && snapshot && req.text.trim() === def.prompt.trim()) {
        return stepsForAction(def, pack, snapshot)
      }
      return scriptFor(flow, pack)
    }
    return makeAdapter(`flow-${flow}`, `流程回放 · ${flow}`, resolve)
  }, [flow, pack])

  if (!adapter) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-t3">
        场景包加载中…
      </div>
    )
  }

  return (
    <div className="copilot-slot h-full min-h-0">
      <AgentChat
        key={flow}
        adapter={adapter}
        assistantName="助手"
        operator={operator}
        defaultPermission="readonly"
        autoStartPrompt={PROMPT[flow]}
        onReady={setApi}
        onBusyChange={setBusy}
        actionSlot={<ActionDock scope={flow} send={send} busy={busy} />}
      />
    </div>
  )
}

export { ActionDock } from './ActionDock'
export { ActionBar } from './ActionBar'
