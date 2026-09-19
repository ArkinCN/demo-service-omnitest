import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  Activity,
  Boxes,
  CheckSquare,
  CircuitBoard,
  Gauge,
  Layers,
  ListChecks,
  Pencil,
  Power,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Timer,
  Wind,
  Workflow as WorkflowIcon,
  Wrench,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
  Collapsible,
  EmptyState,
  InfoTip,
  Tooltip,
  cn,
} from '../../components/ui'
import { getPack, statusOf, type RawPack, type RawRequirement } from '../scene/pack'
import { ConfirmFooter, Empty } from '../shared/bits'
import { listPackWorkflows, loadPackWorkflow, type WfEntry } from '../scene/workflows'
import { WorkflowCanvas } from '../workflow'
import type { WorkflowModel } from '../workflow'
import '../workflow/styles/workflow.css'
import './wf-embed.css'

/* ===========================================================================
   流程 3 · 测试需求确认（v2 视觉，对齐流程 4 样板页）

   左栏「测试要求」：test-requirements.json 的 26 条判据按 10 类折叠，
     每行 = 勾选框 + 短名 + 阈值小徽标 + 可求值圆点，全句进 tooltip。
   卡片：工作流画布（hero，横跨两格，真画布）/ 工作流库（按组折叠）/
     判定表 / 知识依据 / 历史成绩。

   数据来源一律不动：判据读 pack.requirements，工作流经 src/features/scene/workflows.ts
   （散热风扇包是 public/data/wfw/** 的 68 个 .wfw，玻璃升降器包是包内 assets JSON）。
   =========================================================================== */

/** 散热风扇包默认打开的那条；别的包没有同名条目时取第一条 */
const DEFAULT_WF = 'HV_StaticStart'

/** 标签一律收到 6 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/* ==================================================== 选中集 / 焦点（跨卡共享） */

const sel = {
  scene: '',
  ids: new Set<string>(),
  focus: null as string | null,
}
let selVersion = 0
const selListeners = new Set<() => void>()
const bumpSel = () => {
  selVersion += 1
  selListeners.forEach((l) => l())
}
const subSel = (l: () => void) => {
  selListeners.add(l)
  return () => {
    selListeners.delete(l)
  }
}
const getSelVersion = () => selVersion

/** 需求基线默认把全部判据纳入本轮，取消勾选是「移出基线」的动作 */
function ensureSel(pack: RawPack) {
  if (sel.scene === pack.scene.id) return
  sel.scene = pack.scene.id
  sel.ids = new Set(pack.requirements.requirements.map((r) => r.id))
  sel.focus = pack.requirements.requirements[0]?.id ?? null
  bumpSel()
}

export function toggleReq(id: string) {
  if (sel.ids.has(id)) sel.ids.delete(id)
  else sel.ids.add(id)
  bumpSel()
}

function focusReq(id: string) {
  sel.focus = id
  bumpSel()
}

function useSel() {
  const pack = getPack()
  useSyncExternalStore(subSel, getSelVersion, getSelVersion)
  useEffect(() => {
    if (pack) ensureSel(pack)
  }, [pack])
  return sel
}

/* ================================================ 工作流选中态（画布与库共享） */

const wf = {
  scene: '',
  entries: [] as WfEntry[],
  model: null as WorkflowModel | null,
  active: null as string | null,
}
let wfVersion = 0
const wfListeners = new Set<() => void>()
const bumpWf = () => {
  wfVersion += 1
  wfListeners.forEach((l) => l())
}
const subWf = (l: () => void) => {
  wfListeners.add(l)
  return () => {
    wfListeners.delete(l)
  }
}
const getWfVersion = () => wfVersion

function ensureWf(pack: RawPack) {
  if (wf.scene === pack.scene.id) return
  wf.scene = pack.scene.id
  wf.entries = []
  wf.model = null
  wf.active = null
  bumpWf()
  void (async () => {
    const entries = await listPackWorkflows(pack)
    if (wf.scene !== pack.scene.id) return
    wf.entries = entries
    const first = entries.find((e) => e.name === DEFAULT_WF) ?? entries[0]
    wf.active = first?.id ?? null
    bumpWf()
    const model = first ? await loadPackWorkflow(pack, first) : null
    if (wf.scene !== pack.scene.id) return
    wf.model = model
    bumpWf()
  })()
}

async function openWf(pack: RawPack, e: WfEntry) {
  wf.active = e.id
  wf.model = null
  bumpWf()
  const model = await loadPackWorkflow(pack, e)
  if (wf.active !== e.id) return
  wf.model = model
  bumpWf()
}

function useWf() {
  const pack = getPack()
  useSyncExternalStore(subWf, getWfVersion, getWfVersion)
  useEffect(() => {
    if (pack) ensureWf(pack)
  }, [pack])
  return wf
}

/* --------------------------------------------------------------- 阈值徽标 */

const numText = (v: number) => String(Number(v))

/** 一条判据的阈值压成一个 ≤8 字的小徽标；阈值位空着的显示「待填」 */
const TH_RULES: [RegExp, (v: number) => string][] = [
  [/rpm_min$/, (v) => `≥ ${numText(v)} rpm`],
  [/max_error_rpm$/, (v) => `≤ ${numText(v)} rpm`],
  [/^(required_full_pass|required_pass|required_count)$/, (v) => `${numText(v)} 次`],
  [/pct(_max)?$/, (v) => `± ${numText(v)}%`],
  [/^max_s$/, (v) => `≤ ${numText(v)} s`],
  [/duration_min$/, (v) => `${numText(v)} min`],
  [/ratio_max$/, (v) => `≤ ${numText(v)}×`],
  [/^ratio$/, (v) => `× ${numText(v)}`],
  [/_thr_v$/, (v) => `${numText(v)} V`],
  [/_a$/, (v) => `${numText(v)} A`],
  [/_deg$/, (v) => `± ${numText(v)}°`],
  [/^gears$/, (v) => `${numText(v)} 档`],
  [/^(trig_count|runs)$/, (v) => `${numText(v)} 次`],
  [/_ms(_max)?$/, (v) => `${numText(v)} ms`],
]

function thresholdBadge(r: RawRequirement): string | null {
  const th = r.threshold
  if (!th) return null
  for (const [re, fmt] of TH_RULES) {
    for (const [k, v] of Object.entries(th)) {
      if (!re.test(k)) continue
      if (typeof v === 'number') return fmt(v)
      if (v === null) return '待填'
    }
  }
  for (const v of Object.values(th)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      const joined = (v as string[]).join('/')
      return /[一-龥]/.test(joined) ? `${v.length} 档` : joined
    }
  }
  return null
}

/* ------------------------------------------------------------- 分组图标 */

const CAT_ICON: [RegExp, LucideIcon][] = [
  [/启动/, Zap],
  [/转速/, Gauge],
  [/响应|时间/, Timer],
  [/电流|电压/, Activity],
  [/调速|PWM/i, SlidersHorizontal],
  [/风/, Wind],
  [/保护/, ShieldCheck],
  [/硬件|自检/, CircuitBoard],
  [/可靠/, RotateCw],
]
const catIcon = (name: string): LucideIcon => {
  for (const [re, ic] of CAT_ICON) if (re.test(name)) return ic
  return ListChecks
}

const WF_GROUP_ICON: [RegExp, LucideIcon][] = [
  [/静止|启动/, Zap],
  [/上下电|POWER/i, Power],
  [/PWM|占空/i, SlidersHorizontal],
  [/风/, Wind],
  [/子流程/, Boxes],
  [/专项|其他/, Wrench],
]
const wfGroupIcon = (name: string): LucideIcon => {
  for (const [re, ic] of WF_GROUP_ICON) if (re.test(name)) return ic
  return WorkflowIcon
}

/** 电压档短名：索引里写的是 LV / SV / HV / MIXED / HSLV / N/A */
const VOLT_SHORT: Record<string, string> = {
  'N/A': '未标',
  MIXED: '三档',
  HSLV: '高低',
  未标电压等级: '未标',
  低压: 'LV',
  标准电压: 'SV',
  高压: 'HV',
}
const voltShort = (v: string) => VOLT_SHORT[v] ?? (v.length > 4 ? '三档' : v)

/* ------------------------------------------------------------------ 左栏 */

function ReqRow({ r }: { r: RawRequirement }) {
  const s = useSel()
  const on = s.ids.has(r.id)
  const manual = r.evaluable === false
  const th = thresholdBadge(r)
  const focused = s.focus === r.id

  const detail = (
    <span className="block space-y-1">
      <span className="block font-medium">{r.name}</span>
      <span className="num block opacity-75">{r.id}</span>
      <span className="block opacity-75">{r.criterion_text}</span>
      {manual ? <span className="block opacity-75">人工判 · {r.not_evaluable_reason}</span> : null}
      {r._placeholder ? <span className="block opacity-75">待确认 · 源材料未给出阈值</span> : null}
      {statusOf(r) ? <span className="block opacity-75">待核实 · {statusOf(r)}</span> : null}
    </span>
  )

  return (
    <div
      className={cn(
        'flex min-h-[34px] items-center gap-2 px-4 py-1 transition-colors hover:bg-p50/60',
        focused && 'bg-p50/80',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={r.name}
        onClick={() => toggleReq(r.id)}
        className={cn(
          'flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors [&>svg]:block',
          on ? 'border-transparent bg-p600 text-white' : 'border-line bg-white text-transparent hover:border-p300',
        )}
      >
        <CheckSquare size={11} strokeWidth={3} />
      </button>

      <Tooltip className="min-w-0 flex-1" content={detail}>
        <button
          type="button"
          onClick={() => focusReq(r.id)}
          className="flex min-w-0 w-full items-center gap-1.5 text-left"
        >
          <span
            className={cn(
              'truncate text-[13px] font-medium',
              on ? 'text-t1' : 'text-t2',
            )}
          >
            {short(r.name, 8)}
          </span>
        </button>
      </Tooltip>

      {th ? (
        <span
          className={cn(
            'num shrink-0 rounded-full border px-1.5 text-[12px] leading-[17px]',
            th === '待填'
              ? 'border-dashed border-line text-t3'
              : 'border-p200 bg-p50 text-p700',
          )}
        >
          {th}
        </span>
      ) : null}

      <span
        title={manual ? '只能人工判' : '可自动求值'}
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full',
          manual ? 'bg-white ring-1 ring-inset ring-line' : 'bg-p600',
        )}
      />
    </div>
  )
}

export function ReqLeftPanel() {
  const pack = getPack()
  const s = useSel()
  if (!pack) return <Empty text="场景包未加载" />
  const reqs = pack.requirements.requirements
  const all = s.ids.size === reqs.length

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <ListChecks size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">测试要求</h2>
        <span className="num text-[12px] text-t3">{reqs.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge tone="soft" mono>
            已选 {s.ids.size}
          </Badge>
          <Tooltip content={all ? '全部移出本轮' : '全部纳入本轮'}>
            <button
              type="button"
              aria-label={all ? '全部移出本轮' : '全部纳入本轮'}
              onClick={() => {
                sel.ids = all ? new Set<string>() : new Set(reqs.map((r) => r.id))
                bumpSel()
              }}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-tps border border-line bg-white text-t3 transition-colors hover:border-p300 hover:text-p700 [&>svg]:block"
            >
              {all ? <Square size={13} strokeWidth={1.9} /> : <CheckSquare size={13} strokeWidth={1.9} />}
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="fade-b min-h-0 flex-1 overflow-y-auto pb-2">
        {pack.requirements.categories.map((c, i) => {
          const items = reqs.filter((r) => r.category === c)
          const picked = items.filter((r) => s.ids.has(r.id)).length
          const Icon = catIcon(c)
          // 默认摊开到累计 14 行为止：分类少的包（26 条判据分 11 类）也能把左栏填满，
          // 分类多的包不会一次全铺开
          const before = pack.requirements.categories
            .slice(0, i)
            .reduce((n, x) => n + reqs.filter((r) => r.category === x).length, 0)
          return (
            <Collapsible
              key={c}
              icon={<Icon size={14} strokeWidth={1.9} />}
              title={short(c, 6)}
              defaultOpen={before < 14}
              right={
                <span className="num text-[12px] text-t3">
                  {picked}
                  <span className="text-t3/70">/{items.length}</span>
                </span>
              }
            >
              {items.map((r) => (
                <ReqRow key={r.id} r={r} />
              ))}
            </Collapsible>
          )
        })}
      </div>

      <div className="shrink-0 px-4 pt-2">
        <Tooltip
          content={`可自动求值 ${pack.requirements.evaluable_count} 条，只能人工判 ${pack.requirements.not_evaluable_count} 条（排程规则与目视检查一类，不硬凑成布尔表达式）。`}
        >
          <span className="flex w-full items-center gap-2 text-[12px] text-t3">
            <span className="num">
              {pack.requirements.evaluable_count}/{reqs.length}
            </span>
            <span className="truncate">可自动求值</span>
          </span>
        </Tooltip>
      </div>
      <ConfirmFooter
        label="确认基线"
        count={s.ids.size}
        unit="条"
        hint={`本轮基线纳入 ${s.ids.size} 条判据（共 ${reqs.length} 条），勾选框改的就是这份基线。`}
      />
    </div>
  )
}

/* -------------------------------------------------- 卡片 · 工作流画布（hero） */

function WorkflowStage({ full }: { full?: boolean }) {
  const pack = getPack()
  const { entries, model, active } = useWf()
  const [node, setNode] = useState<string | null>(null)
  const [edit, setEdit] = useState(false)
  if (!pack) return <Empty text="场景包未加载" />
  const cur = entries.find((e) => e.id === active)
  if (!model)
    return <EmptyState icon={<WorkflowIcon size={24} strokeWidth={1.5} />} title="读取工作流" />

  const subs = model.nodes.filter((n) => n.type === 'subworkflow').length

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div
        className={cn(
          'wf-root wf-embed min-h-0 min-w-0 flex-1',
          !full && !edit && 'wf-thumb',
        )}
      >
        <WorkflowCanvas
          model={model}
          readonly={!edit}
          selectedId={node}
          onSelect={(n) => setNode(n?.id ?? null)}
          // 组件默认的 fitView 下限 0.6 会顶住缩放把图裁掉边缘，节点一多就看不全。
          // 缩略态卡槽更窄，下限压得更低。组件本体不改，走 props 覆盖。
          fitViewOptions={full ? { minZoom: 0.2, padding: 0.08 } : { minZoom: 0.12, padding: 0.03, maxZoom: 1 }}
          className="h-full w-full"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Tooltip content={cur?.purpose ?? cur?.name ?? ''}>
          <span className="max-w-[210px] cursor-help truncate text-[13px] font-semibold tracking-tight text-t1">
            {cur?.name ?? '—'}
          </span>
        </Tooltip>
        <Badge tone="soft" mono>
          节点 {model.nodes.length}
        </Badge>
        <Badge tone="neutral" mono>
          连线 {model.edges.length}
        </Badge>
        <Badge tone="neutral" mono title="电压档">
          {cur ? voltShort(cur.voltage) : '—'}
        </Badge>
        <Badge tone="neutral" mono title="调用子流程的节点数">
          子流程 {subs}
        </Badge>
        <Tooltip content={edit ? '退出编辑，回到只读缩略' : '进入编辑：可拖动节点与改连线'}>
          <button
            type="button"
            aria-label="编辑工作流"
            aria-pressed={edit}
            onClick={() => setEdit((v) => !v)}
            className={cn(
              'ml-auto flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-tps border transition-colors [&>svg]:block',
              edit
                ? 'border-p300 bg-p50 text-p700'
                : 'border-line bg-white text-t3 hover:border-p300 hover:text-p700',
            )}
          >
            <Pencil size={13} strokeWidth={1.9} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 工作流库 */

function WorkflowLibrary({ full }: { full?: boolean }) {
  const pack = getPack()
  const { entries, active } = useWf()

  const groups = useMemo(() => {
    const g = new Map<string, WfEntry[]>()
    for (const e of entries) g.set(e.group, [...(g.get(e.group) ?? []), e])
    // 画布当前那条所在的组排到最前，省得展开的组被挤到卡底看不见
    const hasActive = (items: WfEntry[]) => (items.some((e) => e.id === active) ? 1 : 0)
    return [...g.entries()].sort(
      (a, b) => hasActive(b[1]) - hasActive(a[1]) || b[1].length - a[1].length,
    )
  }, [entries, active])

  if (!pack) return <Empty text="场景包未加载" />
  if (!entries.length)
    return <EmptyState icon={<Layers size={24} strokeWidth={1.5} />} title="读取工作流索引" />

  const fromPack = pack.caps.workflowSource === 'pack-assets'
  const note = fromPack
    ? `工作流是场景包 assets/workflows/*.json，本身已是画布内部模型，不经 parseWfw。共 ${entries.length} 条${pack.workflows.all_placeholder ? '，全部为示例占位' : ''}。`
    : `可加载 .wfw ${entries.length} 个（索引 public/data/workflows.json），场景包 workflows.json 登记 ${pack.workflows.total} 条，两个数出处不同，没有对齐成同一个。`

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5">
        <Badge tone="soft" mono>
          {entries.length} 条
        </Badge>
        <Badge tone="neutral" mono>
          {groups.length} 组
        </Badge>
        <span className="ml-auto">
          <InfoTip content={note} />
        </span>
      </div>

      <div
        className="no-scrollbar -mx-3 min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
        }}
      >
        {groups.map(([g, items], i) => {
          const Icon = wfGroupIcon(g)
          return (
            <Collapsible
              key={g}
              dense
              icon={<Icon size={13} strokeWidth={1.9} />}
              title={short(g.replace(/^PWM\s*/, ''), 8)}
              defaultOpen={full ? i < 6 : items.some((e) => e.id === active)}
              right={<span className="num text-[12px] text-t3">{items.length}</span>}
            >
              {items.map((e) => {
                const on = e.id === active
                return (
                  <Tooltip key={e.id} className="w-full" content={e.purpose ?? e.name}>
                    <button
                      type="button"
                      onClick={() => void openWf(pack, e)}
                      className={cn(
                        'flex min-h-[28px] w-full items-center gap-2 px-4 text-left transition-colors',
                        on ? 'bg-p50' : 'hover:bg-p50/70',
                      )}
                    >
                      <span
                        className={cn(
                          'h-[6px] w-[6px] shrink-0 rounded-full',
                          on ? 'bg-p600' : 'bg-p200',
                        )}
                      />
                      <span
                        className={cn(
                          'truncate text-[12.5px]',
                          on ? 'font-medium text-p700' : 'text-t1',
                        )}
                      >
                        {e.name}
                      </span>
                      <span className="num ml-auto shrink-0 rounded-full border border-line px-1.5 text-[12px] leading-[17px] text-t3">
                        {voltShort(e.voltage)}
                      </span>
                      <span className="num w-[22px] shrink-0 text-right text-[12px] text-t3">
                        {e.nodeCount}
                      </span>
                    </button>
                  </Tooltip>
                )
              })}
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- 卡片 · 判定表 */

function CriteriaTable({ full }: { full?: boolean }) {
  const pack = getPack()
  const s = useSel()
  if (!pack) return <Empty text="场景包未加载" />
  const reqs = pack.requirements.requirements
  const picked = reqs.filter((r) => s.ids.has(r.id))
  const auto = picked.filter((r) => r.evaluable !== false).length
  const manual = picked.length - auto
  const holes = picked.filter((r) => r._placeholder).length

  const rows = pack.requirements.categories.map((c) => {
    const items = reqs.filter((r) => r.category === c)
    return { c, n: items.filter((r) => s.ids.has(r.id)).length, total: items.length }
  })

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-1 pb-2">
        <span className="num text-[26px] leading-none font-semibold tracking-tight text-t1">
          {picked.length}
          <span className="text-[13px] font-normal text-t3">/{reqs.length}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-t3">本轮纳入</span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-p600" />
            <span className="text-[12px] text-t3">可求值</span>
            <span className="num text-[13px] font-semibold text-t1">{auto}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-white ring-1 ring-inset ring-line" />
            <span className="text-[12px] text-t3">人工判</span>
            <span className="num text-[13px] font-semibold text-t1">{manual}</span>
          </span>
          {holes ? (
            <Badge tone="warn" dot title="阈值位在源材料里空着，需人工确认">
              待确认 {holes}
            </Badge>
          ) : null}
          <InfoTip content="此时只列不判：判定要的现场实测量由流程 4 台架采集后才求值，这里只冻结本轮要判哪些条。" />
        </span>
      </div>

      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-px">
          {rows.map((r) => (
            <Tooltip key={r.c} className="w-full" content={`${r.c} · 纳入 ${r.n} / ${r.total} 条`}>
              <div className="flex w-full items-center gap-1.5 py-[2px] leading-[14px]">
                <span className="w-[52px] shrink-0 truncate text-[12px] leading-[14px] text-t2">{short(r.c, 4)}</span>
                <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-p100">
                  <span
                    className="block h-full rounded-full bg-p600 transition-[width] duration-500"
                    style={{ width: `${Math.round((r.n / r.total) * 100)}%` }}
                  />
                </span>
                <span className="num w-[26px] shrink-0 text-right text-[12px] leading-[14px] text-t3">
                  {r.n}/{r.total}
                </span>
              </div>
            </Tooltip>
          ))}
        </div>
        {full ? (
          <div className="pt-2">
            {picked.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0"
              >
                <span className="num w-[92px] shrink-0 text-[12px] text-t3">{r.id}</span>
                <span className="truncate text-[12.5px] text-t1">{r.name}</span>
                <span className="num ml-auto shrink-0 text-[12px] text-t3">
                  {thresholdBadge(r) ?? '—'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 知识依据 */

const fileName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p

/**
 * 出处定位收成一枚编号徽标：「第 140-146 行」「第二节」「Customer.h:1-40」「p19」这一类。
 * 抠不出编号就不发徽标——半截词比没有更糟；整句一律留在 tooltip 里（DESIGN.md §4 文案纪律 2）。
 */
function locatorTag(locator: string): string | null {
  const m =
    /第\s*[\d〇零一二三四五六七八九十百\-–~至、]+\s*[行页节条款项章]/.exec(locator) ??
    /[\w.]+:\d+(?:-\d+)?/.exec(locator) ??
    /[Pp]\.?\s*\d+/.exec(locator) ??
    /[Ll]ines?\s*[\d-]+/.exec(locator)
  return m ? m[0].replace(/\s+/g, ' ').trim() : null
}

function CriteriaEvidence({ full }: { full?: boolean }) {
  const pack = getPack()
  const s = useSel()
  if (!pack) return <Empty text="场景包未加载" />
  const reqs = pack.requirements.requirements
  const r = reqs.find((x) => x.id === s.focus) ?? reqs[0]
  if (!r) return <Empty text="判据表为空" />
  const srcs = Array.isArray(r._source) ? r._source : r._source ? [r._source] : []
  const list = full ? srcs : srcs.slice(0, 3)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <Badge tone="ink" mono>
          {r.id}
        </Badge>
        <Tooltip className="min-w-0" content={r.criterion_text}>
          <span className="cursor-help truncate text-[13px] font-medium text-t1">
            {short(r.name, 10)}
          </span>
        </Tooltip>
        <span className="num ml-auto shrink-0 text-[12px] text-t3">{srcs.length} 处</span>
      </div>

      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        {list.map((src, k) => (
          <Tooltip
            key={`${src.file}-${k}`}
            className="w-full"
            content={`${src.file}${src.locator ? `\n${src.locator}` : ''}`}
          >
            <div className="flex w-full items-start gap-2 border-b border-line-soft py-[6px] last:border-b-0">
              <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full bg-p600" />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-t1">
                  {fileName(src.file)}
                </span>
                {src.locator && locatorTag(src.locator) ? (
                  <Badge tone="neutral" mono className="shrink-0">
                    {locatorTag(src.locator)}
                  </Badge>
                ) : null}
              </span>
            </div>
          </Tooltip>
        ))}
        {r.evidence?.length ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-2">
            {r.evidence.map((e) => (
              <Badge key={e} tone="soft">
                {short(e, 10)}
              </Badge>
            ))}
          </div>
        ) : null}
        {full ? (
          <p className="pt-3 text-[12.5px] leading-6 text-t2">{r.criterion_text}</p>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 历史成绩 */

interface Batch {
  id: string
  name: string
  pass: number
  fail: number
  other: number
  note: string
}

/**
 * 历史成绩库尚未建立。这里只列场景包自己登记过的两个批次：
 * 98 次启动故障实验数据包（有 PASS / FAIL 计数），以及包内三条留档波形样本的人工结论。
 */
function batchesOf(pack: RawPack): Batch[] {
  const stats = pack.datasets.package_stats as Record<string, number>
  const out: Batch[] = []
  if (typeof stats.attempts_total === 'number') {
    const pass = stats.pass ?? 0
    const fail = stats.fail ?? 0
    out.push({
      id: 'attempts',
      name: '启停实验包',
      pass,
      fail,
      other: Math.max(0, stats.attempts_total - pass - fail),
      note: `${stats.attempts_total} 个 attempt，已标注 ${stats.labeled ?? 0}，无效 ${stats.invalid ?? 0}`,
    })
  }
  const labeled = pack.datasets.datasets.filter((d) => d.label?.operator_result)
  if (labeled.length) {
    const pass = labeled.filter((d) => d.label?.operator_result === 'PASS').length
    out.push({
      id: 'waves',
      name: '留档波形',
      pass,
      fail: labeled.length - pass,
      other: 0,
      note: `包内留档 ${labeled.length} 条，结论取实验记录里的人工判定`,
    })
  }
  return out
}

function HistoryCard({ full }: { full?: boolean }) {
  const pack = getPack()
  if (!pack) return <Empty text="场景包未加载" />
  const batches = batchesOf(pack)
  if (!batches.length)
    return <EmptyState icon={<Activity size={24} strokeWidth={1.5} />} title="未登记历史批次" />

  return (
    <div className="flex h-full min-h-0 w-full flex-col justify-center gap-3">
      {batches.map((b) => {
        const total = b.pass + b.fail + b.other || 1
        return (
          <Tooltip key={b.id} className="w-full" content={b.note}>
            <div className="w-full cursor-help">
              <div className="flex items-baseline gap-2 pb-1.5">
                <span className="truncate text-[13px] font-medium text-t1">{b.name}</span>
                <span className="num text-[12px] text-t3">{total}</span>
                <span className="num ml-auto text-[12px] text-p700">PASS {b.pass}</span>
                <span className="num text-[12px] text-t2">FAIL {b.fail}</span>
              </div>
              <div className="flex h-[10px] w-full overflow-hidden rounded-full bg-p100">
                <span
                  className="h-full bg-p600 transition-[width] duration-500"
                  style={{ width: `${(b.pass / total) * 100}%` }}
                />
                <span
                  className="h-full bg-alert transition-[width] duration-500"
                  style={{ width: `${(b.fail / total) * 100}%` }}
                />
                <span className="h-full bg-t3/30" style={{ width: `${(b.other / total) * 100}%` }} />
              </div>
            </div>
          </Tooltip>
        )
      })}

      {full ? (
        <div className="min-h-0 flex-1 overflow-y-auto pt-1">
          {pack.datasets.datasets.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0"
            >
              <span className="num w-[130px] shrink-0 truncate text-[12px] text-t3">{d.id}</span>
              <span className="truncate text-[12.5px] text-t1">{d.name}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">
                {d.label?.operator_result ?? '—'}
              </span>
            </div>
          ))}
          <p className="pt-2 text-[12px] leading-5 text-t3">
            历史成绩库尚未建立，这里只列场景包登记过的批次与数据集。
          </p>
        </div>
      ) : null}
    </div>
  )
}

export const reqCards = {
  workflow: WorkflowStage,
  'wf-lib': WorkflowLibrary,
  verdict: CriteriaTable,
  evidence: CriteriaEvidence,
  history: HistoryCard,
}
