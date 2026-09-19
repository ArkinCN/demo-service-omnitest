import { useEffect, useRef, useState } from 'react'
import { Button, Panel, PanelHeader, Select, Textarea, cn } from '../components/ui'
import type { FlowId, ScenePackage } from '../data/types'
import { hasAssistant, renderAssistant, useRegistryVersion } from '../registry'
import { useAppStore } from '../state/useAppStore'

/** D 区 · 对话（规格 8）：测试助手，界面短名"助手"。
 *  助手可读、可算、可建议、可写草稿；落盘与控设备一律人点。 */

type Msg =
  | { id: string; role: 'assistant' | 'user'; type: 'text'; text: string }
  | {
      id: string
      role: 'assistant'
      type: 'tool'
      tool: string
      target: string
      args: string
      result: string
      ms: number
      failed?: boolean
    }
  | {
      id: string
      role: 'assistant'
      type: 'verdict'
      conclusion: '通过' | '不通过' | '待定'
      metric: string
      measured: string
      threshold: string
      evidence: string
    }
  | {
      id: string
      role: 'assistant'
      type: 'suggest'
      param: string
      current: string
      suggested: string
      delta: string
      reason: string
      from: string
    }

const SEED: Record<FlowId, (greet: string) => Msg[]> = {
  kb: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '知识库扫描', target: '散热风扇节点', args: '范围=文档 + 经验', result: '文档 42 · 经验 52 · 待校对 6', ms: 820 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
  ],
  init: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '文档结构化', target: 'FU6832 数据手册', args: '模板=产品描述', result: '抽出 14 字段 · 1 项缺失', ms: 2140 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
    { id: 's', role: 'assistant', type: 'suggest', param: '母线电压上限', current: '未填', suggested: '30 V', delta: '按联锁模板占位', reason: '数据手册未给出该限值，联锁模板对 24 V 档的默认值为 30 V，留 6 V 余量', from: '场景包联锁模板 v0.3' },
  ],
  req: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '判据抽取', target: 'QR-2026-03', args: '章节=§5', result: '判据 3 条 · 致命 2 主要 1', ms: 1760 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
  ],
  run: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '预检自检', target: '涵道逆风台架 · 工位 A', args: '项=设备连通/通道/基线', result: '3 项通过 · 总闸未开', ms: 3400 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
    { id: 'v', role: 'assistant', type: 'verdict', conclusion: '待定', metric: '两路转速反馈频率比', measured: '2.01', threshold: '2.00 ± 0.05', evidence: 'QR-2026-03 §5.1' },
  ],
  tune: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '案例检索', target: '经验库', args: '现象=逆风启动失败', result: '命中 12 例 · 相似度 ≥0.7', ms: 960 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
    { id: 's', role: 'assistant', type: 'suggest', param: '启动电流', current: '6.0 A', suggested: '7.0 A', delta: '+16.7%', reason: '12 例相似案例里 9 例通过抬高启动电流解决；预估相电流峰值 7.2 A，距上限 8 A 余量 10%', from: '经验库 · 案例 A-118' },
  ],
  report: (g) => [
    { id: 't', role: 'assistant', type: 'tool', tool: '模板填充', target: '散热风扇出厂测试报告 v3', args: '映射表=14 字段', result: '填入 12 · 缺 2', ms: 1520 },
    { id: 'g', role: 'assistant', type: 'text', text: g },
  ],
}

function ToolCard({ m }: { m: Extract<Msg, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'rounded-tp border bg-surface',
        m.failed ? 'border-alert' : 'border-line-soft',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="text-[11px] text-t3">工具调用</span>
        <span className="text-[12px] text-t1">{m.tool}</span>
        <span className="truncate text-[11px] text-t3">{m.target}</span>
        <span className="num ml-auto shrink-0 text-[11px] text-t3">{m.ms} ms</span>
        <span className="shrink-0 text-[9px] text-t3">{open ? '收起' : '详情'}</span>
      </button>
      <div className="border-t border-line-soft px-2 py-1 text-[11.5px] text-t2">
        {m.result}
      </div>
      {open ? (
        <div className="num animate-fade border-t border-line-soft px-2 py-1 text-[11px] text-t3">
          入参 {m.args}
        </div>
      ) : null}
    </div>
  )
}

function VerdictCard({ m }: { m: Extract<Msg, { type: 'verdict' }> }) {
  const tone =
    m.conclusion === '通过'
      ? 'border-ink text-ink'
      : m.conclusion === '不通过'
        ? 'border-alert text-alert'
        : 'border-line text-t2'
  return (
    <div className="rounded-tp border border-line-soft bg-surface">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={cn('rounded-tps border px-1.5 text-[11px] leading-[17px]', tone)}>
          {m.conclusion}
        </span>
        <span className="truncate text-[12px] text-t1">{m.metric}</span>
      </div>
      <div className="flex items-center gap-3 border-t border-line-soft px-2 py-1 text-[11.5px] text-t2">
        <span>
          实测 <span className="num text-t1">{m.measured}</span>
        </span>
        <span>
          阈值 <span className="num">{m.threshold}</span>
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 text-[11px] text-t3 underline-offset-2 transition-colors hover:text-ink hover:underline"
          title={`在面板打开知识库依据卡并定位到 ${m.evidence}`}
        >
          依据 · {m.evidence}
        </button>
      </div>
    </div>
  )
}

function SuggestCard({ m }: { m: Extract<Msg, { type: 'suggest' }> }) {
  const [state, setState] = useState<'open' | 'taken' | 'ignored'>('open')
  return (
    <div className="rounded-tp border border-line-soft bg-surface">
      <div className="flex items-center gap-2 border-b border-line-soft px-2 py-1.5">
        <span className="text-[11px] text-t3">参数建议</span>
        <span className="text-[12px] text-t1">{m.param}</span>
        <span className="num ml-auto text-[11px] text-t3">{m.delta}</span>
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="num rounded-tps border border-line-soft bg-sunk px-1.5 py-0.5 text-[11.5px] text-t2">
          {m.current}
        </span>
        <span className="text-[11px] text-t3">→</span>
        <span className="num rounded-tps border border-ink bg-ink-wash px-1.5 py-0.5 text-[11.5px] text-ink">
          {m.suggested}
        </span>
      </div>
      <p className="px-2 pb-1.5 text-[11.5px] leading-5 text-t2">{m.reason}</p>
      <div className="flex items-center gap-2 border-t border-line-soft px-2 py-1">
        <span className="truncate text-[11px] text-t3">来源 {m.from}</span>
        {state === 'open' ? (
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setState('ignored')}>
              忽略
            </Button>
            <Button size="sm" variant="primary" onClick={() => setState('taken')}>
              采纳
            </Button>
          </span>
        ) : (
          <span
            className={cn(
              'ml-auto text-[11px]',
              state === 'taken' ? 'text-ink' : 'text-t3',
            )}
          >
            {state === 'taken' ? '已采纳 · 参数行来源转为「建议」' : '已忽略 · 理由回流知识库'}
          </span>
        )}
      </div>
    </div>
  )
}

/** 注册了真实助手组件时，D 区整块交给它；否则走壳层的演示对话。 */
export function AssistantPanel(props: { flow: FlowId; scene: ScenePackage }) {
  useRegistryVersion()
  if (hasAssistant(props.flow)) {
    return <Panel>{renderAssistant(props.flow, props)}</Panel>
  }
  return <ShellAssistantPanel {...props} />
}

function ShellAssistantPanel({ flow, scene }: { flow: FlowId; scene: ScenePackage }) {
  const model = useAppStore((s) => s.model)
  const setModel = useAppStore((s) => s.setModel)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const content = scene.flows[flow]

  // 切流程即整屏换内容（规格原则 3 一屏一态）：渲染期按 key 重置，不用 effect
  const [thread, setThread] = useState(() => ({ key: flow, msgs: SEED[flow](content.greeting) }))
  if (thread.key !== flow) {
    setThread({ key: flow, msgs: SEED[flow](content.greeting) })
  }
  const msgs = thread.msgs
  const setMsgs = (fn: (m: Msg[]) => Msg[]) =>
    setThread((t) => ({ key: t.key, msgs: fn(t.msgs) }))

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [msgs])

  const send = (text: string) => {
    const t = text.trim()
    if (!t) return
    setMsgs((m) => [
      ...m,
      { id: `u${m.length}`, role: 'user', type: 'text', text: t },
      {
        id: `a${m.length}`,
        role: 'assistant',
        type: 'text',
        text: '壳层演示版未接模型，真实回答由后端助手服务给出；本轮不改任何参数。',
      },
    ])
    setDraft('')
  }

  return (
    <Panel>
      <PanelHeader
        title="对话"
        meta="测试助手 · 落盘与控设备一律由人点"
        right={
          <span className="flex items-center gap-1.5 rounded-tps border border-line-soft px-1.5 py-0.5">
            <span
              className="h-[6px] w-[6px] rounded-full bg-ink"
              style={{ animation: 'pulse-dot 2.4s ease-in-out infinite' }}
            />
            <span className="text-[11px] text-t2">助手在线</span>
          </span>
        }
      />

      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {msgs.map((m) => (
          <div
            key={m.id}
            className={cn('animate-rise flex', m.role === 'user' && 'justify-end')}
          >
            <div className={cn('max-w-[88%]', m.type !== 'text' && 'w-[88%]')}>
              {m.type === 'tool' ? (
                <ToolCard m={m} />
              ) : m.type === 'verdict' ? (
                <VerdictCard m={m} />
              ) : m.type === 'suggest' ? (
                <SuggestCard m={m} />
              ) : (
                <div
                  className={cn(
                    'rounded-tp border px-2.5 py-1.5 text-[12.5px] leading-6',
                    m.role === 'user'
                      ? 'border-ink bg-ink-wash text-t1'
                      : 'border-line-soft bg-surface text-t1',
                  )}
                >
                  {m.text}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <footer className="shrink-0 border-t border-line-soft px-2 pt-1.5 pb-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {content.quick.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => send(q)}
              className="rounded-tps border border-line px-1.5 py-0.5 text-[11px] text-t2 transition-colors hover:border-ink hover:bg-ink-wash hover:text-ink"
            >
              {q}
            </button>
          ))}
        </div>
        <div className="rounded-tp border border-line bg-surface transition-colors focus-within:border-ink">
          <Textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
            placeholder="问助手…（Enter 发送，Shift+Enter 换行）"
            aria-label="对话输入"
            className="border-0 bg-transparent focus:bg-transparent"
          />
          <div className="flex items-center gap-1.5 border-t border-line-soft px-1.5 py-1">
            <Select
              size="sm"
              className="w-[136px]"
              label="模型选择"
              options={[
                { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
                { value: 'deepseek-v4', label: 'deepseek-v4' },
                { value: 'local-7b', label: '本地 7B' },
              ]}
              value={model}
              onChange={setModel}
            />
            <span className="text-[11px] text-t3">助手不执行落盘与控设备动作</span>
            <Button size="sm" variant="default" aria-label="按住说话" className="ml-auto px-2">
              <span aria-hidden className="num mr-1 text-[11px]">
                ◉
              </span>
              语音
            </Button>
            <Button size="sm" variant="solid" onClick={() => send(draft)}>
              发送
            </Button>
          </div>
        </div>
      </footer>
    </Panel>
  )
}
