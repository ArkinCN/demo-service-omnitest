import type { AgentAdapter, AgentEvent, SendRequest } from '../agent-chat'
import type { EvidenceItem, Verdict } from '../agent-chat'

/* ===========================================================================
   按流程回放的脚本化适配器。

   agent-chat 自带的 mockAdapter 只有一段固定脚本（读 Customer.h → 启动 → 取数
   → 判定），不贴六条流程。这里把「脚本」抽成数据，每条流程给一段自己的脚本，
   再用同一套 AgentEvent 协议吐出去——组件本体一行没改。
   改动类动作照样走人工确认闸门：requestConfirm 未注入时按「不放行」处理。
   =========================================================================== */

export type Step =
  | { kind: 'say'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      title: string
      args: Record<string, unknown>
      argsSummary: string
      mutating?: boolean
      durationMs: number
      resultSummary: string
      result: unknown
    }
  | { kind: 'verdict'; verdict: Verdict }
  | { kind: 'evidence'; items: EvidenceItem[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function* play(steps: Step[], req: SendRequest, pace: number): AsyncGenerator<AgentEvent, void, void> {
  const wait = (ms: number) => (pace === 0 ? Promise.resolve() : sleep(ms * pace))
  let seg = 0
  for (const s of steps) {
    if (s.kind === 'say') {
      seg += 1
      const messageId = `m-${seg}`
      for (let i = 0; i < s.text.length; i += 6) {
        await wait(22)
        yield { type: 'message_delta', messageId, delta: s.text.slice(i, i + 6) }
      }
      continue
    }
    if (s.kind === 'tool') {
      await wait(240)
      yield {
        type: 'tool_call',
        callId: s.callId,
        name: s.name,
        title: s.title,
        args: s.args,
        argsSummary: s.argsSummary,
        mutating: s.mutating,
      }
      if (s.mutating) {
        const ok = req.requestConfirm
          ? await req.requestConfirm({ callId: s.callId, name: s.name, argsSummary: s.argsSummary })
          : false
        if (!ok) {
          yield {
            type: 'tool_result',
            callId: s.callId,
            status: 'error',
            durationMs: 0,
            resultSummary: '已取消：未获人工确认，动作未执行',
            result: { cancelled: true, reason: 'not_confirmed' },
          }
          yield { type: 'done', reason: 'aborted' }
          return
        }
      }
      await wait(Math.min(900, s.durationMs))
      yield {
        type: 'tool_result',
        callId: s.callId,
        status: 'ok',
        durationMs: s.durationMs,
        resultSummary: s.resultSummary,
        result: s.result,
      }
      continue
    }
    if (s.kind === 'verdict') {
      await wait(200)
      yield { type: 'verdict', verdict: s.verdict }
      continue
    }
    await wait(160)
    yield { type: 'evidence', items: s.items }
  }
  yield { type: 'done', reason: 'complete' }
}

export function makeAdapter(id: string, label: string, steps: Step[], pace = 1): AgentAdapter {
  return {
    id,
    label,
    send: (req: SendRequest) => play(steps, req, pace),
  }
}
