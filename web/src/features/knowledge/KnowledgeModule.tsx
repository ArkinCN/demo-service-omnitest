/* ===========================================================================
   知识库模块页 /knowledge 的整页版式。

   第三轮把知识库从流程 1 降级为五条流程共用的基础模块：不进 stepper、
   不套流程页的四块壳、没有动作条、没有 3×2 卡片网格、没有右侧竖工具条。
   版式按 06a 第 4.2 节的线框：顶条（归属面包屑 + 三枚操作按钮）、
   左栏三轴筛选、中栏条目列表（内部滚动 + 分页）、右栏选中条目详情、
   底栏助手（满宽，可收起为一行输入框）。

   三条平铺规则（《07-第三轮实施计划》第三节第 7 条）的落法：
   - 规则一：左栏三个轴的组内条目分别是 3 / 2 / 3 条，都不超过 5；
     中栏列表分页，每页 12 条。
   - 规则二：左栏首屏可见元素 = 3 个轴头 + 归属轴 3 行 = 6 个。
   - 规则三：初次进入只展开归属轴，展开条目 3 条。
   =========================================================================== */
import { useCallback, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Library,
  MessageSquare,
  RefreshCw,
} from 'lucide-react'
import {
  Badge,
  Button,
  Collapsible,
  EmptyState,
  Panel,
  PanelHeader,
  Skeleton,
  cn,
} from '../../components/ui'
import { KNOWLEDGE_ICON } from '../../app/icons'
import {
  KNOWLEDGE_ORIGIN_LABEL,
  KNOWLEDGE_USAGE_LABEL,
  type KnowledgeOrigin,
  type KnowledgeUsage,
} from '../../data/types'
import { useAppStore } from '../../state/useAppStore'
import { AgentChat, type AgentChatApi } from '../agent-chat'
import { ActionDock } from '../copilot'
import { useKnowledgeAdapter } from '../copilot/knowledgeAdapter'
import { sizeText } from '../scene/pack'
import { filterKnowledge, useKnowledge, type KnowledgeEntry } from './data'

const USAGES: KnowledgeUsage[] = ['spec', 'requirement', 'process']
const ORIGINS: KnowledgeOrigin[] = ['doc', 'experience']
const PAGE_SIZE = 12
const GAP = 'clamp(14px, 1.25vw, 24px)'

/** 数组开关：有就去掉、没有就加上 */
const toggle = <T,>(list: T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

/* ------------------------------------------------------------------ 筛选一行 */

function FilterRow({
  label,
  count,
  active,
  onClick,
  indent,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  indent?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-[30px] w-full items-center gap-2 pr-4 text-left transition-colors',
        active ? 'bg-p50 text-p700' : 'text-t2 hover:bg-p50/60',
      )}
      style={{ paddingLeft: 16 + (indent ?? 0) * 14 }}
    >
      <span
        className={cn(
          'h-[6px] w-[6px] shrink-0 rounded-full',
          active ? 'bg-p600' : 'bg-line',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
      <span className="num text-[11.5px] text-t3">{count}</span>
    </button>
  )
}

/* -------------------------------------------------------------------- 左栏 */

function FilterColumn({ entries }: { entries: KnowledgeEntry[] }) {
  const kbFilter = useAppStore((s) => s.kbFilter)
  const setKbFilter = useAppStore((s) => s.setKbFilter)
  const owner = entries[0]?.owner ?? ['', '', '']

  /** 某一轴的计数按「其余两轴已生效」算，这样数字跟点下去的结果对得上 */
  const countFor = (axis: 'usage' | 'origin' | 'owner', value: string) => {
    const base = {
      usage: axis === 'usage' ? [] : kbFilter.usage,
      origin: axis === 'origin' ? [] : kbFilter.origin,
      owner: axis === 'owner' ? [] : kbFilter.owner,
    }
    const pool = filterKnowledge(entries, base)
    if (axis === 'usage') return pool.filter((e) => e.usage === value).length
    if (axis === 'origin') return pool.filter((e) => e.origin === value).length
    return pool.filter((e) => e.owner.includes(value)).length
  }

  const dirty =
    kbFilter.usage.length + kbFilter.origin.length + kbFilter.owner.length > 0

  const Owner = KNOWLEDGE_ICON.owner
  const Origin = KNOWLEDGE_ICON.origin
  const Usage = KNOWLEDGE_ICON.usage
  const Filter = KNOWLEDGE_ICON.filter

  return (
    <Panel style={{ width: 'clamp(248px, 17vw, 320px)' }} className="shrink-0">
      <PanelHeader
        icon={<Filter size={17} strokeWidth={1.9} />}
        title="分类筛选"
        right={
          dirty ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setKbFilter({ usage: [], origin: [], owner: [] })}
            >
              重置
            </Button>
          ) : (
            <Badge tone="neutral">三轴</Badge>
          )
        }
      />
      <div className="fade-b min-h-0 flex-1 overflow-y-auto">
        <Collapsible
          title="归属"
          icon={<Owner size={14} strokeWidth={1.9} />}
          meta={kbFilter.owner.length ? `${kbFilter.owner.length} 项` : '三级'}
          defaultOpen
          dense
        >
          {owner.map((lv, i) =>
            lv ? (
              <FilterRow
                key={lv}
                label={lv}
                indent={i}
                count={countFor('owner', lv)}
                active={kbFilter.owner.includes(lv)}
                onClick={() => setKbFilter({ owner: toggle(kbFilter.owner, lv) })}
              />
            ) : null,
          )}
        </Collapsible>

        <Collapsible
          title="来源"
          icon={<Origin size={14} strokeWidth={1.9} />}
          meta={kbFilter.origin.length ? `${kbFilter.origin.length} 项` : '两类'}
          defaultOpen={false}
          dense
        >
          {ORIGINS.map((o) => (
            <FilterRow
              key={o}
              label={KNOWLEDGE_ORIGIN_LABEL[o]}
              count={countFor('origin', o)}
              active={kbFilter.origin.includes(o)}
              onClick={() => setKbFilter({ origin: toggle(kbFilter.origin, o) })}
            />
          ))}
        </Collapsible>

        <Collapsible
          title="用途"
          icon={<Usage size={14} strokeWidth={1.9} />}
          meta={kbFilter.usage.length ? `${kbFilter.usage.length} 项` : '三类'}
          defaultOpen={false}
          dense
        >
          {USAGES.map((u) => (
            <FilterRow
              key={u}
              label={KNOWLEDGE_USAGE_LABEL[u]}
              count={countFor('usage', u)}
              active={kbFilter.usage.includes(u)}
              onClick={() => setKbFilter({ usage: toggle(kbFilter.usage, u) })}
            />
          ))}
        </Collapsible>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------- 中栏 */

const USAGE_TONE: Record<KnowledgeUsage, 'ink' | 'soft' | 'neutral'> = {
  spec: 'neutral',
  requirement: 'ink',
  process: 'soft',
}

function EntryRow({
  entry,
  active,
  onClick,
}: {
  entry: KnowledgeEntry
  active: boolean
  onClick: () => void
}) {
  const Doc = KNOWLEDGE_ICON.doc
  const Exp = KNOWLEDGE_ICON.experience
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[40px] w-full items-center gap-3 border-b border-line-soft px-4 text-left transition-colors',
        active ? 'bg-p50' : 'hover:bg-p50/60',
      )}
    >
      <Badge tone={USAGE_TONE[entry.usage]} className="w-[76px] justify-center">
        {KNOWLEDGE_USAGE_LABEL[entry.usage]}
      </Badge>
      {entry.origin === 'doc' ? (
        <Doc size={14} strokeWidth={1.8} className="shrink-0 text-p600" />
      ) : (
        <Exp size={14} strokeWidth={1.8} className="shrink-0 text-p500" />
      )}
      <span
        className="min-w-0 flex-1 truncate text-[13px] text-t1"
        title={entry.title}
      >
        {entry.title}
      </span>
      <span className="shrink-0 truncate text-[12px] text-t3" style={{ maxWidth: 140 }}>
        {entry.docType ?? entry.evidenceLevel ?? ''}
      </span>
      <span className="num shrink-0 text-[12px] text-t3">{entry.id}</span>
    </button>
  )
}

/* -------------------------------------------------------------------- 右栏 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null
  return (
    <div className="border-b border-line-soft py-2">
      <div className="pb-1 text-[12px] text-t3">{label}</div>
      {/* leading-5（20px）在 12.5px 字号上对长路径这类连续字符偏紧，抬到 leading-[1.65] */}
      <div className="text-[12.5px] leading-[1.65] break-words text-t2">{children}</div>
    </div>
  )
}

/**
 * 右栏条目详情。
 *
 * 底部留白挂在末个字段上（`[&>div:last-child]:pb-7`），不挂在滚动容器上。
 * 原先写的是容器自己 `pb-4`：`.fade-b::after` 是 `position: sticky; bottom: 0`，
 * 它的定位基准是滚动容器的内边距盒，容器只要有 padding-bottom，渐隐带就被顶到
 * 离底 16px 处，最后那 16px 正文既不渐隐、又被面板的 overflow-hidden 硬切，
 * 于是「备注」这种多行长文的末行与卡片下边界叠成一团。把留白改挂到末个字段上，
 * 渐隐带回到视口真正的下沿；末个字段的下框线一并去掉，免得与卡底连成双线。
 */
function DetailColumn({ entry }: { entry: KnowledgeEntry | null }) {
  const Usage = KNOWLEDGE_ICON.usage
  return (
    <Panel style={{ width: 'clamp(300px, 21vw, 400px)' }} className="shrink-0">
      <PanelHeader
        icon={<Usage size={17} strokeWidth={1.9} />}
        title="条目详情"
        right={entry ? <Badge tone="neutral" mono>{entry.id}</Badge> : null}
      />
      {!entry ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={<Library size={24} strokeWidth={1.5} />}
            title="选一条看详情"
            hint="中栏点任意一行，这里出它的三轴取值、归类依据与源文件全名。"
          />
        </div>
      ) : (
        <div className="fade-b min-h-0 flex-1 overflow-y-auto px-4 [&>div:last-child]:border-b-0 [&>div:last-child]:pb-7">
          <h3 className="pt-3 pb-2 text-[14px] leading-6 font-semibold text-t1">
            {entry.title}
          </h3>
          <div className="flex flex-wrap gap-1.5 pb-2">
            <Badge tone={USAGE_TONE[entry.usage]}>{KNOWLEDGE_USAGE_LABEL[entry.usage]}</Badge>
            <Badge tone="neutral">{KNOWLEDGE_ORIGIN_LABEL[entry.origin]}</Badge>
            <Badge tone="neutral">{entry.owner[2]}</Badge>
            {entry.needsReview ? <Badge tone="warn">待人工复核</Badge> : null}
          </div>
          <Field label="归类依据">{entry.usageClass}</Field>
          <Field label="材料类型">{entry.docType}</Field>
          <Field label="证据级">{entry.evidenceLevel}</Field>
          {entry.case ? (
            <>
              <Field label="现象">{entry.case.symptom}</Field>
              <Field label="成因">{entry.case.cause}</Field>
              <Field label="动作">{entry.case.action}</Field>
              <Field label="结果">{entry.case.result}</Field>
            </>
          ) : null}
          <Field label="转化状态">
            {entry.conversion
              ? `${entry.conversion}${entry.chunks ? ` · ${entry.chunks} 切片` : ''}${
                  entry.pages ? ` · ${entry.pages} 页` : ''
                }`
              : ''}
          </Field>
          <Field label="体量">{entry.sizeBytes ? sizeText(entry.sizeBytes) : ''}</Field>
          <Field label="源文件">{entry.path ?? entry.url ?? ''}</Field>
          <Field label="待核实">{entry.status}</Field>
          <Field label="备注">{entry.note}</Field>
        </div>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ 底栏助手 */

const GREETING =
  '知识库模块。左栏三轴筛选、中栏条目、右栏详情；条目的用途轴取自场景包里每条新补的 usage 字段。'

function AssistantBar({ total }: { total: number }) {
  const [open, setOpen] = useState(true)
  // 知识库模块页不挂 FlowCopilot，预置动作按钮条自己接：
  // 那四枚的定义已由 copilot 包整份登记好（scope = 'knowledge'），这里只负责渲染与代发。
  const [api, setApi] = useState<AgentChatApi | null>(null)
  const [busy, setBusy] = useState(false)
  const send = useCallback((text: string) => api?.send(text), [api])
  const adapter = useKnowledgeAdapter()
  // 展开高度由并行期的 clamp(232px, 24vh, 264px) 提到下面这档。
  // 这一栏里纵向要装五层：外层栏头 40 + 对话自己的头 44 + 消息区 + 新加的预置动作
  // 按钮条 32 + 输入区约 112。并行期没有按钮条那一层，264 够用；加上之后实测
  // 272 仍会把开场白的气泡底边切掉，300 起才完整。上限 320，不让它在高屏上吃掉中栏。
  return (
    <Panel className="shrink-0" style={{ height: open ? 'clamp(300px, 28vh, 320px)' : 44 }}>
      <PanelHeader
        icon={<MessageSquare size={16} strokeWidth={1.9} />}
        title="助手"
        meta={`本产品 ${total} 条知识`}
        right={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开'}
          </Button>
        }
      />
      {open ? (
        <div className="min-h-0 flex-1">
          <AgentChat
            adapter={adapter}
            assistantName="助手"
            operator="张工"
            defaultPermission="readonly"
            initialItems={[
              { kind: 'message', id: 'kb-hello', role: 'assistant', text: GREETING },
            ]}
            onReady={setApi}
            onBusyChange={setBusy}
            actionSlot={<ActionDock scope="knowledge" send={send} busy={busy} />}
          />
        </div>
      ) : null}
    </Panel>
  )
}

/* -------------------------------------------------------------------- 整页 */

export function KnowledgeModule() {
  const { entries, loading } = useKnowledge()
  const kbFilter = useAppStore((s) => s.kbFilter)
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)

  const shown = useMemo(() => filterKnowledge(entries, kbFilter), [entries, kbFilter])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))

  // 三轴一变就回第一页。在 render 期直接改本组件自己的 state，
  // 不用 effect——用 effect 会多一轮渲染，也过不了 oxlint 的 set-state-in-effect。
  const key = `${entries.length}|${kbFilter.usage}|${kbFilter.origin}|${kbFilter.owner}`
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setPage(0)
  }

  const rows = shown.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  // 没点过就默认选中当前页第一条，右栏不空着进场
  const entry = shown.find((e) => e.id === picked) ?? rows[0] ?? null
  const owner = entries[0]?.owner ?? ['', '', '']

  const axisText = (list: string[], all: string) => (list.length ? list.join(' / ') : all)

  const Usage = KNOWLEDGE_ICON.usage
  const Upload = KNOWLEDGE_ICON.upload

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" style={{ gap: GAP }}>
      {/* 顶条：归属面包屑 + 三枚操作按钮。红线六动作一律人点，这里只是入口。 */}
      <Panel
        className="h-[52px] shrink-0 items-center gap-3 px-4"
        style={{ flexDirection: 'row' }}
      >
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-tpx bg-p50 text-p700">
          <Library size={17} strokeWidth={1.9} />
        </span>
        <span className="text-[16px] font-semibold tracking-tight text-t1">知识库</span>
        <span className="h-[22px] w-px bg-line" />
        <span className="truncate text-[13px] text-t2">
          {owner.filter(Boolean).join(' › ')}
        </span>
        <span className="num text-[12px] text-t3">{entries.length} 条</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<Upload size={14} strokeWidth={1.9} />}>
            上传
          </Button>
          <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.9} />}>
            重跑流水线
          </Button>
          <Button size="sm" icon={<Download size={14} strokeWidth={1.9} />}>
            导出
          </Button>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-1" style={{ gap: GAP }}>
        <FilterColumn entries={entries} />

        {/* 中栏是本页唯一的视觉主体：描边加深、带柔阴影 */}
        <Panel className="min-w-0 flex-1 border border-p200 shadow-tp2">
          <PanelHeader
            icon={<Usage size={17} strokeWidth={1.9} />}
            title="知识条目"
            meta={`${shown.length} 条`}
            right={
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="上一页"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  icon={<ChevronLeft size={14} strokeWidth={1.9} />}
                />
                <span className="num text-[12px] text-t3">
                  {page + 1} / {pages}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="下一页"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                  icon={<ChevronRight size={14} strokeWidth={1.9} />}
                />
              </div>
            }
          />

          {/* 三轴当前取值，一行讲清这一屏是怎么筛出来的 */}
          <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line-soft bg-p50/50 px-4 text-[12px] text-t2">
            <span>归属 {axisText(kbFilter.owner, owner.filter(Boolean).join(' › '))}</span>
            <span className="text-t3">·</span>
            <span>
              来源{' '}
              {axisText(kbFilter.origin.map((o) => KNOWLEDGE_ORIGIN_LABEL[o]), '全部')}
            </span>
            <span className="text-t3">·</span>
            <span>
              用途 {axisText(kbFilter.usage.map((u) => KNOWLEDGE_USAGE_LABEL[u]), '全部')}
            </span>
          </div>

          <div className="fade-b min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-[32px]" />
                ))}
              </div>
            ) : rows.length ? (
              rows.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  active={e.id === picked}
                  onClick={() => setPicked(e.id)}
                />
              ))
            ) : (
              <EmptyState
                icon={<Library size={24} strokeWidth={1.5} />}
                title="没有命中的条目"
                hint="把左栏的三轴筛选放宽一点再看。"
              />
            )}
          </div>
        </Panel>

        <DetailColumn entry={entry} />
      </div>

      <AssistantBar total={entries.length} />
    </div>
  )
}
