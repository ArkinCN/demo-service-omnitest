import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircuitBoard,
  Cpu,
  Gauge,
  ChevronRight,
  ListFilter,
  Lock,
  Monitor,
  RotateCw,
  ShieldCheck,
  Sliders,
  Waves as WavesIcon,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
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
import { useNavigate } from 'react-router'
import { RUN_PHASE_LABEL, collapseKey, paramKey, useAppStore } from '../../state/useAppStore'
import { useFlowActions } from '../redline'
import {
  getPack,
  sourceLine,
  statusOf,
  type RawControlParam,
  type RawInterlock,
  type RawPack,
} from '../scene/pack'
import { ConfirmFooter, Empty, TierTree } from '../shared/bits'
import { buildTiers, demoFilter, readTiers } from '../shared/tiers'
import { TimeSeriesChart } from '../timeseries'
import { POWERUP_ANNOTATION, currentThresholds, loadWaves, type Wave } from '../waveforms'
import { evaluateAll, measureOrigin, runtimeMeasures, type VerdictState } from './evaluate'

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

/* ---------------------------------------------------- 闸门状态（跨卡片共享）

   第四轮把这份状态从模块级私有变量搬进 useAppStore：顶栏动作条要靠它算
   「启动测试」亮不亮，顶栏盾形徽章要靠它报还差几条，模块级变量这两处都拿不到。
   依据：08c-部署联调与演示SOP-v1.0.md 第零节「点不动的三处」第 2 条。 */

export function useGate() {
  const acked = useAppStore((s) => s.gateAcked)
  const total = useAppStore((s) => s.gateTotal)
  return useMemo(() => ({ acked: new Set(acked), total }), [acked, total])
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
  [/闭环|整定|环路|PI/i, WavesIcon],
  [/流程纪律|纪律/, ShieldCheck],
  [/人员|现场/, Monitor],
  [/启动|预定位|start/i, Zap],
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
const iconOf = (name: string, size = 14) => {
  const Ic = groupIcon(name)
  return <Ic size={size} strokeWidth={1.9} />
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

/**
 * 闸门分组：编号里自带 PROC / PERSON 类别，直接拿来当二级组，不再九条平铺；
 * 组内超过 5 条的（流程类 7 条）再按场景包 group_tiers 切一层三级子组。
 */
interface GateGroup {
  id: string
  title: string
  items: RawInterlock[]
  subs: { id: string; title: string; items: RawInterlock[] }[]
}

function gateGroups(pack: RawPack, items: RawInterlock[]): GateGroup[] {
  const spec = readTiers(pack.interlocks).filter((t) => /流程|人员/.test(t.title))
  const pick = (ids?: string[]) => {
    const want = new Set((ids ?? []).map((x) => x.toLowerCase()))
    return items.filter((i) => want.has(i.id.toLowerCase()))
  }
  const out: GateGroup[] = spec.map((t) => {
    const mine = pick(t.groups.flatMap((g) => g.items ?? []))
    return {
      id: t.id,
      title: t.title,
      items: mine,
      subs:
        mine.length > 5
          ? t.groups
              .map((g) => ({ id: g.id, title: g.title, items: pick(g.items) }))
              .filter((g) => g.items.length > 0)
          : [],
    }
  })
  const used = new Set(out.flatMap((g) => g.items.map((i) => i.id)))
  const rest = items.filter((i) => !used.has(i.id))
  if (rest.length) out.push({ id: 'gate-rest', title: '其他', items: rest, subs: [] })
  return out.filter((g) => g.items.length > 0)
}

/** 闸门一行：圆形勾选 + 短名 + 编号 */
function GateRow({
  i,
  on,
  onToggle,
}: {
  i: RawInterlock
  on: boolean
  onToggle: () => void
}) {
  return (
    <Tooltip className="w-full" content={`${i.id} ${i.name} · ${i.action}`}>
      <button
        type="button"
        onClick={onToggle}
        data-gate={i.id}
        aria-pressed={on}
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
  )
}

export function RunLeftPanel() {
  const pack = getPack()
  const [filter, setFilter] = useState('F4')
  const g = useGate()
  const [runs, setRuns] = useState(100)
  const [volt, setVolt] = useState<string>('')
  const [gateOpen, setGateOpen] = useState(true)
  const demo = useAppStore((s) => s.demoMode)
  const toggle = useAppStore((s) => s.toggleGate)
  const setGateTotal = useAppStore((s) => s.setGateTotal)
  const bind = useFlowActions()

  const gateItems = useMemo(
    () => (pack ? pack.interlocks.interlocks.filter((i) => i.type === '人员' || i.type === '流程') : []),
    [pack],
  )
  // 闸门总条数由本场景包登记，写进 store 供顶栏动作条与盾形徽章共用
  useEffect(() => setGateTotal(gateItems.length), [gateItems.length, setGateTotal])

  if (!pack) return <Empty text="场景包未加载" />

  // 演示模式只暴露 demo_profile 点名的那 12 项控制参数；全量模式下按流程过滤照旧。
  const params = demoFilter(
    pack.controls,
    'parameters',
    pack.controls.parameters.filter(
      (p) => filter === 'all' || p.adjustable_in_flows?.some((f) => f.startsWith(filter)),
    ),
    (p) => p.key,
  )
  // 一级类取自场景包 control-parameters.json 的 group_tiers：启动与预定位 / 闭环与整定 /
  // 运行与保护。启动组 10 项按「模式与时序」「电流与增益」切三级子组。
  const tiers = buildTiers<RawControlParam>(
    readTiers(pack.controls),
    params,
    (p) => p.key,
    (p) => p.group,
  )
  const green = gateItems.length > 0 && g.acked.size === gateItems.length
  const groups = gateGroups(pack, gateItems)

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
        <TierTree
          flow="run"
          tiers={tiers}
          // 一级类只展开第一个「启动与预定位」，其余折叠
          defaultOpen={0}
          itemKey={(p) => p.key}
          render={(p) => <ParamRow p={p} />}
          flags={(p) => ({
            filled: p.value !== null,
            pending: !!statusOf(p),
            alert: !!p.value_below_min,
          })}
          tierIcon={(t) => iconOf(t, 15)}
          groupIcon={(t) => iconOf(t)}
        />

        {/* 本轮运行设置 */}
        <Collapsible
          level={1}
          icon={<Cpu size={15} strokeWidth={1.9} />}
          title="运行设置"
          storeKey={collapseKey('run', 'run-setting')}
          defaultOpen={false}
          stat={{ total: 2 }}
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

        {/* 安全确认闸门：组头带放行状态，组内按编号自带的类别分两组 */}
        <div className="border-b border-line">
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
            <div className="animate-fade">
              {groups.map((grp, i) => (
                <Collapsible
                  key={grp.id}
                  level={2}
                  icon={iconOf(grp.title)}
                  title={grp.title}
                  storeKey={collapseKey('run', grp.id)}
                  // 演示模式下逐条清单一律折叠，组头自带「勾了几条 / 共几条」，
                  // 镜 3 要勾时再点开（06d 第 3.1 节）
                  defaultOpen={!demo && i === 0}
                  stat={{
                    done: grp.items.filter((x) => g.acked.has(x.id)).length,
                    total: grp.items.length,
                  }}
                >
                  {grp.subs.length ? (
                    grp.subs.map((sub, k) => (
                      <Collapsible
                        key={sub.id}
                        level={3}
                        title={sub.title}
                        storeKey={collapseKey('run', sub.id)}
                        defaultOpen={!demo && k === 0}
                        stat={{
                          done: sub.items.filter((x) => g.acked.has(x.id)).length,
                          total: sub.items.length,
                        }}
                      >
                        {sub.items.map((i2) => (
                          <GateRow
                            key={i2.id}
                            i={i2}
                            on={g.acked.has(i2.id)}
                            onToggle={() => toggle(i2.id)}
                          />
                        ))}
                      </Collapsible>
                    ))
                  ) : (
                    <>
                      {grp.items.map((i2) => (
                        <GateRow
                          key={i2.id}
                          i={i2}
                          on={g.acked.has(i2.id)}
                          onToggle={() => toggle(i2.id)}
                        />
                      ))}
                    </>
                  )}
                </Collapsible>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* 底部悬浮确认 */}
      {/* 底部确认按钮与顶栏「启动测试」同一条动作、同一份行为表，
          点下去照样先弹红线确认卡，不另开一条放行路径 */}
      <ConfirmFooter
        label="确认参数"
        count={params.length}
        unit="项"
        onClick={bind('start').disabled ? undefined : bind('start').onClick}
        hint={
          green
            ? `本流程可调 ${params.length} 项，安全闸门 ${gateItems.length} 条已全部确认，点此启动本轮（仍需在确认卡上再点一次）。`
            : `本流程可调 ${params.length} 项；安全闸门还差 ${gateItems.length - g.acked.size} 条未确认，确认前不可启动。`
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 时序曲线 */

/**
 * 本轮回放哪几条时序。演示主线只要一失败一成功两条（datasets.json 的
 * demo_profile 点名 TRY-0010 与 TRY-0009）；全量模式下包里登记的照旧全放。
 */
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
  return pack ? demoFilter(pack.datasets, 'datasets', waves, (w) => w.id) : waves
}

/** 图例上的成败字样：只有编号看不出这条是成还是败（06d 第 3.1 节） */
const verdictWord = (w: Wave) =>
  w.verdict === 'pass' ? 'PASS' : w.verdict === 'fail' ? 'FAIL' : w.verdictText

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
                <span className={cn('font-semibold', w.verdict === 'fail' ? 'text-alert' : 'text-p700')}>
                  {verdictWord(w)}
                </span>
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
        {/* 采样率读数不进演示分镜（06d 第 3.1 节），放大态仍给 */}
        {full ? (
          <span className="num ml-auto text-[12px] text-t3">
            {waves[0].sampleRate ? `${Math.round(waves[0].sampleRate / 1000)} kSa/s` : '—'}
          </span>
        ) : null}
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
  const demo = useAppStore((s) => s.demoMode)
  const runPhase = useAppStore((s) => s.runPhase)
  const runProgress = useAppStore((s) => s.runProgress)
  const setFocusReq = useAppStore((s) => s.setFocusReq)
  const nav = useNavigate()
  if (!pack) return <Empty text="场景包未加载" />
  // 演示模式只判 demo_profile 点名的 6 条；放大态与全量模式给全表。
  const all = evaluateAll(pack, runtimeMeasures(waves, pack))
  const rows = full ? all : demoFilter(pack.requirements, 'requirements', all, (r) => r.req.id)
  const pass = rows.filter((r) => r.state === 'pass').length
  const fail = rows.filter((r) => r.state === 'fail').length
  const missing = rows.filter((r) => r.state === 'missing').length
  const judged = rows.filter((r) => r.state === 'pass' || r.state === 'fail')
  // 首屏只列有结论的那几行：演示模式下不拿「未采集」补位凑行数（06d 第 3.1 节
  // 「判定卡，只留有结论的几行」）；全表进放大态。
  const list = full
    ? rows
    : demo
      ? judged.slice(0, 3)
      : [...judged, ...rows.filter((r) => r.state === 'missing')].slice(0, 3)

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

  // 本轮正在跑时判定还没出，摆一条进度而不是摆上一轮的结论
  if (runPhase === 'running')
    return (
      <div className="flex h-full min-h-0 w-full flex-col justify-center gap-2.5 px-1">
        <div className="flex items-baseline gap-2">
          <span className="num text-[26px] leading-none font-semibold text-t1">{runProgress}%</span>
          <span className="text-[12px] text-t3">运行中 · 判定待出</span>
        </div>
        <div className="h-[6px] overflow-hidden rounded-full bg-p100">
          <div
            className="h-full rounded-full bg-p600 transition-[width] duration-200"
            style={{ width: `${runProgress}%` }}
          />
        </div>
        <p className="text-[12px] leading-5 text-t3">本轮回放已登记时序，跑完即按判据求值。</p>
      </div>
    )

  const tip = `已求值 ${judged.length} / ${pack.requirements.evaluable_count} 条可求值判据，全表 ${rows.length} 条：通过 ${pass}、不通过 ${fail}、未采集 ${missing}。${
    measureOrigin(pack) ?? ''
  }${
    judged.length === 0
      ? '本轮一条都判不了：判据要的现场实测量（母线电流、转速、力、位移、声压级）得由台架传感器现场采，本轮只回放了一条曲线，不拿别的数顶替。'
      : ''
  }`

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* 演示模式把三个 26px 大数字收成一行：首屏只需要「判出几条、其中几条不通过」，
          分项计数进 tooltip（06d 第 3.1 节与 06b 第 3 节密度规则） */}
      <div className={cn('flex shrink-0 gap-2 pb-2', demo && !full ? 'items-center' : 'items-start')}>
        {demo && !full ? (
          <Tooltip className="min-w-0 flex-1" content={tip}>
            <span className="flex cursor-help items-baseline gap-1.5">
              <span className={cn('num text-[26px] leading-none font-semibold tracking-tight', fail > 0 ? 'text-alert' : 'text-t1')}>
                {fail}
              </span>
              <span className="text-[12px] text-t3">条不通过 · 已判 {judged.length}</span>
            </span>
          </Tooltip>
        ) : (
          <>
            <Stat n={pass} label="通过" tone="ok" />
            <Stat n={fail} label="不通过" tone="bad" />
            <Stat n={missing} label="未采集" tone="mute" />
          </>
        )}
        <InfoTip content={tip} />
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
        }}
      >
        {list.map((r) => {
          // 未达标的行点得动：带着判据 id 进流程 4，那边直接定位到这一条。
          // 别的行不可点——没有结论可跟进的行给点击反馈是假的。
          const jump = r.state === 'fail'
          const row = (
            <div
              className={cn(
                'flex w-full items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0',
                jump && 'rounded-tpx transition-colors hover:bg-alert-wash/60',
              )}
            >
              <StatusDot status={r.state === 'pass' ? 'done' : r.state === 'fail' ? 'alert' : 'na'} />
              <span className="truncate text-[12.5px] text-t1">{short(r.req.name, 12)}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">{STATE_LABEL[r.state]}</span>
              {jump ? <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-alert" /> : null}
            </div>
          )
          return (
            <Tooltip
              key={r.req.id}
              className="w-full"
              content={`${r.req.criterion_text}${r.note ? ` · ${r.note}` : r.missing.length ? ` · 缺 ${r.missing.join('、')}` : ''}${jump ? ' · 点此进流程 4 看推荐' : ''}`}
            >
              {jump ? (
                <button
                  type="button"
                  data-testid="verdict-fail-row"
                  aria-label={`${r.req.name} 未达标，进流程 4`}
                  className="w-full text-left"
                  onClick={() => {
                    setFocusReq(r.req.id)
                    nav('/tune')
                  }}
                >
                  {row}
                </button>
              ) : (
                row
              )}
            </Tooltip>
          )
        })}
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

/* ------------------------------------------------------------ 卡片 · 台架实况

   第三轮撤掉「单机设备会话」这张独立卡（《第三轮需求变更方案 v0.1》第 2.3 节第 4 条），
   本页原来那份 BENCH 设备记录与 src/features/remote/device.ts 的 BENCH_DEVICE
   是同一台机器（峰岹电机测试 Windows 工控机 SK-20251218QPBB）的两份逐字拷贝，
   收尾轮合并成一份、留 device.ts 那份。设备现在只以画板上的 MCP 节点出现，
   节点体在 src/features/remote/DeviceMcpNode.tsx。 */

/* ---------------------------------------------------------- 卡片 · 执行进度（备） */

function Progress({ full }: { full?: boolean }) {
  const pack = getPack()
  const waves = useWaves()
  const demo = useAppStore((s) => s.demoMode)
  const runPhase = useAppStore((s) => s.runPhase)
  const runProgress = useAppStore((s) => s.runProgress)
  const runRound = useAppStore((s) => s.runRound)
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
        {demo && !full ? null : <span className="num text-[13px] text-t3">/ {total}</span>}
        <Tooltip content={`${hasBatch ? '已标注' : '已回放'} ${done} / ${total}。${log.join('　')}`}>
          <span className="ml-auto cursor-help text-[12px] text-t3">
            {hasBatch ? `已标注 / ${total}` : `已回放 / ${total}`}
          </span>
        </Tooltip>
      </div>
      {/* 本轮运行态：待启动 / 运行中 / 已出判定 / 已停止 / 已急停，由顶栏那颗
          「启动测试」经红线确认卡驱动，不是自己跑起来的 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge tone={runPhase === 'estopped' ? 'warn' : runPhase === 'running' ? 'soft' : 'neutral'} dot>
          {RUN_PHASE_LABEL[runPhase]}
        </Badge>
        <span className="num text-[12px] text-t3" data-testid="run-phase">
          {runPhase === 'running' ? `${runProgress}%` : runRound > 0 ? `本会话第 ${runRound} 轮` : '本会话未启动'}
        </span>
      </div>
      <div className="h-[6px] shrink-0 overflow-hidden rounded-full bg-p100">
        <div
          className="h-full rounded-full bg-p600 transition-[width] duration-500"
          style={{ width: `${runPhase === 'running' ? runProgress : Math.round((done / (total || 1)) * 100)}%` }}
        />
      </div>
      <div className="mono min-h-0 flex-1 overflow-y-auto text-[11px] leading-[18px] text-t3">
        {/* 演示模式首屏不铺日志行，只留进度条与计数，全量日志进放大态
            （06d 第 3.1 节：执行进度日志折叠到二级） */}
        {(full ? log : demo ? [] : log.slice(-3)).map((l) => (
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
  progress: Progress,
}
