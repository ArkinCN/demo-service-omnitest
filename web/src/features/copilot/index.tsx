import { useMemo } from 'react'
import type { FlowId } from '../../data/types'
import { AgentChat } from '../agent-chat'
import { getPack } from '../scene/pack'
import { makeAdapter } from './adapter'
import { scriptFor } from './scripts'
import './copilot.css'

const PROMPT: Record<FlowId, string> = {
  kb: '这个三级节点下都收了什么？转化还差哪些',
  init: '产品本体属性里哪些是占位的',
  req: '判据与工作流有没有对不上的地方',
  run: '跑一次预检，然后回放本批 CH1 波形并对判据',
  tune: '为什么不合格，给候选参数和依据',
  report: '按模板填一遍，哪些字段还没填上',
}

export function FlowCopilot({ flow }: { flow: FlowId }) {
  const pack = getPack()
  const adapter = useMemo(
    () => (pack ? makeAdapter(`flow-${flow}`, `流程回放 · ${flow}`, scriptFor(flow, pack)) : null),
    [flow, pack],
  )

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
        assistantName="副驾"
        operator="张工"
        defaultPermission="readonly"
        autoStartPrompt={PROMPT[flow]}
      />
    </div>
  )
}
