import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Cable,
  CheckCircle2,
  CircuitBoard,
  Cpu,
  Gauge,
  ListFilter,
  Lock,
  Monitor,
  RotateCw,
  ShieldCheck,
  Sliders,
  Terminal,
  Waves as WavesIcon,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Collapsible,
  EmptyState,
  InfoTip,
  Select,
  SourceTag,
  StatusDot,
  Stepper,
  Tooltip,
  cn,
} from '../../components/ui'
import { decimalsOf } from '../../data/loadScene'
import { paramKey, useAppStore } from '../../state/useAppStore'
import { byGroup, getPack, sourceLine, statusOf, type RawControlParam } from '../scene/pack'
import { ConfirmFooter, Empty } from '../shared/bits'
import { TimeSeriesChart } from '../timeseries'
import { POWERUP_ANNOTATION, currentThresholds, loadWaves, type Wave } from '../waveforms'
import { RemoteDeviceCard, probeDevice, type ConnState } from '../remote'
import { evaluateAll, runtimeMeasures, type VerdictState } from './evaluate'

/* ===========================================================================
   流程 4 · 启动测试及结果分析（v2 视觉样板页）
   左栏：控制参数分组 + 本轮运行设置 + 安全确认闸门，底部悬浮确认主按钮
   卡片：时序曲线（hero，横跨两格）/ 原理图封面 / 判定 / 安全闸门环 / 台架会话
   数据逻辑不动，只换视觉与版式。
   =========================================================================== */

/** 标签一律收到 6 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/* ---------------------------------------------------- 闸门状态（跨卡片共享） */

const gate = { acked: new Set<string>(), total: 0 }
const gateListeners = new Set<() => void>()
function bumpGate() {
  gateListeners.forEach((l) => l())
}
export function useGate() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((v) => v + 1)
    gateListeners.add(l)
    return () => {
      gateListeners.delete(l)
    }
  }, [])
  return gate
}

/* ------------------------------------------------------------------ 左栏 */

function flowFiltersOf(total: number) {
  return [
    { value: 'F4', label: '本流程可调' },
    { value: 'all', label: `全部 ${total} 项` },
    { value: 'F2', label: '初始化确认' },
    { value: 'F5', label: '调优可调' },
  ]
}

/** 分组图标：按组名关键词取 */
const GROUP_ICON: [RegExp, LucideIcon][] = [
  [/启动|start/i, Zap],
  [/调速|转速|speed/i, Gauge],
  [/顺逆|方向|风/i, RotateCw],
  [/保护|限流|故障/i, ShieldCheck],
  [/电流|电压|功率/i, Activity],
  [/观测|估算|角度/i, WavesIcon],
]
const groupIcon = (name: string): LucideIcon => {
  for (const [re, ic] of GROUP_ICON) if (re.test(name)) return ic
  return Sliders
}

function ParamRow({ p }: { p: RawControlParam }) {
  const key = paramKey('run', 'cp', p.group, p.key)
  const override = useAppStore((s) => s.overrides[key])
  const touched = useAppStore((s) => s.touched[key])
  const setParam = useAppStore((s) => s.setParam)
  const value = override ?? (p.not_applicable ? '不适用' : p.value)
  const editable = !p.not_applicable && p.editable && typeof p.value === 'number'

  const detail = (
    <span className="block space-y-1">
      <span className="block font-medium">{p.name}</span>
      <span className="num block opacity-75">
        {p.key.toUpperCase()}
        {p.min !== null && p.max !== null ? ` · ${p.min}~${p.max}` : ''}
        {p.value_shell ? ` · 外壳 ${p.value_shell}` : ''}
      </span>
      <span className="block opacity-75">{sourceLine(p._source)}</span>
      {statusOf(p) ? <span className="block opacity-75">待核实 · {statusOf(p)}</span> : null}
      {p.value_below_min ? <span className="block">实配值低于源注释自己写的下限</span> : null}
    </span>
  )

  return (
    <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5 transition-colors hover:bg-p50/60">
      <Tooltip className="min-w-0" content={detail}>
        <span className="flex min-w-0 items-center gap-1.5">
          <SourceTag source={touched ? '人工' : '文档'} />
          <span className="cursor-help truncate text-[13px] font-medium text-t1">{short(p.name)}</span>
          {p.value_below_min ? <AlertTriangle size={12} className="shrink-0 text-warn" /> : null}
        </span>
      </Tooltip>

      <span className="ml-auto shrink-0">
        {p.not_applicable ? (
          <span className="text-[12px] text-t3">不适用</span>
        ) : p.options?.length ? (
          <Select
            size="sm"
            className="w-[150px]"
            label={p.name}
            options={p.options.map((o) => ({ value: String(o.value), label: o.label }))}
            value={String(value)}
            onChange={(v) => setParam(key, v)}
          />
        ) : editable ? (
          <Stepper
            size="sm"
            label={p.name}
            value={Number(value)}
            unit={p.unit ?? undefined}
            step={p.step ?? 1}
            min={p.min ?? undefined}
            max={p.max ?? undefined}
            precision={
              decimalsOf(p.step) || Math.min(4, decimalsOf(typeof p.value === 'number' ? p.value : 0))
            }
            onChange={(n) => setParam(key, n)}
          />
        ) : (
          <span className="num text-[15px] font-semibold text-t1">
            {String(value)}
            {p.unit ? <span className="ml-1 text-[12px] font-normal text-t3">{p.unit}</span> : null}
          </span>
        )}
      </span>
    </div>
  )
}

export function RunLeftPanel() {
  const pack = getPack()
  const [filter, setFilter] = useState('F4')
  const g = useGate()
  const [runs, setRuns] = useState(100)
  const [volt, setVolt] = useState<string>('')
  const [gateOpen, setGateOpen] = useState(true)
  const [, force] = useState(0)

  const gateItems = useMemo(
    () => (pack ? pack.interlocks.interlocks.filter((i) => i.type === '人员' || i.type === '流程') : []),
    [pack],
  )
  gate.total = gateItems.length

  if (!pack) return <Empty text="场景包未加载" />

  const params = pack.controls.parameters.filter(
    (p) => filter === 'all' || p.adjustable_in_flows?.some((f) => f.startsWith(filter)),
  )
  const grouped = byGroup(params, pack.controls.groups)
  const green = gateItems.length > 0 && g.acked.size === gateItems.length

  const attr = (re: RegExp) => pack.attributes.attributes.find((a) => re.test(`${a.key}${a.name}`))
  const vMin = attr(/voltage_min|工作电压下限|运行电压下限/)
  const vMax = attr(/voltage_max|工作电压上限|运行电压上限/)
  const vNom = attr(/rated_bus_voltage|rated_voltage|额定.*电压/)
  const voltOptions = [
    vMin ? `LV ${vMin.value} ${vMin.unit ?? 'V'}` : null,
    vNom ? `SV ${vNom.value} ${vNom.unit ?? 'V'}` : null,
    vMax ? `HV ${vMax.value} ${vMax.unit ?? 'V'}` : null,
  ]
    .filter((x): x is string => !!x)
    .map((x) => ({ value: x, label: x }))
  if (!voltOptions.length) voltOptions.push({ value: '未登记', label: '未登记' })
  const voltValue = volt || voltOptions[Math.min(1, voltOptions.length - 1)].value

  const runReq =
    pack.requirements.requirements.find((r) =>
      Object.keys(r.threshold ?? {}).some((k) => /^runs$|required_pass/.test(k)),
    ) ??
    pack.requirements.requirements.find((r) =>
      Object.keys(r.threshold ?? {}).some((k) => /cycles/.test(k)),
    )
  const runNote = runReq
    ? `判据 ${runReq.id}：${runReq.criterion_text}`
    : '本场景包没有按次数计的回归判据，启停次数只作台架设置。'

  const toggle = (id: string) => {
    if (gate.acked.has(id)) gate.acked.delete(id)
    else gate.acked.add(id)
    bumpGate()
    force((v) => v + 1)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* 栏头 */}
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <Sliders size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">参数</h2>
        <span className="num text-[12px] text-t3">{params.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <ListFilter size={13} strokeWidth={1.9} className="text-t3" />
          <Select
            size="sm"
            className="w-[118px]"
            label="按流程过滤"
            options={flowFiltersOf(pack.controls.parameters.length)}
            value={filter}
            onChange={setFilter}
          />
        </div>
      </header>

      <div className="fade-b min-h-0 flex-1 overflow-y-auto pb-2">
        {grouped.map(([g2, items], i) => {
          const Icon = groupIcon(g2)
          // 默认摊开到累计 8 行为止：左栏填得满，又不会一次铺开全部参数
          const before = grouped.slice(0, i).reduce((n, [, xs]) => n + xs.length, 0)
          return (
            <Collapsible
              key={g2}
              icon={<Icon size={14} strokeWidth={1.9} />}
              title={short(g2, 8)}
              defaultOpen={before < 8}
              right={<span className="num text-[12px] text-t3">{items.length}</span>}
            >
              {items.map((p) => (
                <ParamRow key={p.key} p={p} />
              ))}
            </Collapsible>
          )
        })}

        {/* 本轮运行设置 */}
        <Collapsible
          icon={<Cpu size={14} strokeWidth={1.9} />}
          title="运行设置"
          right={<InfoTip content={runNote} />}
        >
          <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5">
            <span className="text-[13px] font-medium text-t1">启停次数</span>
            <span className="ml-auto">
              <Stepper size="sm" label="启停次数" value={runs} step={10} min={1} max={1000} onChange={setRuns} />
            </span>
          </div>
          <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5">
            <span className="text-[13px] font-medium text-t1">电压档</span>
            <span className="ml-auto">
              <Select
                size="sm"
                className="w-[150px]"
                label="电压档"
                options={voltOptions}
                value={voltValue}
                onChange={setVolt}
              />
            </span>
          </div>
        </Collapsible>

        {/* 安全确认闸门 */}
        <div className="border-b border-line-soft">
          <button
            type="button"
            onClick={() => setGateOpen((v) => !v)}
            aria-expanded={gateOpen}
            className={cn(
              'flex h-[44px] w-full items-center gap-2.5 px-4 text-left transition-colors',
              green ? 'bg-p50' : 'bg-sunk hover:bg-p50',
            )}
          >
            <ShieldCheck
              size={16}
              strokeWidth={1.9}
              className={cn('shrink-0', green ? 'text-p700' : 'text-t3')}
            />
            <span className="text-[13px] font-semibold tracking-tight text-t1">安全闸门</span>
            <span className="num ml-auto text-[13px] font-semibold text-t1">
              {g.acked.size}
              <span className="text-t3">/{gateItems.length}</span>
            </span>
            <Badge tone={green ? 'soft' : 'neutral'} dot>
              {green ? '全绿' : '未放行'}
            </Badge>
          </button>
          {gateOpen ? (
            <ul className="animate-fade">
              {gateItems.map((i) => {
                const on = gate.acked.has(i.id)
                return (
                  <li key={i.id}>
                    <Tooltip className="w-full" content={`${i.id} ${i.name} · ${i.action}`}>
                      <button
                        type="button"
                        onClick={() => toggle(i.id)}
                        className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors hover:bg-p50/70"
                      >
                        <span
                          className={cn(
                            'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors [&>svg]:block',
                            on ? 'border-transparent bg-p600 text-white' : 'border-line bg-white text-transparent',
                          )}
                        >
                          <CheckCircle2 size={12} strokeWidth={2.5} />
                        </span>
                        <span className="truncate text-[13px] text-t1">{short(i.name, 10)}</span>
                        <span className="num ml-auto shrink-0 text-[12px] text-t3">{i.id}</span>
                      </button>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      </div>

      {/* 底部悬浮确认 */}
      <ConfirmFooter
        label="确认参数"
        count={params.length}
        unit="项"
        hint={
          green
            ? `本流程可调 ${params.length} 项，安全闸门 ${gateItems.length} 条已全部确认。`
            : `本流程可调 ${params.length} 项；安全闸门还差 ${gateItems.length - g.acked.size} 条未确认，确认前不可启动。`
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 时序曲线 */

function useWaves() {
  const pack = getPack()
  const [waves, setWaves] = useState<Wave[]>([])
  useEffect(() => {
    let alive = true
    void loadWaves().then((w) => alive && setWaves(w))
    return () => {
      alive = false
    }
  }, [pack])
  return waves
}

/** 卡体高度随视口缩放，图表高度跟着量出来，避免 1440/1600 下横轴被裁。
 *  用回调 ref 而不是 useEffect：卡体是在时序数据到位之后才挂上来的，
 *  空态阶段 ref 还是 null，写在 useEffect 里会错过那一次挂载。 */
function useBoxHeight() {
  const [h, setH] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    const obs = new ResizeObserver(() => setH(el.clientHeight))
    obs.observe(el)
    ro.current = obs
    setH(el.clientHeight)
  }, [])
  return [ref, h] as const
}

export function WaveformPanel({ full }: { full?: boolean }) {
  const pack = getPack()
  const waves = useWaves()
  const [box, boxH] = useBoxHeight()
  const [on, setOn] = useState<Record<string, boolean>>({})
  if (!waves.length)
    return <EmptyState icon={<WavesIcon size={24} strokeWidth={1.5} />} title="读取时序" />
  const show = waves.filter((w) => on[w.id] ?? true)
  const peak = Math.max(...waves.map((w) => w.metrics.peak))
  const th = currentThresholds(full, peak)
  const unit = waves[0].unit

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-1.5">
        {waves.map((w) => {
          const active = on[w.id] ?? true
          return (
            <Tooltip key={w.id} content={`${w.title} · ${w.verdictText}`}>
              <button
                type="button"
                onClick={() => setOn((o) => ({ ...o, [w.id]: !(o[w.id] ?? true) }))}
                className={cn(
                  'num inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium transition-colors',
                  active
                    ? w.verdict === 'fail'
                      ? 'border-p200 bg-white text-t2'
                      : 'border-p200 bg-p50 text-p700'
                    : 'border-line bg-white text-t3',
                )}
              >
                <span
                  className="h-[6px] w-[6px] rounded-full"
                  style={{ background: active ? w.series.color : 'var(--p-200)' }}
                />
                {w.id}
              </button>
            </Tooltip>
          )
        })}
        {pack?.caps.syntheticData ? (
          <Badge tone="warn" title={pack.caps.syntheticBanner}>
            合成
          </Badge>
        ) : null}
        {pack?.caps.probeUnconfirmed ? <InfoTip content={pack.caps.probeNote} /> : null}
        <span className="num ml-auto text-[12px] text-t3">
          {waves[0].sampleRate ? `${Math.round(waves[0].sampleRate / 1000)} kSa/s` : '—'}
        </span>
      </div>
      <div ref={box} className="min-h-0 flex-1">
        <TimeSeriesChart
          series={show.map((w) => w.series)}
          annotations={[POWERUP_ANNOTATION]}
          thresholds={th}
          showOverlayLabels={!!full}
          legend={!!full}
          cursor={!!full}
          height={full ? 400 : Math.max(120, boxH - 20)}
          xLabel={`时间 s · 纵轴 ${unit || '原始量'}`}
        />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- 卡片 · 原理图封面 */

function SchematicCover({ full }: { full?: boolean }) {
  const pack = getPack()
  const [i, setI] = useState(-1)
  if (!pack) return <Empty text="场景包未加载" />
  // 变体登记的是 PDF 原始路径；包内渲出来的分页图挂在 scene.images 上，
  // 按 _source.file 与变体对上号，对不上的如实显示「未渲染分页图」，不拿别的图冒充。
  const imgOf = (file: string) =>
    pack.scene.images?.find((im) => {
      const src = (im as { _source?: { file?: string } })._source
      return src?.file === file
    })?.path ?? null
  const vs = pack.scene.schematic_variants
  const srcOf = (v: { file: string; rendered?: string }) =>
    v.rendered ?? (v.file.startsWith('assets/') ? v.file : imgOf(v.file))
  const renderable = vs.findIndex((v) => srcOf(v))
  const pick = i >= 0 ? i : Math.max(0, renderable)
  if (!vs.length)
    return <EmptyState icon={<CircuitBoard size={24} strokeWidth={1.5} />} title="未登记图纸" />
  const cur = vs[Math.min(pick, vs.length - 1)]
  const src = srcOf(cur)

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5">
      <div className="min-h-0 flex-1 overflow-hidden rounded-tp2 bg-p50">
        {src ? (
          <img
            src={pack.base + src}
            alt={cur.name}
            className={cn(
              'h-full w-full',
              full ? 'object-contain' : src.endsWith('.svg') ? 'object-cover object-center' : 'object-cover object-top',
            )}
          />
        ) : (
          <EmptyState icon={<CircuitBoard size={24} strokeWidth={1.5} />} title="未渲染分页图" />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {vs.slice(0, 4).map((v, k) => (
          <Tooltip key={v.name} content={v.name}>
            <button
              type="button"
              onClick={() => setI(k)}
              className={cn(
                'h-[6px] w-[18px] rounded-full transition-colors',
                pick === k ? 'bg-p600' : 'bg-p200 hover:bg-p300',
              )}
              aria-label={v.name}
            />
          </Tooltip>
        ))}
        <span className="num ml-auto text-[12px] text-t3">
          {Math.min(pick, vs.length - 1) + 1}/{vs.length}
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- 卡片 · 判定卡 */

const STATE_LABEL: Record<VerdictState, string> = {
  pass: '通过',
  fail: '不通过',
  missing: '未采集',
  manual: '人工判',
}

function VerdictCard({ full }: { full?: boolean }) {
  const pack = getPack()
  const waves = useWaves()
  if (!pack) return <Empty text="场景包未加载" />
  const rows = evaluateAll(pack, runtimeMeasures(waves))
  const pass = rows.filter((r) => r.state === 'pass').length
  const fail = rows.filter((r) => r.state === 'fail').length
  const missing = rows.filter((r) => r.state === 'missing').length
  const judged = rows.filter((r) => r.state === 'pass' || r.state === 'fail')
  const list = full ? rows : [...judged, ...rows.filter((r) => r.state === 'missing')].slice(0, 6)

  const Stat = ({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'bad' | 'mute' }) => (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            tone === 'ok' ? 'bg-p600' : tone === 'bad' && n > 0 ? 'bg-alert' : 'bg-t3/40',
          )}
        />
        <span className="text-[12px] text-t3">{label}</span>
      </span>
      <span
        className={cn(
          'num text-[26px] leading-none font-semibold tracking-tight',
          tone === 'bad' && n > 0 ? 'text-alert' : 'text-t1',
        )}
      >
        {n}
      </span>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-start gap-2 pb-2">
        <Stat n={pass} label="通过" tone="ok" />
        <Stat n={fail} label="不通过" tone="bad" />
        <Stat n={missing} label="未采集" tone="mute" />
        <InfoTip
          content={`已求值 ${judged.length} / ${pack.requirements.evaluable_count} 条可求值判据，全表 ${rows.length} 条。${
            judged.length === 0
              ? '本轮一条都判不了：判据要的现场实测量（母线电流、转速、力、位移、声压级）得由台架传感器现场采，本轮只回放了一条曲线，不拿别的数顶替。'
              : ''
          }`}
        />
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
        }}
      >
        {list.map((r) => (
          <Tooltip
            key={r.req.id}
            className="w-full"
            content={`${r.req.criterion_text}${r.missing.length ? ` · 缺 ${r.missing.join('、')}` : ''}`}
          >
            <div className="flex w-full items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0">
              <StatusDot
                status={r.state === 'pass' ? 'done' : r.state === 'fail' ? 'alert' : 'na'}
              />
              <span className="truncate text-[12.5px] text-t1">{short(r.req.name, 12)}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">{STATE_LABEL[r.state]}</span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- 卡片 · 安全闸门环 */

function GateRing({ full }: { full?: boolean }) {
  const pack = getPack()
  const g = useGate()
  if (!pack) return <Empty text="场景包未加载" />
  const human = pack.interlocks.interlocks.filter((i) => i.type === '人员' || i.type === '流程')
  const hw = pack.interlocks.interlocks.filter((i) => i.type === '硬件')
  const done = g.acked.size
  const total = human.length || 1
  const R = 26
  const C = 2 * Math.PI * R
  const ratio = done / total

  return (
    <div className="flex h-full min-h-0 w-full items-center gap-4">
      <div className="relative shrink-0">
        <svg width="68" height="68" viewBox="0 0 68 68">
          <circle cx="34" cy="34" r={R} fill="none" stroke="var(--p-100)" strokeWidth="7" />
          <circle
            cx="34"
            cy="34"
            r={R}
            fill="none"
            stroke={ratio === 1 ? 'var(--p-600)' : 'var(--tp-warn)'}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${C * ratio} ${C}`}
            transform="rotate(-90 34 34)"
            style={{ transition: 'stroke-dasharray .4s cubic-bezier(.22,.75,.3,1)' }}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="num text-[17px] leading-none font-semibold text-t1">{done}</span>
          <span className="num text-[11px] text-t3">/{human.length}</span>
        </span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={14} strokeWidth={1.9} className="shrink-0 text-p700" />
          <span className="text-[13px] font-medium text-t1">人工闸门</span>
          <Badge tone={ratio === 1 ? 'soft' : 'warn'} dot className="ml-auto">
            {ratio === 1 ? '全绿' : '待确认'}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-t3">
          <Lock size={13} strokeWidth={1.9} className="shrink-0 text-p400" />
          硬件联锁
          <span className="num ml-auto text-t1">{hw.length}</span>
        </div>
        <Tooltip content="硬件联锁由固件阈值保证，不需要人工逐条确认；人工闸门未全绿前「启动测试」保持置灰。">
          <span className="num cursor-help text-[12px] text-t3">
            共 {pack.interlocks.interlocks.length} 条
          </span>
        </Tooltip>
        {full ? (
          <ul className="max-h-[300px] overflow-y-auto pt-1">
            {pack.interlocks.interlocks.map((i) => (
              <li key={i.id} className="flex items-center gap-2 border-b border-line-soft py-1 last:border-b-0">
                <span className="num shrink-0 text-[12px] text-t3">{i.id}</span>
                <span className="truncate text-[12.5px] text-t1">{i.name}</span>
                <Badge tone="neutral" className="ml-auto">
                  {i.type}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 台架实况 */

const BENCH = {
  id: 'bench',
  name: '台架工控机',
  model: 'SK-20251218QPBB / Windows 11',
  host: '172.25.5.166',
  port: 5011,
  user: 'administrator',
  keyRef: 'FORTIOR_WIN_KEY',
  kind: 'host' as const,
  via: null,
  presets: [
    { label: '主机名', cmd: 'hostname' },
    { label: '取图目录', cmd: 'dir C:\\fc_pull' },
  ],
}

function BenchLive({ full }: { full?: boolean }) {
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

  if (full) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-2">
        <RemoteDeviceCard device={BENCH} state={state} onOpenTerminal={() => {}} />
        <p className="text-[12px] leading-5 text-t3">
          浏览器不持有任何凭据；私钥只在网关一侧，devices.json 里写的是环境变量名 FORTIOR_WIN_KEY。
          台架机 SSH 服务跑在 Session 0，桌面 GUI 在 Session 1。
        </p>
      </div>
    )
  }

  const online = state === 'connected'
  return (
    <div className="flex h-full min-h-0 w-full flex-col justify-center gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-tps bg-p50 text-p700">
          <Monitor size={17} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-t1">台架工控机</span>
          <span className="num block truncate text-[12px] text-t3">{BENCH.host}</span>
        </span>
        <Badge tone={online ? 'soft' : 'warn'} dot>
          {online ? '在线' : '离线'}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" icon={<Terminal size={13} strokeWidth={1.9} />}>
          终端
        </Button>
        <Button size="sm" variant="default" icon={<Cable size={13} strokeWidth={1.9} />}>
          取图
        </Button>
        <Tooltip
          content={
            online
              ? '网关 :8022 在线，可开 SSH 会话与远程取图。'
              : '网关未启动。起法：cd ~/lab/webssh && npm run gateway，端口 8022，token 在 .env。'
          }
        >
          <span className="ml-auto cursor-help text-t3">
            <InfoTip content={online ? '网关 :8022 在线' : '网关未启动（离线态）'} />
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- 卡片 · 执行进度（备） */

function Progress({ full }: { full?: boolean }) {
  const pack = getPack()
  const waves = useWaves()
  if (!pack) return <Empty text="场景包未加载" />
  const s2 = pack.datasets.package_stats as Record<string, number>
  const hasBatch = typeof s2.attempts_total === 'number'
  const done = hasBatch ? (s2.labeled ?? 0) : waves.length
  const total = hasBatch ? s2.attempts_total : pack.datasets.datasets.length

  const log = [
    `[00:00.0] 载入需求基线：判据 ${pack.requirements.requirements.length} 条`,
    `[00:00.3] 联锁自检：硬件 ${pack.interlocks.interlocks.filter((i) => i.type === '硬件').length} 条由固件阈值保证`,
    `[00:02.0] 采集口径：${Math.round(pack.datasets.datasets[0]?.sample_rate_sa_per_s ?? 0)} Sa/s`,
    ...waves.map(
      (w) =>
        `[回放] ${w.id} ${w.verdictText} · 峰值 ${w.metrics.peak.toFixed(2)} ${w.unit} @ ${w.metrics.peakAt.toFixed(2)} s`,
    ),
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="num text-[26px] leading-none font-semibold text-t1">{done}</span>
        <span className="num text-[13px] text-t3">/ {total}</span>
        <span className="ml-auto text-[12px] text-t3">{hasBatch ? '已标注' : '已回放'}</span>
      </div>
      <div className="h-[6px] shrink-0 overflow-hidden rounded-full bg-p100">
        <div
          className="h-full rounded-full bg-p600 transition-[width] duration-500"
          style={{ width: `${Math.round((done / (total || 1)) * 100)}%` }}
        />
      </div>
      <div className="mono min-h-0 flex-1 overflow-y-auto text-[11px] leading-[18px] text-t3">
        {(full ? log : log.slice(-5)).map((l) => (
          <div key={l} className="truncate" title={l}>
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}

export const runCards = {
  timeseries: WaveformPanel,
  schematic: SchematicCover,
  verdict: VerdictCard,
  interlock: GateRing,
  'remote-device': BenchLive,
  progress: Progress,
}
