/* ===========================================================================
   知识库数据取数层。

   第三轮把知识库从流程 1 降级为模块，原 src/data/loadScene.ts 的 kbFlow()
   已下架，知识库的数据一律从这里取。取数口径：

   - 归属轴（场景 › 子类 › 产品类型）取 public/scenes/index.json 的三级目录，
     按 sceneId 反查出这一条的三级中文名；
   - 来源轴（文档 / 经验）按数据落在哪份文件上分：documents.json 是文档，
     experience.json 是经验；
   - 用途轴（产品说明书 / 测试需求 / 工艺）读两份 JSON 里每条新补的 usage
     字段。落位依据与逐条落位表见同目录 usage-placement.md。

   知识库流水线产物（public/kb/documents/index.json）与场景包是两路登记，
   按 src/features/scene/kb.ts 文件头的约定不并表：这里只用它给已转化的文档
   补页数与切片数，条目本身仍以场景包登记为准。
   =========================================================================== */
import { useEffect, useSyncExternalStore } from 'react'
import type {
  FlowId,
  KnowledgeFilter,
  KnowledgeOrigin,
  KnowledgeUsage,
} from '../../data/types'
import { useAppStore } from '../../state/useAppStore'

/** 一条知识条目。三轴取值同时挂在同一条上。 */
export interface KnowledgeEntry {
  id: string
  title: string
  /** 用途轴 */
  usage: KnowledgeUsage
  /** 来源轴 */
  origin: KnowledgeOrigin
  /** 归属轴：三级路径 [场景, 子类, 产品类型] */
  owner: [string, string, string]
  /** 证据级，例如「台架实测数据」「规程条款」「未验证」 */
  evidenceLevel?: string
  summary?: string
  /** 本条会被哪些流程调用，供 B 区抽屉按流程过滤 */
  usedBy?: FlowId[]

  /* --------- 以下为 W2 新增的可选字段，只增不改，老的读法一律照旧 --------- */
  /** 06a 体系里的二级归类，例如「B1 调试规程与纪律」 */
  usageClass?: string
  /** 用途轴落位拿不准，需人工复核 */
  needsReview?: boolean
  /** 场景包登记的材料类型，例如「调试规程（dc-skills）」 */
  docType?: string
  /** 转化状态的中文显示名 */
  conversion?: string
  converted?: boolean
  sizeBytes?: number | null
  /** 源文件绝对路径或公开链接，供详情栏给出可独立定位的全名 */
  path?: string | null
  url?: string
  note?: string
  /** `_status`：这条为什么还不算已核实 */
  status?: string
  /** 经验条目的四段正文 */
  case?: { symptom: string; cause: string; action: string; result: string }
  /** 知识库流水线补上的页数与切片数（只有已过流水线的文档才有） */
  pages?: number | null
  chunks?: number
}

/** 三轴各取值的条目计数，筛选器每一轴都要显示 */
export interface KnowledgeCounts {
  total: number
  usage: Record<KnowledgeUsage, number>
  origin: Record<KnowledgeOrigin, number>
}

const EMPTY_COUNTS: KnowledgeCounts = {
  total: 0,
  usage: { spec: 0, requirement: 0, process: 0 },
  origin: { doc: 0, experience: 0 },
}

/* --------------------------------------------------------------- 原始 JSON 型 */

interface RawDoc {
  id: string
  type: string
  title: string
  path: string | null
  size_bytes: number | null
  exists: boolean
  used_in_flows: string[]
  conversion_status: string
  conversion_status_label?: string
  url?: string
  note?: string
  _status?: string
  usage?: string
  usage_class?: string
  usage_review?: string
}

interface RawExp {
  id: string
  symptom: string
  cause: string
  action: string
  result: string
  tags: Record<string, unknown>
  evidence_level: string
  _status?: string
  usage?: string
  usage_class?: string
  usage_review?: string
}

interface CatalogNode {
  id: string
  label: string
  sceneId?: string
  children?: CatalogNode[]
}

interface KbDocLite {
  title: string
  pages: number | null
  chunks: number
}

/* ------------------------------------------------------------------ 取值映射 */

/** 场景包 JSON 里的 usage 是中文三值，壳层契约是三个英文码 */
const USAGE_CODE: Record<string, KnowledgeUsage> = {
  产品说明书: 'spec',
  测试需求: 'requirement',
  工艺: 'process',
}

/** 场景包的流程编号 ↔ 壳层流程标识。F1 是已下架的知识库流程，不落任何流程页 */
const FLOW_OF_CODE: Record<string, FlowId> = {
  F2: 'init',
  F3: 'req',
  F4: 'run',
  F5: 'tune',
  F6: 'report',
}

const flowsOf = (labels: string[]): FlowId[] => {
  const out: FlowId[] = []
  for (const s of labels) {
    const f = FLOW_OF_CODE[s.slice(0, 2)]
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

/** 场景包里 usage 缺失时不猜：退回「工艺」并挂复核标记，界面上看得见 */
const usageOf = (v: string | undefined): [KnowledgeUsage, boolean] =>
  v && USAGE_CODE[v] ? [USAGE_CODE[v], false] : ['process', true]

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'force-cache' })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

/** 在三级目录里按 sceneId 反查出这一条的三级中文名 */
function ownerOf(catalog: CatalogNode[] | undefined, sceneId: string): [string, string, string] {
  for (const a of catalog ?? [])
    for (const b of a.children ?? [])
      for (const c of b.children ?? [])
        if (c.sceneId === sceneId) return [a.label, b.label, c.label]
  const parts = sceneId.split('.')
  return [parts[0] ?? sceneId, parts[1] ?? '', parts[2] ?? '']
}

/* ------------------------------------------------------------------ 取数入口 */

const cache = new Map<string, Promise<KnowledgeEntry[]>>()
const ready = new Map<string, KnowledgeEntry[]>()

/** 取某个场景包下的全部知识条目：documents.json 的文档 + experience.json 的经验。 */
export function loadKnowledge(sceneId: string): Promise<KnowledgeEntry[]> {
  const hit = cache.get(sceneId)
  if (hit) return hit
  const task = (async () => {
    const [docs, exps, index, kb] = await Promise.all([
      getJson<{ documents: RawDoc[] }>(`/scenes/${sceneId}/documents.json`),
      getJson<{ experiences: RawExp[] }>(`/scenes/${sceneId}/experience.json`),
      getJson<{ catalog: CatalogNode[] }>('/scenes/index.json'),
      getJson<{ documents: KbDocLite[] }>('/kb/documents/index.json'),
    ])
    const owner = ownerOf(index?.catalog, sceneId)
    const pipeline = new Map<string, KbDocLite>()
    for (const d of kb?.documents ?? []) pipeline.set(d.title, d)

    const out: KnowledgeEntry[] = []

    for (const d of docs?.documents ?? []) {
      const [usage, fallback] = usageOf(d.usage)
      const line = pipeline.get(d.title)
      out.push({
        id: d.id,
        title: d.title,
        usage,
        origin: 'doc',
        owner,
        usageClass: d.usage_class,
        needsReview: fallback || !!d.usage_review,
        docType: d.type,
        conversion: d.conversion_status_label ?? d.conversion_status,
        converted: !['not_converted', '未转化', '未取得'].includes(d.conversion_status),
        sizeBytes: d.size_bytes,
        path: d.exists ? d.path : null,
        url: d.url,
        note: d.note,
        status: d._status,
        usedBy: flowsOf(d.used_in_flows ?? []),
        summary: d.note,
        pages: line?.pages,
        chunks: line?.chunks,
      })
    }

    for (const e of exps?.experiences ?? []) {
      const [usage, fallback] = usageOf(e.usage)
      const t = e.tags ?? {}
      const flow = String(t.flow ?? t['流程'] ?? '')
      out.push({
        id: e.id,
        title: e.symptom,
        usage,
        origin: 'experience',
        owner,
        usageClass: e.usage_class,
        needsReview: fallback || !!e.usage_review,
        evidenceLevel: e.evidence_level,
        status: e._status,
        usedBy: flowsOf(flow ? [flow] : []),
        summary: e.action,
        case: { symptom: e.symptom, cause: e.cause, action: e.action, result: e.result },
      })
    }

    ready.set(sceneId, out)
    listeners.forEach((l) => l())
    return out
  })()
  cache.set(sceneId, task)
  return task
}

/** 按三轴筛选。 */
export function filterKnowledge(
  entries: KnowledgeEntry[],
  f: KnowledgeFilter,
): KnowledgeEntry[] {
  return entries.filter(
    (e) =>
      (f.usage.length === 0 || f.usage.includes(e.usage)) &&
      (f.origin.length === 0 || f.origin.includes(e.origin)) &&
      (f.owner.length === 0 || f.owner.every((o) => e.owner.includes(o))),
  )
}

/** 三轴计数。 */
export function countKnowledge(entries: KnowledgeEntry[]): KnowledgeCounts {
  const c: KnowledgeCounts = {
    total: entries.length,
    usage: { spec: 0, requirement: 0, process: 0 },
    origin: { doc: 0, experience: 0 },
  }
  for (const e of entries) {
    c.usage[e.usage] += 1
    c.origin[e.origin] += 1
  }
  return c
}

/** 某条流程实际会调用的知识条目，供 B 区顶部抽屉用。 */
export function knowledgeForFlow(entries: KnowledgeEntry[], flow: FlowId): KnowledgeEntry[] {
  return entries.filter((e) => !e.usedBy || e.usedBy.includes(flow))
}

/**
 * 顶栏知识库按钮上挂的条目总数。
 *
 * 这是个同步函数，取数没落地时只能返回 0——src/app/TopBar.tsx 是在 render 期
 * 直接调它的，而 TopBar 订阅的三个 store 字段（benchBusy / benchUser /
 * interlockPending）在运行期都不变，所以它挂载后不会因为取数落地而重渲。
 * 要让顶栏的数字在首屏就对，TopBar 那一行得改成调下面的 useKnowledgeTotal()；
 * TopBar 本轮冻结，这条已写进本包的跨包请求单。
 */
export function knowledgeTotal(): number {
  const id = useAppStore.getState().sceneId
  return ready.get(id)?.length ?? EMPTY_COUNTS.total
}

/* ----------------------------------------------------------------- React 侧 */

const EMPTY: KnowledgeEntry[] = []
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 当前场景包的知识条目。组件里用这一个就够，取数与缓存都在里面。 */
export function useKnowledge(): { entries: KnowledgeEntry[]; loading: boolean } {
  const sceneId = useAppStore((s) => s.sceneId)
  const entries = useSyncExternalStore(
    subscribe,
    () => ready.get(sceneId) ?? EMPTY,
    () => EMPTY,
  )
  useEffect(() => {
    void loadKnowledge(sceneId)
  }, [sceneId])
  return { entries, loading: !ready.has(sceneId) }
}

/** 当前场景包的知识条目总数（会随取数落地自动重渲）。供顶栏按钮用。 */
export function useKnowledgeTotal(): number {
  return useKnowledge().entries.length
}
