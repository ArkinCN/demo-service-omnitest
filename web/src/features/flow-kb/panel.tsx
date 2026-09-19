import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Binary,
  Boxes,
  Bug,
  CircuitBoard,
  Cpu,
  FileCode2,
  FileText,
  FolderTree,
  GraduationCap,
  Layers,
  ListChecks,
  Quote,
  Search,
  Sparkles,
  Tag as TagIcon,
  UploadCloud,
  Wind,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
  Collapsible,
  EmptyState,
  InfoTip,
  Input,
  Segmented,
  SoftCard,
  StatusDot,
  Tooltip,
  cn,
} from '../../components/ui'
import { getPack } from '../scene/pack'
import {
  kbAppliesTo,
  loadKb,
  type KbBundle,
  type KbDocument,
  type KbExperience,
} from '../scene/kb'
import { useAppStore } from '../../state/useAppStore'
import { ConfirmFooter, Empty } from '../shared/bits'

/* ===========================================================================
   流程 1 · 知识库管理（v2 视觉）

   左栏：三级分类树（电机 › 散热风扇 › FU6832 驱动板）+ 类型分段 + 流程标签
         + 拖放上传区，底部悬浮主按钮。
   卡片：文档库（hero，横跨两格）/ 知识库依据（检索）/ 转化流水线 /
         经验库 / 工具清单。

   数据两路、不混口径：
   - 知识库流水线产物 public/kb/（13 份已转化文档、374 切片、38 条经验、5 条
     样例查询），由 loadKb() 读；
   - 场景包 public/scenes/<sceneId>/{documents,experience}.json 登记的是"这个
     产品下有哪些材料"，含没进流水线的，用来标未转化条数。
   =========================================================================== */

/** 标签一律收到 n 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/* ------------------------------------------------------------------ 取数 */

function useKb() {
  const sceneId = useAppStore((s) => s.sceneId)
  const [kb, setKb] = useState<KbBundle | null>(null)
  useEffect(() => {
    let alive = true
    void loadKb().then((b) => alive && setKb(kbAppliesTo(b, sceneId) ? b : null))
    return () => {
      alive = false
    }
  }, [sceneId])
  return kb
}

/* -------------------------------------------------- 文档类型 → 图标 / 归组 */

const DOC_ICON: Record<string, LucideIcon> = {
  调试手册: Wrench,
  应用手册: FileText,
  芯片数据手册: Cpu,
  原理文档: Activity,
  原理与寄存器说明: Binary,
  培训材料: GraduationCap,
  考核题库: ListChecks,
  问题汇总: Bug,
  源码参数配置: FileCode2,
}

/** 九个 doc_type 摊平了列会碎成九组，先按用途收成三类再展开。 */
const DOC_BUCKETS: { key: string; title: string; icon: LucideIcon; types: string[] }[] = [
  { key: 'manual', title: '手册与规格', icon: FileText, types: ['调试手册', '应用手册', '芯片数据手册'] },
  { key: 'theory', title: '原理与算法', icon: Activity, types: ['原理文档', '原理与寄存器说明'] },
  {
    key: 'practice',
    title: '培训与问题',
    icon: GraduationCap,
    types: ['培训材料', '考核题库', '问题汇总', '源码参数配置'],
  },
]

const bucketOf = (t: string) => DOC_BUCKETS.find((b) => b.types.includes(t))?.key ?? 'practice'

/* ================================================================== 左栏 */

interface TreeNode {
  id: string
  label: string
  depth: number
  current: boolean
  docs?: number
  exps?: number
  children: TreeNode[]
}

const DEPTH_ICON = [Boxes, Wind, CircuitBoard]

export function KbLeftPanel() {
  const pack = getPack()
  const kb = useKb()
  const catalog = useAppStore((s) => s.catalog)
  const sceneId = useAppStore((s) => s.sceneId)
  const [kind, setKind] = useState('doc')
  const [tag, setTag] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sel, setSel] = useState<string | null>(null)

  const docCount = kb?.docs?.summary.documents ?? pack?.documents.documents.length ?? 0
  const expCount = kb?.experience?.summary.total ?? pack?.experience.count ?? 0

  /** 分类树直接用产品目录；只有当前场景那个叶子有实测条目数，其余不编数字。 */
  const tree: TreeNode[] = useMemo(() => {
    const walk = (n: { id: string; label: string; sceneId?: string; children?: unknown[] }, prefix: string, depth: number): TreeNode => {
      const id = prefix ? `${prefix}/${n.id}` : n.id
      const kids = ((n.children ?? []) as typeof n[]).map((k) => walk(k, id, depth + 1))
      const current = n.sceneId === sceneId || kids.some((k) => k.current)
      return {
        id,
        label: n.label,
        depth,
        current,
        docs: n.sceneId === sceneId ? docCount : undefined,
        exps: n.sceneId === sceneId ? expCount : undefined,
        children: kids,
      }
    }
    return catalog.map((n) => walk(n as never, '', 0))
  }, [catalog, sceneId, docCount, expCount])

  const currentPath = useMemo(() => {
    const trail: string[] = []
    const walk = (nodes: TreeNode[]): boolean => {
      for (const n of nodes) {
        if (!n.current) continue
        trail.push(n.id)
        if (n.children.length) walk(n.children)
        return true
      }
      return false
    }
    walk(tree)
    return trail
  }, [tree])

  useEffect(() => {
    if (!currentPath.length) return
    setOpen((o) => ({ ...o, ...Object.fromEntries(currentPath.map((id) => [id, true])) }))
    setSel((s) => s ?? currentPath[currentPath.length - 1])
  }, [currentPath])

  if (!pack) return <Empty text="场景包未加载" />

  const tagCounts = kb?.docs?.summary.by_process_tag ?? {}
  const vocab = kb?.docs?.process_tags_vocab ?? Object.keys(tagCounts)

  const corpus = (kb?.samples?.corpus ?? {}) as Record<string, number>
  const idxRows = [
    { k: '检索单元', v: corpus.units ?? '—', tip: '切片与参数行合计，BM25 建索引的最小单位。' },
    { k: '文档切片', v: kb?.docs?.summary.total_chunks ?? '—', tip: '命中后回溯到章节路径与页码。' },
    { k: '参数条目', v: corpus.params ?? '—', tip: 'Customer.h 工程参数配置文件解析出的参数行，单独进索引。' },
    { k: '抽出图', v: kb?.docs?.summary.total_figures ?? '—', tip: '随切片留在流水线产物目录，未随本页打包。' },
    { k: '样例查询', v: kb?.samples?.samples?.length ?? '—', tip: '离线跑过的样例查询，命中结果带页码，用来核检索口径。' },
  ]

  const renderNode = (n: TreeNode) => {
    const isOpen = open[n.id] ?? false
    const Icon = DEPTH_ICON[Math.min(n.depth, 2)]
    const active = sel === n.id
    const leaf = !n.children.length
    const count = kind === 'doc' ? n.docs : n.exps
    return (
      <div key={n.id}>
        <div
          className={cn(
            'relative flex h-[30px] items-center gap-1.5 pr-3 transition-colors',
            active ? 'bg-p50' : 'hover:bg-p50/60',
          )}
          style={{ paddingLeft: 10 + n.depth * 15 }}
        >
          {active ? <span className="absolute top-1 bottom-1 left-0 w-[3px] rounded-r-full bg-p600" /> : null}
          {n.children.length ? (
            <button
              type="button"
              aria-label={isOpen ? `折叠 ${n.label}` : `展开 ${n.label}`}
              onClick={() => setOpen((o) => ({ ...o, [n.id]: !isOpen }))}
              className="flex h-[16px] w-[16px] shrink-0 items-center justify-center text-t3 transition-transform duration-200 hover:text-p700"
              style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}
            >
              <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
                <path d="M2.5 1 L7 4.5 L2.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <span className="w-[16px] shrink-0" />
          )}
          <button
            type="button"
            onClick={() => setSel(n.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <Icon
              size={14}
              strokeWidth={1.9}
              className={cn('shrink-0', n.current ? 'text-p700' : 'text-t3')}
            />
            <Tooltip content={n.label}>
              <span
                className={cn(
                  'truncate text-[13px]',
                  active ? 'font-semibold text-t1' : n.current ? 'text-t1' : 'text-t2',
                )}
              >
                {short(n.label, leaf ? 10 : 8)}
              </span>
            </Tooltip>
          </button>
          {count !== undefined ? (
            <span className="num shrink-0 text-[12px] font-medium text-p700">{count}</span>
          ) : leaf ? (
            <span className="num shrink-0 text-[12px] text-t3">—</span>
          ) : null}
        </div>
        {isOpen ? <div className="animate-fade">{n.children.map(renderNode)}</div> : null}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <FolderTree size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">知识库</h2>
        <span className="num text-[12px] text-t3">{kind === 'doc' ? docCount : expCount}</span>
        <div className="ml-auto">
          <Segmented
            size="sm"
            ariaLabel="条目类型"
            value={kind}
            onChange={setKind}
            items={[
              { value: 'doc', label: '文档', icon: <FileText size={12} strokeWidth={1.9} /> },
              { value: 'exp', label: '经验', icon: <Sparkles size={12} strokeWidth={1.9} /> },
            ]}
          />
        </div>
      </header>

      <div className="fade-b min-h-0 flex-1 overflow-y-auto">
        <Collapsible
          icon={<Layers size={14} strokeWidth={1.9} />}
          title="分类树"
          right={<span className="num text-[12px] text-t3">3 级</span>}
        >
          <div className="pb-1">{tree.map(renderNode)}</div>
        </Collapsible>

        <Collapsible
          icon={<TagIcon size={14} strokeWidth={1.9} />}
          title="流程标签"
          right={<span className="num text-[12px] text-t3">{vocab.length}</span>}
        >
          <div className="flex flex-wrap gap-1.5 px-4 py-2">
            {vocab.map((v) => {
              const on = tag === v
              return (
                <Tooltip key={v} content={`${v} · ${tagCounts[v] ?? 0} 份文档带这个标签`}>
                  <button
                    type="button"
                    onClick={() => setTag(on ? null : v)}
                    className={cn(
                      'inline-flex h-[24px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors',
                      on
                        ? 'border-p600 bg-p600 text-white'
                        : 'border-line bg-white text-t2 hover:border-p300 hover:text-p700',
                    )}
                  >
                    {short(v, 5)}
                    <span className={cn('num', on ? 'text-white/75' : 'text-t3')}>
                      {tagCounts[v] ?? 0}
                    </span>
                  </button>
                </Tooltip>
              )
            })}
          </div>
        </Collapsible>

        <Collapsible
          icon={<Search size={14} strokeWidth={1.9} />}
          title="索引"
          right={<span className="num text-[12px] text-t3">{idxRows.length}</span>}
        >
          <div className="pb-1">
            {idxRows.map((r) => (
              <Tooltip key={r.k} className="w-full" content={r.tip}>
                <div className="flex h-[30px] w-full items-center gap-2 px-4 transition-colors hover:bg-p50/60">
                  <span className="truncate text-[13px] text-t2">{r.k}</span>
                  <span className="num ml-auto shrink-0 text-[14px] font-semibold text-t1">{r.v}</span>
                </div>
              </Tooltip>
            ))}
          </div>
        </Collapsible>

        <Collapsible
          icon={<UploadCloud size={14} strokeWidth={1.9} />}
          title="上传入库"
          right={<InfoTip content="拖入 PDF / DOCX / PPTX / 头文件，转化流水线会解析分页、切片、抽图并登记到当前三级节点下。" />}
        >
          <div className="px-4 pt-1 pb-3">
            <SoftCard className="flex h-[92px] flex-col items-center justify-center gap-1.5 rounded-tp2 border border-dashed border-p200 transition-colors hover:border-p500">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white text-p600 [&>svg]:block">
                <UploadCloud size={18} strokeWidth={1.75} />
              </span>
              <span className="text-[12px] font-medium text-t2">拖入文档或点击选择</span>
            </SoftCard>
          </div>
        </Collapsible>
      </div>

      <ConfirmFooter
        label="确认知识库"
        count={docCount}
        unit="份"
        hint={`文档 ${docCount} 份、经验 ${expCount} 条。确认后本节点知识库进入下游流程的检索范围。`}
      />
    </div>
  )
}

/* ====================================================== 卡片 · 文档库（hero） */

function Stat({ n, label, hint }: { n: number; label: string; hint: string }) {
  return (
    <Tooltip content={hint}>
      <div className="flex min-w-0 cursor-help flex-col gap-1">
        <span className="num text-[26px] leading-none font-semibold tracking-tight text-t1">{n}</span>
        <span className="text-[12px] text-t3">{label}</span>
      </div>
    </Tooltip>
  )
}

function DocRow({ d, full }: { d: KbDocument; full?: boolean }) {
  const Icon = DOC_ICON[d.doc_type] ?? FileText
  return (
    <Tooltip
      className="w-full"
      content={
        <span className="block space-y-1">
          <span className="block font-medium">{d.title}</span>
          <span className="num block opacity-75">
            {d.doc_type} · {d.pages ? `${d.pages} 页` : '无分页'} · {d.chunks} 切片 · {d.figures} 图
            {d.tables ? ` · ${d.tables} 表` : ''}
          </span>
          <span className="block opacity-75">
            转化器 {d.converter} · 标签 {d.process_tags.join(' / ') || '未标注'}
          </span>
        </span>
      }
    >
      <div className="flex w-full items-center gap-2 border-b border-line-soft py-[4px] last:border-b-0">
        <Icon size={13} strokeWidth={1.9} className="shrink-0 text-p600" />
        <span className="truncate text-[12.5px] text-t1">{short(d.title, full ? 40 : 10)}</span>
        {full ? <span className="shrink-0 text-[12px] text-t3">{d.doc_type}</span> : null}
        <span className="num ml-auto shrink-0 text-[12px] text-t3">
          {d.pages ? `${d.pages}p` : '—'}
        </span>
        <span className="num w-[34px] shrink-0 text-right text-[12px] font-medium text-t2">
          {d.chunks}
        </span>
        <StatusDot status={d.convert_status === 'ok' ? 'done' : 'alert'} />
      </div>
    </Tooltip>
  )
}

function DocLibrary({ full }: { full?: boolean }) {
  const pack = getPack()
  const kb = useKb()
  if (!pack) return <Empty text="场景包未加载" />
  const idx = kb?.docs
  if (!idx)
    return <EmptyState icon={<FolderTree size={24} strokeWidth={1.5} />} title="流水线产物未就位" />

  const s = idx.summary
  // 两路账不混：流水线报「转化了几份」，场景包报「自己登记的材料里还有几条没转化」。
  const registered = pack.documents.documents.length
  const pending = pack.documents.documents.filter((d) => !d.converted).length

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-start gap-6 pb-2.5">
        <Stat n={s.documents} label="已转化" hint={`流水线跑完 ${s.converted_ok} 份，失败 ${s.failed} 份。`} />
        <Stat n={s.total_chunks} label="切片" hint="检索的最小单位，命中后回溯到章节路径与页码。" />
        <Stat n={s.total_figures} label="抽图" hint="从原始文档里抽出的图，随切片一起留在流水线产物目录。" />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {pending ? (
            <Badge
              tone="warn"
              dot
              title={`场景包另登记 ${registered} 条材料，其中 ${pending} 条按自己的口径还没转化；这一列与流水线的 ${s.documents} 份不是同一本账。`}
            >
              待转 {pending}
            </Badge>
          ) : null}
          <Badge tone="soft" dot>
            全绿
          </Badge>
        </div>
      </div>

      <div
        className="no-scrollbar flex min-h-0 flex-1 gap-5 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        {DOC_BUCKETS.map((b) => {
          const items = idx.documents.filter((d) => bucketOf(d.doc_type) === b.key)
          if (!items.length) return null
          return (
            <section key={b.key} className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 pb-0.5">
                <b.icon size={12} strokeWidth={1.9} className="shrink-0 text-p400" />
                <span className="text-[12px] font-medium text-t3">{b.title}</span>
                <span className="h-px flex-1 bg-line-soft" />
                <span className="num text-[12px] text-t3">{items.length}</span>
              </div>
              {items.map((d) => (
                <DocRow key={d.doc_id} d={d} full={full} />
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/* ================================================= 卡片 · 知识库依据（检索） */

function KbSearch({ full }: { full?: boolean }) {
  const kb = useKb()
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(0)
  const samples = kb?.samples?.samples ?? []
  if (!samples.length)
    return <EmptyState icon={<Search size={24} strokeWidth={1.5} />} title="检索样例未就位" />

  const cur = samples[Math.min(pick, samples.length - 1)]
  const hits = cur.results.slice(0, full ? 5 : 4)

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="relative shrink-0">
        <Search size={14} strokeWidth={1.9} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3" />
        <Input
          className="h-[30px] pl-8"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="检索文档切片"
          aria-label="检索知识库"
        />
      </div>

      <div className="flex shrink-0 flex-wrap gap-1.5">
        {samples.map((s, i) => (
          <button
            key={s.query}
            type="button"
            onClick={() => {
              setPick(i)
              setQ(s.query)
            }}
            title={`${s.query} · 命中 ${s.hits} 条${s.pages_cited.length ? ` · 页码 ${s.pages_cited.join('/')}` : ''}`}
            className={cn(
              'inline-flex h-[22px] max-w-full items-center rounded-full border px-2.5 text-[12px] transition-colors',
              i === pick
                ? 'border-p200 bg-p50 font-medium text-p700'
                : 'border-line bg-white text-t2 hover:border-p300 hover:text-p700',
            )}
          >
            <span className="truncate">{short(s.query, 7)}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {hits.map((h) => (
          <Tooltip key={h.chunk_id} className="w-full" content={`${h.doc_title} · ${h.snippet.slice(0, 90)}…`}>
            <div className="flex w-full items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0">
              <span className="num flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-tpx bg-p50 text-[11px] font-semibold text-p700">
                {h.rank}
              </span>
              <Quote size={11} strokeWidth={1.9} className="shrink-0 text-p300" />
              <span className="truncate text-[12.5px] text-t1">
                {short(h.heading_path[h.heading_path.length - 1] ?? h.doc_title, 14)}
              </span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">
                {h.page ? `p${h.page}` : '—'}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* ================================================== 卡片 · 转化流水线（环形） */

function Pipeline() {
  const kb = useKb()
  const idx = kb?.docs
  if (!idx) return <EmptyState icon={<Layers size={24} strokeWidth={1.5} />} title="流水线产物未就位" />

  const s = idx.summary
  const total = s.documents || 1
  const ratio = s.converted_ok / total
  const R = 26
  const C = 2 * Math.PI * R
  const tags = idx.process_tags_vocab.map((v) => ({ v, n: s.by_process_tag[v] ?? 0 }))
  const max = Math.max(1, ...tags.map((t) => t.n))

  return (
    <div className="flex h-full min-h-0 w-full items-center gap-4">
      <Tooltip content={`转化成功 ${s.converted_ok} 份，失败 ${s.failed} 份，共 ${s.documents} 份进入流水线。`}>
        <div className="relative shrink-0 cursor-help">
          <svg width="68" height="68" viewBox="0 0 68 68">
            <circle cx="34" cy="34" r={R} fill="none" stroke="var(--p-100)" strokeWidth="7" />
            <circle
              cx="34"
              cy="34"
              r={R}
              fill="none"
              stroke="var(--p-600)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${C * ratio} ${C}`}
              transform="rotate(-90 34 34)"
              style={{ transition: 'stroke-dasharray .4s cubic-bezier(.22,.75,.3,1)' }}
            />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="num text-[17px] leading-none font-semibold text-t1">{s.converted_ok}</span>
            <span className="num text-[12px] text-t3">/{s.documents}</span>
          </span>
        </div>
      </Tooltip>

      <div className="min-w-0 flex-1 space-y-[5px]">
        {tags.map((t) => (
          <Tooltip key={t.v} className="w-full" content={`流程标签「${t.v}」下有 ${t.n} 份已转化文档`}>
            <div className="flex w-full items-center gap-2">
              <span className="w-[54px] shrink-0 truncate text-[12px] text-t2">{short(t.v, 4)}</span>
              <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-p100">
                <span
                  className="block h-full rounded-full bg-p600 transition-[width] duration-500"
                  style={{ width: `${Math.max(6, (t.n / max) * 100)}%` }}
                />
              </span>
              <span className="num w-[16px] shrink-0 text-right text-[12px] text-t2">{t.n}</span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* ====================================================== 卡片 · 经验库（三维度） */

const DIMS = [
  { value: 'process', label: '流程' },
  { value: 'fault', label: '问题' },
  { value: 'mode', label: '方式' },
] as const

const dimValue = (e: KbExperience, d: string) =>
  d === 'process' ? (e.tags.process ?? '未标注') : d === 'fault' ? (e.tags.fault_type ?? '未标注') : e.capture_mode

function ExperienceLib({ full }: { full?: boolean }) {
  const kb = useKb()
  const [dim, setDim] = useState<string>('fault')
  const exp = kb?.experience
  if (!exp) return <EmptyState icon={<Sparkles size={24} strokeWidth={1.5} />} title="经验库未就位" />

  const entries = exp.entries
  const buckets = new Map<string, KbExperience[]>()
  for (const e of entries) {
    const k = dimValue(e, dim)
    buckets.set(k, [...(buckets.get(k) ?? []), e])
  }
  const rows = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)
  const max = Math.max(1, ...rows.map(([, v]) => v.length))
  const unverified = entries.filter((e) => e.result.status === '未验证').length

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <span className="num text-[26px] leading-none font-semibold tracking-tight text-t1">
          {exp.summary.total}
        </span>
        {unverified ? (
          <Badge tone="warn" dot title="实验沉淀只采了故障态，没有把修复值回灌重测，结论一律标未验证。">
            未验证 {unverified}
          </Badge>
        ) : null}
        <Segmented
          size="sm"
          className="ml-auto"
          ariaLabel="经验筛选维度"
          value={dim}
          onChange={setDim}
          items={DIMS.map((d) => ({ value: d.value, label: d.label }))}
        />
        <InfoTip content={exp.caveats.join(' ')} />
      </div>

      <div className="min-h-0 flex-1 space-y-[5px] overflow-hidden">
        {rows.map(([k, v]) => {
          const conf = v.reduce((a, e) => a + e.confidence, 0) / v.length
          return (
            <Tooltip
              key={k}
              className="w-full"
              content={`${k} · ${v.length} 条 · 平均置信度 ${conf.toFixed(2)}`}
            >
              <div className="flex w-full items-center gap-2">
                <span className="w-[54px] shrink-0 truncate text-[12px] text-t2">{short(k, 4)}</span>
                <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-p100">
                  <span
                    className="block h-full rounded-full bg-p600 transition-[width] duration-500"
                    style={{ width: `${Math.max(6, (v.length / max) * 100)}%` }}
                  />
                </span>
                <span className="num w-[16px] shrink-0 text-right text-[12px] text-t2">{v.length}</span>
              </div>
            </Tooltip>
          )
        })}
      </div>

      {full ? (
        <ul className="max-h-[300px] shrink-0 overflow-y-auto border-t border-line-soft pt-1">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-2 border-b border-line-soft py-1 last:border-b-0">
              <Sparkles size={12} strokeWidth={1.9} className="shrink-0 text-p600" />
              <span className="truncate text-[12.5px] text-t1" title={e.title}>
                {short(e.title, 22)}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className="inline-block h-[4px] w-[46px] overflow-hidden rounded-full bg-p100 align-middle">
                  <span className="block h-full rounded-full bg-p600" style={{ width: `${e.confidence * 100}%` }} />
                </span>
                <span className="num w-[28px] text-right text-[12px] text-t3">{e.confidence.toFixed(2)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/* ====================================================== 卡片 · 工具清单与状态 */

function KbTools() {
  const kb = useKb()
  const idx = kb?.docs
  const samples = kb?.samples
  if (!idx) return <EmptyState icon={<Wrench size={24} strokeWidth={1.5} />} title="流水线产物未就位" />

  const byConverter = idx.documents.reduce<Record<string, number>>((m, d) => {
    const k = d.converter.startsWith('custom') ? '自研解析' : d.converter
    m[k] = (m[k] ?? 0) + 1
    return m
  }, {})
  const corpus = (samples?.corpus ?? {}) as Record<string, number>

  const rows: { icon: LucideIcon; name: string; meta: string; ok: boolean; tip: string }[] = [
    {
      icon: FileText,
      name: 'docling',
      meta: `${byConverter.docling ?? 0} 份`,
      ok: true,
      tip: 'docling：PDF / DOCX 转 Markdown 并抽表抽图，12 份文档走这条。',
    },
    {
      icon: FileCode2,
      name: '自研解析',
      meta: `${byConverter['自研解析'] ?? 0} 份`,
      ok: true,
      tip: '02_parse_customer_h.py：把 Customer.h 工程参数配置文件按正则解析成参数表，203 个参数。',
    },
    {
      icon: Search,
      name: 'BM25',
      meta: `${corpus.chunks ?? idx.summary.total_chunks} 切片`,
      ok: true,
      tip: `检索引擎 rank_bm25.BM25Okapi，语料 ${corpus.units ?? '—'} 个检索单元、${corpus.params ?? '—'} 条参数。`,
    },
    {
      icon: Binary,
      name: '中文分词',
      meta: 'bigram',
      ok: true,
      tip: `分词：${samples?.tokenizer ?? 'ASCII 词元 + 中文 unigram/bigram'}，无分词模型，离线可跑。`,
    },
    {
      icon: Boxes,
      name: '向量检索',
      meta: '未实现',
      ok: false,
      tip: '向量检索接口预留未实现（scripts/04_search.py 的 VectorIndex），本轮全部命中由 BM25 给出。',
    },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {rows.map((r) => (
        <Tooltip key={r.name} className="w-full" content={r.tip}>
          <div className="flex h-full min-h-[30px] w-full flex-1 items-center gap-2 border-b border-line-soft last:border-b-0">
            <span
              className={cn(
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-tpx [&>svg]:block',
                r.ok ? 'bg-p50 text-p700' : 'bg-sunk text-t3',
              )}
            >
              <r.icon size={13} strokeWidth={1.9} />
            </span>
            <span className="truncate text-[12.5px] text-t1">{r.name}</span>
            <span className="num ml-auto shrink-0 text-[12px] text-t3">{r.meta}</span>
            <StatusDot status={r.ok ? 'done' : 'na'} />
          </div>
        </Tooltip>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- 注册 */

/* 五张卡一律走 src/features/index.tsx 的 CARD_IMPL 统一分派，本文件不就地注册。 */
export const kbCards = {
  'project-tree': DocLibrary,
  evidence: KbSearch,
  pipeline: Pipeline,
  experience: ExperienceLib,
  tools: KbTools,
}
