import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  Boxes,
  Cable,
  ChevronRight,
  CircuitBoard,
  Cpu,
  FileCode2,
  FileText,
  Folder,
  Gauge,
  Image as ImageIcon,
  Lock,
  Monitor,
  Radar,
  Ruler,
  Upload,
  Wand2,
  Waves,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Collapsible,
  EmptyState,
  Select,
  SoftCard,
  SourceTag,
  StatusDot,
  Stepper,
  Tooltip,
  cn,
} from '../../components/ui'
import { decimalsOf } from '../../data/loadScene'
import { registerLeftPanel } from '../../registry'
import { paramKey, useAppStore } from '../../state/useAppStore'
import {
  byGroup,
  fileName,
  getPack,
  sizeText,
  sourceLine,
  statusOf,
  type RawAttribute,
  type RawDocument,
  type RawPack,
} from '../scene/pack'
import { ConfirmFooter, Empty } from '../shared/bits'
import { simp } from '../shared/zh'
import { probeDevice, type ConnState } from '../remote'

/* ===========================================================================
   流程 2 · 初始化配置（v2 视觉，对齐流程 4 样板页）

   左栏：本体属性 8 组折叠（product-attributes.json 29 项），顶部「随传随用」
         上传条，参数行 = 来源圆点 + 短标签 + 大字值 + 圆形加减。
   卡片：产品示意图（hero，真图铺满）/ 原理图·文档读取 / 工程树 /
         安全联锁 / 台架实况。
   数据来源一律取场景包原始 JSON，本轮只改视觉，不改数据逻辑。
   =========================================================================== */

/** 标签一律收到 6 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/* ------------------------------------------------------------------ 左栏 */

const GROUP_ICON: [RegExp, LucideIcon][] = [
  [/电机本体|本体/, Cpu],
  [/转速规格|转速$/, Gauge],
  [/电压/, Zap],
  [/电流|功率/, Activity],
  [/芯片/, Cpu],
  [/采样|链路/, Cable],
  [/转速信号|信号/, Waves],
  [/机械|外形|尺寸/, Ruler],
]
const groupIcon = (name: string): LucideIcon => {
  for (const [re, ic] of GROUP_ICON) if (re.test(name)) return ic
  return Boxes
}

function AttrRow({ a }: { a: RawAttribute }) {
  const key = paramKey('init', 'pa', a.group, a.key)
  const override = useAppStore((s) => s.overrides[key])
  const touched = useAppStore((s) => s.touched[key])
  const setParam = useAppStore((s) => s.setParam)
  const value = override ?? (a.not_applicable ? '不适用' : a.value)
  // 极小值（电感 4.2e-5 H）与长单位（V/kRPM）塞不进步进器，这类退回大字只读显示，
  // 全名、量程与单位仍在 tooltip 里，不丢信息。
  const compact =
    String(typeof a.value === 'number' ? a.value : '').length <= 7 && (a.unit ?? '').length <= 4
  const editable = !a.not_applicable && a.editable && typeof a.value === 'number' && compact

  const detail = (
    <span className="block space-y-1">
      <span className="block font-medium">{a.name}</span>
      <span className="num block opacity-75">
        {a.key.toUpperCase()}
        {a.min !== null && a.max !== null ? ` · ${a.min}~${a.max}` : ''}
        {a.unit ? ` · ${a.unit}` : ''}
      </span>
      <span className="block opacity-75">{sourceLine(a._source) || '源材料未登记出处'}</span>
      {a._placeholder ? (
        <span className="block">待确认：源材料没给这一项，当前值是占位，需现场实测或由客户确认</span>
      ) : null}
      {statusOf(a) ? <span className="block opacity-75">待核实 · {statusOf(a)}</span> : null}
    </span>
  )

  return (
    <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5 transition-colors hover:bg-p50/60">
      <Tooltip className="min-w-0" content={detail}>
        <span className="flex min-w-0 items-center gap-1.5">
          <SourceTag source={touched ? '人工' : a._placeholder ? '建议' : '文档'} />
          <span className="cursor-help truncate text-[13px] font-medium text-t1">{short(a.name)}</span>
          {a._placeholder ? (
            <span
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn"
              aria-label="待确认"
            />
          ) : null}
        </span>
      </Tooltip>

      <span className="ml-auto shrink-0">
        {a.not_applicable ? (
          <span className="text-[12px] text-t3">不适用</span>
        ) : a.options?.length ? (
          <Select
            size="sm"
            className="w-[150px]"
            label={a.name}
            options={a.options.map((o) => ({ value: String(o.value), label: o.label }))}
            value={String(value)}
            onChange={(v) => setParam(key, v)}
          />
        ) : editable ? (
          <Stepper
            size="sm"
            label={a.name}
            value={Number(value)}
            unit={a.unit ?? undefined}
            step={a.step ?? 1}
            min={a.min ?? undefined}
            max={a.max ?? undefined}
            precision={
              decimalsOf(a.step) || Math.min(4, decimalsOf(typeof a.value === 'number' ? a.value : 0))
            }
            onChange={(n) => setParam(key, n)}
          />
        ) : (
          <span className="num text-[15px] font-semibold text-t1">
            {String(value)}
            {a.unit ? <span className="ml-1 text-[12px] font-normal text-t3">{a.unit}</span> : null}
          </span>
        )}
      </span>
    </div>
  )
}

export function InitLeftPanel() {
  const pack = getPack()
  const locked = !!useAppStore((s) => s.confirmed.init)
  const confirmFlow = useAppStore((s) => s.confirmFlow)
  const unconfirmFlow = useAppStore((s) => s.unconfirmFlow)
  if (!pack) return <Empty text="场景包未加载" />

  const attrs = pack.attributes.attributes
  const grouped = byGroup(attrs, pack.attributes.groups)
  const holes = attrs.filter((a) => a._placeholder).length

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <Boxes size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">本体属性</h2>
        <span className="num text-[12px] text-t3">{attrs.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge tone="neutral" mono title={`${holes} 项是占位值，源材料确实没给，已标「待确认」`}>
            占位 {holes}
          </Badge>
        </div>
      </header>

      {/* 随传随用：拖一份文档进来即刻参与回填 */}
      <div className="shrink-0 px-3 pt-2.5 pb-1">
        <Tooltip content="把数据手册、Customer.h、原理图或测试记录直接拖进来，读完即参与本页属性回填；源材料没写的项一律留空，不拿别处的数顶替。">
          <SoftCard className="flex h-[38px] cursor-pointer items-center gap-2 px-2.5 transition-colors hover:bg-p100/70">
            <Upload size={14} strokeWidth={1.9} className="shrink-0 text-p600" />
            <span className="text-[12.5px] font-medium text-t2">随传随用</span>
            <span className="ml-auto shrink-0">
              <Button size="sm" variant="default" icon={<FileText size={13} strokeWidth={1.9} />}>
                选文件
              </Button>
            </span>
          </SoftCard>
        </Tooltip>
      </div>

      <div className="fade-b min-h-0 flex-1 overflow-y-auto pb-2">
        {grouped.map(([g, items], i) => {
          const Icon = groupIcon(g)
          // 默认展开到累计 12 行为止：左栏填得满，又不必一次铺开 29 项
          const before = grouped.slice(0, i).reduce((n, [, xs]) => n + xs.length, 0)
          return (
            <Collapsible
              key={g}
              icon={<Icon size={14} strokeWidth={1.9} />}
              title={short(g, 6)}
              defaultOpen={before < 12}
              right={<span className="num text-[12px] text-t3">{items.length}</span>}
            >
              {items.map((a) => (
                <AttrRow key={a.key} a={a} />
              ))}
            </Collapsible>
          )
        })}
      </div>

      {locked ? (
        <footer className="shrink-0 border-t border-line-soft bg-white/85 px-4 py-3 backdrop-blur">
          <Tooltip content="解除后本体属性可再编辑，下游流程的基线同步失效。" className="w-full">
            <Button
              block
              size="lg"
              variant="secondary"
              icon={<Lock size={15} strokeWidth={2} />}
              onClick={() => unconfirmFlow('init')}
            >
              解除确认 · {attrs.length} 项
            </Button>
          </Tooltip>
        </footer>
      ) : (
        <ConfirmFooter
          label="确认属性"
          count={attrs.length}
          unit="项"
          hint={`${attrs.length} 项本体属性；占位 ${holes} 项在确认后仍按「待确认」跟踪。`}
          onClick={() => confirmFlow('init')}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------- 卡片 · 产品示意图（hero） */

/** 变体名收成 ≤4 字的短名，全名进 tooltip */
function shortVariant(name: string) {
  if (/VSP/i.test(name)) return 'VSP'
  if (/非|无|無/.test(name)) return '无二极管'
  if (/结构|結構|示意|简图|簡圖/.test(name)) return '结构图'
  if (/原理图|原理圖/.test(name)) return '原理图'
  return simp(short(name.replace(/方案/g, ''), 4))
}

/** 变体登记的是 PDF 原始路径；包内渲出来的分页图挂在 scene.images 上，按 _source.file 对号。 */
function imageOf(pack: RawPack, file: string) {
  return (
    pack.scene.images?.find((im) => {
      const src = (im as { _source?: { file?: string } })._source
      return src?.file === file
    })?.path ?? null
  )
}

function ProductHero({ full }: { full?: boolean }) {
  const pack = getPack()
  const [pick, setPick] = useState(-1)
  if (!pack) return <Empty text="场景包未加载" />

  const vs = pack.scene.schematic_variants
  const srcOf = (v: { file: string; rendered?: string }) =>
    v.rendered ?? (v.file.startsWith('assets/') ? v.file : imageOf(pack, v.file))
  if (!vs.length)
    return <EmptyState icon={<CircuitBoard size={24} strokeWidth={1.5} />} title="未登记图纸" />

  const first = Math.max(0, vs.findIndex((v) => srcOf(v)))
  const i = pick >= 0 ? Math.min(pick, vs.length - 1) : first
  const cur = vs[i]
  const src = srcOf(cur)
  const img = src ? pack.scene.images?.find((im) => im.path === src) : undefined
  // 场景包的 chip 字段有两种写法：单一型号（FU6832N…），或「不锁定主控 + 几家参考设计」
  // 的整段说明。后者里抠一个型号出来当徽标是把参考设计说成被测件，这里退回「未锁定主控」。
  const chipText = pack.scene.product.chip
  const chip = /不锁定|未锁定|参考设计/.test(chipText)
    ? '未锁定主控'
    : (/([A-Z]{1,3}\d{3,5}[A-Z]?)/.exec(chipText)?.[1] ?? '主控')

  return (
    <div className={cn(full ? 'relative h-full w-full' : 'absolute inset-0')}>
      {src ? (
        <img
          src={pack.base + src}
          alt={img?.title ?? cur.name}
          className={cn('h-full w-full', full ? 'object-contain' : 'object-cover object-center')}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-p50 px-6 text-center">
          <CircuitBoard size={24} strokeWidth={1.5} className="text-p400" />
          <span className="text-[13px] text-t2">该变体未渲染分页图</span>
          <span className="num max-w-full truncate text-[12px] text-t3" title={cur.file}>
            {fileName(cur.file)}
          </span>
        </div>
      )}

      {/* 芯片徽标 */}
      <Tooltip
        content={`${chipText}；图为${img?.title ?? cur.name}${img?.render ? `（${img.render}）` : ''}，场景包未登记产品实物照片，不拿渲染图冒充实物。`}
      >
        <span className="absolute top-2.5 left-2.5 inline-flex h-[26px] cursor-help items-center gap-1.5 rounded-full border border-white/70 bg-white/85 px-2.5 shadow-[0_1px_6px_rgba(31,42,36,.12)] backdrop-blur">
          <Cpu size={14} strokeWidth={1.9} className="text-p700" />
          <span className="num text-[12.5px] font-semibold text-t1">{chip}</span>
        </span>
      </Tooltip>

      {/* 变体切换 */}
      <div className="absolute right-2.5 bottom-2.5 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/85 px-2.5 py-1.5 shadow-[0_1px_6px_rgba(31,42,36,.12)] backdrop-blur">
        {vs.slice(0, 3).map((v, k) => (
          <Tooltip key={v.name} content={`${v.name} · ${fileName(v.file)}`}>
            <button
              type="button"
              onClick={() => setPick(k)}
              aria-label={v.name}
              aria-pressed={i === k}
              className={cn(
                'h-[8px] w-[8px] rounded-full transition-colors',
                i === k ? 'bg-p700' : 'bg-p300 hover:bg-p400',
              )}
            />
          </Tooltip>
        ))}
        <span className="text-[12px] font-medium text-t2">{shortVariant(cur.name)}</span>
      </div>
    </div>
  )
}

/* ---------------------------------------------- 卡片 · 原理图与文档读取（槽 2） */

interface KeyDoc {
  doc: RawDocument
  icon: LucideIcon
  label: string
  extra?: number
}

/** 三份关键文档：芯片数据手册 / 参数配置源码 / 原理图。按 type 取，取不到就跳过，不硬凑。 */
function keyDocs(pack: RawPack): KeyDoc[] {
  const all = pack.documents.documents.filter((d) => d.exists)
  const pickBy = (re: RegExp) => all.filter((d) => re.test(d.type) || re.test(d.title))
  const out: KeyDoc[] = []
  const ds = pickBy(/数据手册|规格书|standard|标准/i)[0]
  if (ds) out.push({ doc: ds, icon: FileText, label: '数据手册' })
  const src = pickBy(/驱动程序|源码|配置/)[0]
  if (src) out.push({ doc: src, icon: FileCode2, label: short(fileName(src.path), 10) })
  const sch = pickBy(/原理图/)
  if (sch.length) out.push({ doc: sch[0], icon: CircuitBoard, label: '原理图', extra: sch.length })
  // 三类没配齐的包（玻璃升降器包只有法规与报告类文档）按体积补到三份，卡里不留空行
  const has = new Set(out.map((x) => x.doc.id))
  for (const d of [...all].sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0))) {
    if (out.length >= 3) break
    if (has.has(d.id)) continue
    has.add(d.id)
    out.push({ doc: d, icon: FileText, label: short(simp(d.title), 10) })
  }
  return out
}

function DocIntake({ full }: { full?: boolean }) {
  const pack = getPack()
  if (!pack) return <Empty text="场景包未加载" />
  const docs = keyDocs(pack)
  if (!docs.length)
    return <EmptyState icon={<FileText size={24} strokeWidth={1.5} />} title="未登记文档" />
  const attrs = pack.attributes.attributes
  const filled = attrs.filter((a) => !a._placeholder && a.value !== null).length

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        className="no-scrollbar flex min-h-0 flex-1 flex-col justify-center overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%)',
        }}
      >
        {docs.map((d) => (
          <Tooltip
            key={d.doc.id}
            className="w-full"
            content={`${d.doc.title}（${d.doc.id}）· ${sizeText(d.doc.size_bytes)}\n${d.doc.path}`}
          >
            <div className="flex w-full cursor-help items-center gap-2.5 border-b border-line-soft py-[7px] last:border-b-0">
              <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-tpx bg-p50 text-p700">
                <d.icon size={14} strokeWidth={1.75} />
              </span>
              <span className="truncate text-[13px] font-medium text-t1">{d.label}</span>
              {d.extra && d.extra > 1 ? (
                <span className="num shrink-0 text-[12px] text-t3">×{d.extra}</span>
              ) : null}
              <span className="num ml-auto shrink-0 text-[12px] text-t3">
                {sizeText(d.doc.size_bytes)}
              </span>
            </div>
          </Tooltip>
        ))}
        {full ? (
          <p className="pt-2 text-[12px] leading-5 text-t3">
            回填只认这几份源文件里写死的值：数据手册给芯片电气规格，Customer.h 给整机配置，
            原理图给采样链路与分压网络。源材料没写的项留空标「待确认」，不按经验值补。
          </p>
        ) : null}
      </div>
      {/* 回填进度：让这张卡除了文件名之外还有一条可读的量 */}
      <div className="flex shrink-0 items-center gap-2 pt-1.5">
        <span className="text-[12px] text-t3">回填</span>
        <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-p100">
          <span
            className="block h-full rounded-full bg-p600 transition-[width] duration-500"
            style={{ width: `${Math.round((filled / (attrs.length || 1)) * 100)}%` }}
          />
        </span>
        <span className="num shrink-0 text-[12px] font-semibold text-t1">
          {filled}
          <span className="font-normal text-t3">/{attrs.length}</span>
        </span>
      </div>
      <div className="shrink-0 pt-2">
        <Tooltip content={`已从源文件填得 ${filled} / ${attrs.length} 项；其余项源材料确实没给。`}>
          <span className="block">
            <Button block size="sm" variant="secondary" icon={<Wand2 size={13} strokeWidth={1.9} />}>
              按这三份回填
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- 卡片 · 工程树 */

interface TNode {
  name: string
  children: Map<string, TNode>
  doc?: RawDocument
}

function insert(root: TNode, path: string, doc?: RawDocument) {
  const parts = path.split('/').filter(Boolean)
  let cur = root
  parts.forEach((p, i) => {
    if (!cur.children.has(p)) cur.children.set(p, { name: p, children: new Map() })
    cur = cur.children.get(p)!
    if (i === parts.length - 1) cur.doc = doc
  })
}

/** 把只有一个子目录的链压成一行，避免一长串单链目录把卡撑满 */
function compact(n: TNode): { label: string; node: TNode } {
  const names = [n.name]
  let cur = n
  while (cur.children.size === 1 && !cur.doc) {
    const only = [...cur.children.values()][0]
    if (!only.children.size) break
    names.push(only.name)
    cur = only
  }
  return { label: names.filter(Boolean).join('/'), node: cur }
}

const leafIcon = (d: RawDocument): LucideIcon =>
  /原理图/.test(d.type) ? CircuitBoard : /驱动程序|源码/.test(d.type) ? FileCode2 : FileText

/** 客户工程根目录：路径里以 Program / Project / 工程 结尾的那一段，出现次数最多的那个。 */
function projectRootOf(docs: RawDocument[]) {
  const hits = new Map<string, number>()
  for (const d of docs) {
    const parts = d.path.split('/')
    const i = parts.findIndex((x) => /(program|project|工程)$/i.test(x))
    if (i > 0) {
      const key = parts.slice(0, i + 1).join('/')
      hits.set(key, (hits.get(key) ?? 0) + 1)
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** 被测件的中文名：括号里的出处说明进 tooltip，卡头只留产品名本身 */
function productShort(pack: RawPack) {
  return pack.scene.product.name.replace(/[（(].*$/, '').trim()
}

/** 工程树：客户工程按真实目录（Software / Hardware / Document）铺，工程之外的源材料按类型归一堆。 */
function buildTree(pack: RawPack) {
  const docs = pack.documents.documents.filter((d) => d.path && d.exists)
  const proj = projectRootOf(docs)
  const root: TNode = { name: '', children: new Map() }
  const rest: RawDocument[] = []
  for (const d of docs) {
    if (proj && d.path.startsWith(`${proj}/`)) insert(root, d.path.slice(proj.length + 1), d)
    else rest.push(d)
  }
  if (rest.length) {
    const other: TNode = { name: '其他来源', children: new Map() }
    for (const d of rest) {
      if (!other.children.has(d.type))
        other.children.set(d.type, { name: d.type, children: new Map() })
      other.children.get(d.type)!.children.set(d.id, {
        name: fileName(d.path),
        children: new Map(),
        doc: d,
      })
    }
    root.children.set('其他来源', other)
  }
  return { node: root, prefix: proj, files: docs.length }
}

function ProjectTree({ full }: { full?: boolean }) {
  const pack = getPack()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const tree = useMemo(() => (pack ? buildTree(pack) : null), [pack])

  if (!pack || !tree) return <Empty text="场景包未加载" />
  if (!tree.node.children.size)
    return <EmptyState icon={<Folder size={24} strokeWidth={1.5} />} title="未登记源文件" />

  const count = (n: TNode): number =>
    (n.doc ? 1 : 0) + [...n.children.values()].reduce((s, c) => s + count(c), 0)

  const render = (n: TNode, depth: number, key: string): ReactNode[] => {
    const rows: ReactNode[] = []
    // 工程自己的三根（Software / Hardware / Document）排前，工程外的归到最后
    const rank = (x: TNode) =>
      x.name === '其他来源' ? 9 : /^software$/i.test(x.name) ? 0 : /^hardware$/i.test(x.name) ? 1 : 2
    const kids = [...n.children.values()].sort(
      (a, b) => rank(a) - rank(b) || b.children.size - a.children.size || a.name.localeCompare(b.name),
    )
    for (const raw of kids) {
      const isDir = raw.children.size > 0
      const { label, node: k } = isDir ? compact(raw) : { label: raw.name, node: raw }
      const id = `${key}/${label}`
      const n2 = count(k)
      // 默认只摊开「一层就是文件」的小目录，大堆的留给点击展开，卡里不出半行硬切
      const flat = [...k.children.values()].every((c) => c.children.size === 0)
      const isOpen = open[id] ?? (depth < (full ? 2 : 1) && flat && n2 <= (full ? 24 : 4))
      rows.push(
        <div
          key={id}
          className="flex h-[24px] items-center gap-1.5 text-[12.5px]"
          style={{ paddingLeft: depth * 13 }}
        >
          {isDir ? (
            <button
              type="button"
              aria-label={isOpen ? '折叠' : '展开'}
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [id]: !isOpen }))}
              className="flex h-[16px] w-[14px] shrink-0 items-center text-t3 transition-colors hover:text-p700"
            >
              <ChevronRight
                size={13}
                strokeWidth={2}
                className={cn('transition-transform duration-200', isOpen && 'rotate-90 text-p600')}
              />
            </button>
          ) : (
            <span className="w-[14px] shrink-0" />
          )}
          <span className="shrink-0 [&>svg]:block">
            {isDir ? (
              <Folder size={13} strokeWidth={1.9} className="text-p600" />
            ) : (
              (() => {
                const Ic = raw.doc ? leafIcon(raw.doc) : FileText
                return <Ic size={13} strokeWidth={1.9} className="text-t3" />
              })()
            )}
          </span>
          <Tooltip content={raw.doc ? `${raw.doc.title}\n${raw.doc.path}` : label}>
            <span className={cn('cursor-help truncate', isDir ? 'font-medium text-t1' : 'text-t2')}>
              {label}
            </span>
          </Tooltip>
          <span className="num ml-auto shrink-0 text-[12px] text-t3">
            {isDir ? n2 : sizeText(raw.doc?.size_bytes)}
          </span>
        </div>,
      )
      if (isDir && isOpen) rows.push(...render(k, depth + 1, id))
    }
    return rows
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-baseline gap-1.5 pb-1">
        <Tooltip
          content={`${pack.scene.product.name}\n场景包 ${pack.scene.id}\n${tree.prefix ?? '本场景包的源材料不在同一个工程目录下'}`}
        >
          <span className="cursor-help truncate text-[12.5px] font-medium text-t1">
            {productShort(pack)}
          </span>
        </Tooltip>
        <span className="num min-w-0 truncate text-[12px] text-t3">{pack.scene.id}</span>
        <span className="num ml-auto shrink-0 text-[12px] text-t3">{tree.files}</span>
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
        }}
      >
        {render(tree.node, 0, '')}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- 卡片 · 安全联锁 */

const TYPE_ORDER = ['硬件', '流程', '人员'] as const

function InterlockRing({ full }: { full?: boolean }) {
  const pack = getPack()
  if (!pack) return <Empty text="场景包未加载" />
  const items = pack.interlocks.interlocks
  const counts = TYPE_ORDER.map((t) => ({ t, n: items.filter((i) => i.type === t).length }))
  // 环形进度表示「已带可核验阈值」的条数占比：硬件项多数有固件阈值，流程与人员项靠人放行。
  const withTh = items.filter((i) => i.threshold && Object.keys(i.threshold).length > 0).length
  const human = items.filter((i) => i.type === '人员' || i.type === '流程').length
  const R = 22
  const C = 2 * Math.PI * R
  const ratio = items.length ? withTh / items.length : 0

  return (
    <div className="flex h-full min-h-0 w-full items-center gap-4">
      <Tooltip content={`共 ${items.length} 条联锁，其中 ${withTh} 条带可核验阈值；流程与人员共 ${human} 条要在流程 4 逐条放行。`}>
        <div className="relative shrink-0 cursor-help">
          <svg width="58" height="58" viewBox="0 0 58 58">
            <circle cx="29" cy="29" r={R} fill="none" stroke="var(--p-100)" strokeWidth="6" />
            <circle
              cx="29"
              cy="29"
              r={R}
              fill="none"
              stroke="var(--p-600)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${C * ratio} ${C}`}
              transform="rotate(-90 29 29)"
              style={{ transition: 'stroke-dasharray .4s cubic-bezier(.22,.75,.3,1)' }}
            />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="num text-[17px] leading-none font-semibold text-t1">{withTh}</span>
            <span className="num text-[12px] text-t3">/{items.length}</span>
          </span>
        </div>
      </Tooltip>

      <div className="min-w-0 flex-1">
        {counts.map(({ t, n }) => (
          <Tooltip
            key={t}
            className="w-full"
            content={`${t}：${pack.interlocks.types[t] ?? ''}${t === '硬件' ? '' : `（${human} 条待放行，流程 4 逐条确认）`}`}
          >
            <div className="flex w-full cursor-help items-center gap-1.5 border-b border-line-soft py-[5px] text-[12.5px] text-t2 last:border-b-0">
              <span
                className={cn(
                  'h-[7px] w-[7px] shrink-0 rounded-full',
                  t === '硬件' ? 'bg-p600' : t === '流程' ? 'bg-p300' : 'bg-warn',
                )}
              />
              {t}
              <span className="num ml-auto text-[13px] font-semibold text-t1">{n}</span>
            </div>
          </Tooltip>
        ))}
      </div>

      {full ? (
        <ul className="max-h-[400px] min-w-0 flex-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2 border-b border-line-soft py-1 last:border-b-0">
              <span className="num shrink-0 text-[12px] text-t3">{i.id}</span>
              <Tooltip content={i.action}>
                <span className="cursor-help truncate text-[12.5px] text-t1">{i.name}</span>
              </Tooltip>
              <Badge tone="neutral" className="ml-auto">
                {i.type}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- 卡片 · 台架实况 */

const INSTRUMENT_RULES: { re: RegExp; icon: LucideIcon; name: string; hint: string }[] = [
  {
    re: /示波器|rigol/i,
    icon: Activity,
    name: '数字示波器',
    hint: '实测量字典里由示波器取的量：FG 频率、母线与相电流峰值、三相相位差。',
  },
  {
    re: /红外|CMD7/i,
    icon: Radar,
    name: '红外转速计',
    hint: '机械转速真值由红外转速计 / CMD7 FG2 取，用来校核 FG 换算出的转速。',
  },
  {
    re: /力传感器/,
    icon: Gauge,
    name: '力传感器',
    hint: '防夹力与堵转力由力传感器取，量程按堵转力 ≥212 N 选型。',
  },
  {
    re: /位移传感器/,
    icon: Ruler,
    name: '位移传感器',
    hint: '开口、行程与回缩量由位移传感器取，分辨率 0.05 mm。',
  },
  {
    re: /电流传感器/,
    icon: Zap,
    name: '电流传感器',
    hint: '工作电流与堵转电流由电流传感器取，兼作换向纹波计数源。',
  },
  {
    re: /程控电源/,
    icon: Zap,
    name: '程控电源',
    hint: '试验电压由程控电源给并回读；起动电压试验靠它缓升。',
  },
  {
    re: /声级计/,
    icon: Waves,
    name: '声级计',
    hint: '工作噪音测点在电机出力轴正上方 300 mm，取全过程最大值。',
  },
]

/** 仪器从场景包自己的实测量字典推：谁取数就出谁，推不出来就不出这一行，不硬凑。 */
function instrumentsOf(pack: RawPack) {
  const hows = Object.values(pack.requirements.runtime_measures ?? {}).map((m) => m.obtained_by ?? '')
  return INSTRUMENT_RULES.filter((r) => hows.some((h) => r.re.test(h))).slice(0, 3)
}

function BenchLive({ full }: { full?: boolean }) {
  const pack = getPack()
  const [state, setState] = useState<ConnState>('connecting')
  useEffect(() => {
    let alive = true
    void probeDevice('bench')
      .then((r) => alive && setState(r.online ? 'connected' : 'closed'))
      .catch(() => alive && setState('error'))
    return () => {
      alive = false
    }
  }, [])
  if (!pack) return <Empty text="场景包未加载" />

  const online = state === 'connected'
  const rows = [
    {
      icon: Monitor,
      name: '台架工控机',
      meta: '172.25.5.166',
      status: (online ? 'done' : 'empty') as 'done' | 'empty',
      text: online ? '在线' : '未接入',
      hint: online
        ? '网关 :8022 在线，可开 SSH 会话与远程取图。'
        : '网关未启动，流程 2 不需要连台架；起法：cd ~/lab/webssh && npm run gateway，端口 8022。',
    },
    ...instrumentsOf(pack)
      .slice(0, full ? 3 : 2)
      .map((d) => ({
        icon: d.icon,
        name: d.name,
        meta: '待接入',
        status: 'empty' as const,
        text: '未接入',
        hint: `${d.hint} 初始化阶段不建会话，实际接入在流程 4。`,
      })),
  ]

  return (
    <div
      className="no-scrollbar flex h-full min-h-0 w-full flex-col overflow-y-auto"
      style={{
        maskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
      }}
    >
      {rows.map((r) => (
        <Tooltip key={r.name} className="w-full" content={r.hint}>
          <div className="flex w-full cursor-help items-center gap-2.5 border-b border-line-soft py-[7px] last:border-b-0">
            <span className="shrink-0 text-p600 [&>svg]:block">
              <r.icon size={14} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-t1">{r.name}</span>
            <span className="num shrink-0 text-[12px] text-t3">{r.meta}</span>
            <StatusDot status={r.status} label={r.text} />
          </div>
        </Tooltip>
      ))}
      {/* 最近一次台架截图：网关未起时没有图，给缩略占位而不是留白 */}
      <Tooltip
        className="w-full"
        content={
          online
            ? '最近一次取图来自台架工控机 C:\\fc_pull，点开可看全图。'
            : '网关未启动，本场景包里也没有留档的台架截图，这里是占位框——不拿别处的图冒充台架实况。'
        }
      >
        <div className="mt-1.5 flex w-full shrink-0 cursor-help items-center gap-2.5">
          <span className="paper-grid flex h-[38px] w-[62px] shrink-0 items-center justify-center rounded-tpx border border-line-soft bg-p50 text-p400">
            <ImageIcon size={16} strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-t2">最近一次截图</span>
            <span className="block truncate text-[12px] text-t3">{online ? '待取图' : '无留档'}</span>
          </span>
        </div>
      </Tooltip>
      {full ? (
        <p className="pt-2 text-[12px] leading-5 text-t3">
          浏览器不持有任何凭据；私钥只在网关一侧，devices.json 里写的是环境变量名 FORTIOR_WIN_KEY。
          初始化配置阶段只核对设备在不在，不下发任何动作。
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- 装配 */

export const initCards = {
  'product-view': ProductHero,
  schematic: DocIntake,
  'project-tree': ProjectTree,
  interlock: InterlockRing,
  'bench-live': BenchLive,
}

// 左栏整块接管：壳层默认参数栏没有分组图标、占位色标与上传条。
registerLeftPanel('init', InitLeftPanel)
