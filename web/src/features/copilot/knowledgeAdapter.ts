import { useMemo } from 'react'
import type { SendRequest } from '../agent-chat'
import { getPack } from '../scene/pack'
import { makeAdapter, type Step } from './adapter'
import { heldEnv, takePending } from './held'
import { stepsForAction } from './actionScripts'

/**
 * 知识库模块页那块对话用的适配器。
 *
 * /knowledge 不属于任何一条流程，没有「本流程默认脚本」可回落；认领得上预置动作
 * 就放它那段脚本，认不出（人自己打的字）就如实说一句本轮没有后端，不编回答。
 */
export function useKnowledgeAdapter() {
  const pack = getPack()
  return useMemo(() => {
    if (!pack) return undefined
    const resolve = (req: SendRequest): Step[] => {
      const def = takePending()
      const snapshot = heldEnv()
      if (def && snapshot && req.text.trim() === def.prompt.trim()) {
        return stepsForAction(def, pack, snapshot)
      }
      return [
        {
          kind: 'say',
          text: '本轮是演示态：没有接后端，只有输入区上方那几枚预置动作有脚本化回放，自由提问答不了。要看知识库能做什么，点上面的按钮。',
        },
      ]
    }
    return makeAdapter('module-knowledge', '知识库回放', resolve)
  }, [pack])
}
