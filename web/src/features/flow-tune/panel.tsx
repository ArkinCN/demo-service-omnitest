import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  CircleDashed,
  FileCode2,
  GitCompareArrows,
  Layers,
  ListChecks,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Waves as WavesIcon,
} from 'lucide-react'
import {
  Badge,
  Collapsible,
  EmptyState,
  InfoTip,
  SourceTag,
  StatusDot,
  Tooltip,
  cn,
} from '../../components/ui'
import { getPack, sourceLine, type RawControlParam, type RawExperience } from '../scene/pack'
import { evaluateAll, runtimeMeasures, type Evaluated } from '../flow-run/evaluate'
import { ConfirmFooter, Empty } from '../shared/bits'
import { TimeSeriesChart } from '../timeseries'
import { POWERUP_ANNOTATION, currentThresholds, loadWaves, type Wave } from '../waveforms'

/* ===========================================================================
   流程 5 · 调优确认及运行（v2 视觉）

   左栏：未达标与推荐 —— 三个大数字 + 未达标项 + 推荐参数（当前 → 建议 + 采纳）
         + 候选队列口径 + 本轮将写回的宏
   卡片：波形对照（hero，PASS/FAIL 三条叠加）/ 候选队列 / 知识依据 / 判定卡 / 参数变更

   判据真求值的逻辑一条没改：未达标项仍由 flow-run/evaluate.ts 的 evaluateAll
   求出，criterion 判成 false 才算未达标；求不出值的单列「未采集」，既不算通过
   也不算不通过，不进推荐。
   =========================================================================== */

/** 标签一律收到 6 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/**
 * 参数宏的短名 ≤6 字。
 * 名字里带括号代号的（速度环 PID Ki（SKI））直接取代号，否则两条速度环参数截断后
 * 会撞成同一个「速度环 PI…」；没有代号的才按 6 字截断。全名与量程一律进 tooltip。
 */
function paramShort(p: RawControlParam) {
  const tag = /[（(]([A-Za-z0-9_]{2,6})[)）]\s*$/.exec(p.name)?.[1]
  if (tag) return tag
  return short(p.name)
}

function fmt(v: number | string | boolean) {
  if (typeof v === 'number') return String(Number(v.toPrecision(4)))
  if (typeof v === 'boolean') return v ? '真' : '假'
  return v
}

/* ------------------------------------------------- 采纳状态（跨左栏与卡片共享） */

const adopted = new Set<string>()
const adoptListeners = new Set<() => void>()
function toggleAdopt(key: string) {
  if (adopted.has(key)) adopted.delete(key)
  else adopted.add(key)
  adoptListeners.forEach((l) => l())
}
function useAdopted() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((v) => v + 1)
    adoptListeners.add(l)
    return () => {
      adoptListeners.delete(l)
    }
  }, [])
  return adopted
}

/* ------------------------------------------------------------ 候选推荐（数据） */

export interface Candidate {
  exp: RawExperience
  param: RawControlParam
  current: number | string | boolean
  suggested: number | string
  delta: string
  /** 建议值相对当前值的方向，用于变化幅度徽标 */
  dir: 'up' | 'down' | 'none'
  rationale: string
}

/** 从经验条目的动作原文里读出调整方向与幅度；读不出就不给数，只给动作原文。 */
function deriveSuggestion(
  p: RawControlParam,
  action: string,
): { v: number | string; delta: string; dir: Candidate['dir'] } | null {
  if (typeof p.value !== 'number') return null
  const pct = /([上下])调\s*(\d+)\s*%/.exec(action)
  if (pct) {
    const up = pct[1] === '上'
    const k = up ? 1 + Number(pct[2]) / 100 : 1 - Number(pct[2]) / 100
    return {
      v: Number((p.value * k).toPrecision(4)),
      delta: `${up ? '+' : '−'}${pct[2]}%`,
      dir: up ? 'up' : 'down',
    }
  }
  const abs = /上调\s*([\d.]+)\s*~\s*([\d.]+)\s*A/.exec(action)
  if (abs)
    return {
      v: Number((p.value + Number(abs[2])).toFixed(3)),
      delta: `+${abs[2]} ${p.unit ?? ''}`.trim(),
      dir: 'up',
    }
  const pm = /±\s*(\d+)\s*%/.exec(action)
  if (pm)
    return { v: Number((p.value * (1 + Number(pm[1]) / 100)).toPrecision(4)), delta: `±${pm[1]}%`, dir: 'up' }
  if (/加大|延长|提高/.test(action))
    return { v: Number((p.value * 1.2).toPrecision(4)), delta: '+20%', dir: 'up' }
  return null
}

export function useCandidates(): Candidate[] {
  const pack = getPack()
  return useMemo(() => {
    if (!pack) return []
    const byMacro = new Map<string, RawControlParam>()
    for (const p of pack.controls.parameters) byMacro.set(p.key.toUpperCase(), p)
    const out: Candidate[] = []
    for (const e of pack.experience.experiences) {
      if (!e.tags.flow?.startsWith('F5')) continue
      for (const m of e.tags.parameters ?? []) {
        const p = byMacro.get(m.toUpperCase())
        if (!p || out.some((c) => c.param.key === p.key)) continue
        const s = deriveSuggestion(p, e.action)
        out.push({
          exp: e,
          param: p,
          current: p.value ?? '—',
          suggested: s?.v ?? '人工判定',
          delta: s?.delta ?? '未给数',
          dir: s?.dir ?? 'none',
          rationale: e.action,
        })
      }
    }
    // 给得出具体数值的排前面，只有动作原文的排后面——队列靠前的才是能直接采纳的
    return out.sort((a, b) => Number(typeof b.suggested === 'number') - Number(typeof a.suggested === 'number'))
  }, [pack])
}

/** 经验条目的证据级 → 三档序位（只是排序口径，不是概率） */
const EVIDENCE_RANK: Record<string, number> = {
  台架实测数据: 3,
  台架经验: 2,
  判定工具输出: 2,
  规程条款: 1,
}
const rankOf = (e: RawExperience) => EVIDENCE_RANK[e.evidence_level] ?? 1

/* --------------------------------------------------------------- 判定（数据） */

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

interface Shortfalls {
  waves: Wave[]
  rows: Evaluated[]
  failed: Evaluated[]
  missing: Evaluated[]
  passed: Evaluated[]
}

function useShortfalls(): Shortfalls {
  const pack = getPack()
  const waves = useWaves()
  const rows = useMemo(() => (pack ? evaluateAll(pack, runtimeMeasures(waves)) : []), [pack, waves])
  return {
    waves,
    rows,
    failed: rows.filter((r) => r.state === 'fail'),
    missing: rows.filter((r) => r.state === 'missing'),
    passed: rows.filter((r) => r.state === 'pass'),
  }
}

/** 卡体高度随视口缩放，图表高度跟着量出来（与样板页同一套做法） */
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

/* ------------------------------------------------------------------ 左栏 */

function Stat({
  n,
  label,
  tone,
  hint,
}: {
  n: number
  label: string
  tone: 'bad' | 'ok' | 'mute'
  hint: string
}) {
  return (
    <Tooltip className="min-w-0 flex-1" content={hint}>
      <span className="flex min-w-0 cursor-help flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'h-[7px] w-[7px] shrink-0 rounded-full',
              tone === 'ok' ? 'bg-p600' : tone === 'bad' ? 'bg-alert' : 'bg-t3/40',
            )}
          />
          <span className="truncate text-[12px] font-medium text-t3">{label}</span>
        </span>
        <span
          className={cn(
            'num text-[26px] leading-none font-semibold tracking-tight',
            tone === 'bad' && n > 0 ? 'text-alert' : 'text-t1',
          )}
        >
          {n}
        </span>
      </span>
    </Tooltip>
  )
}

/** 变化幅度小徽标：方向靠图标，不靠颜色，避免多一处状态色 */
function DeltaTag({ c }: { c: Candidate }) {
  const Icon = c.dir === 'down' ? TrendingDown : c.dir === 'up' ? TrendingUp : CircleDashed
  return (
    <span className="num inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full border border-p200 bg-p50 px-1.5 text-[12px] leading-none font-medium text-p700">
      <Icon size={12} strokeWidth={2} className="block" />
      {c.delta}
    </span>
  )
}

function RecRow({ c }: { c: Candidate }) {
  const on = useAdopted().has(c.param.key)
  const tip = (
    <span className="block space-y-1">
      <span className="block font-medium">{c.param.name}</span>
      <span className="num block opacity-75">
        {c.param.key.toUpperCase()}
        {c.param.min !== null ? ` · ${c.param.min}~${c.param.max}` : ''}
        {c.param.value_shell ? ` · 外壳 ${c.param.value_shell}` : ''}
      </span>
      <span className="block opacity-75">
        {c.exp.id} · {c.rationale}
      </span>
      <span className="block opacity-75">{sourceLine(c.exp._source)}</span>
    </span>
  )
  return (
    <div
      className={cn(
        'flex min-h-[44px] items-center gap-2 px-4 py-1.5 transition-colors',
        on ? 'bg-p50/70' : 'hover:bg-p50/50',
      )}
    >
      <Tooltip className="min-w-0 flex-1" content={tip}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <SourceTag source={rankOf(c.exp) >= 3 ? '文档' : '建议'} title={c.exp.evidence_level} />
            <span className="cursor-help truncate text-[13px] font-medium text-t1">
              {paramShort(c.param)}
            </span>
          </span>
          <span className="num flex items-center gap-1.5 text-[15px] leading-none font-semibold text-t1">
            <span className="text-t3">{fmt(c.current)}</span>
            <ArrowRight size={12} strokeWidth={2} className="shrink-0 text-p400" />
            <span className="text-p700">{fmt(c.suggested)}</span>
            {c.param.unit && typeof c.suggested === 'number' ? (
              <span className="text-[12px] font-normal text-t3">{c.param.unit}</span>
            ) : null}
          </span>
        </span>
      </Tooltip>
      <DeltaTag c={c} />
      <Tooltip content={on ? '取消采纳' : '采纳这一项，写回仍要人点底部按钮'}>
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-label={`采纳 ${c.param.name}`}
          onClick={() => toggleAdopt(c.param.key)}
          className={cn(
            'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border transition-colors [&>svg]:block',
            on ? 'border-transparent bg-p600 text-white' : 'border-line bg-white text-transparent hover:border-p300',
          )}
        >
          <Check size={13} strokeWidth={2.6} />
        </button>
      </Tooltip>
    </div>
  )
}

export function TuneLeftPanel() {
  const pack = getPack()
  const cands = useCandidates()
  const picked = useAdopted()
  const { failed, missing, passed, rows } = useShortfalls()

  if (!pack) return <Empty text="场景包未加载" />

  const takenList = cands.filter((c) => picked.has(c.param.key))

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <Target size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">未达标与推荐</h2>
        <span className="num ml-auto text-[12px] text-t3">{rows.length}</span>
        <InfoTip
          content={`判定沿用流程 4 的同一套求值：判据表 ${rows.length} 条里，criterion 真判成 false 的才算未达标；缺现场实测量而求不出值的单列「未采集」，既不算通过也不算不通过，也不进调优推荐。`}
        />
      </header>

      <div className="fade-b min-h-0 flex-1 overflow-y-auto pb-2">
        {/* 三个大数字 */}
        <div className="px-4 pt-3 pb-1">
          <div className="surface-2 flex items-start gap-3 px-3 py-3">
            <Stat n={failed.length} label="未达标" tone="bad" hint="criterion 判成 false 的判据条数" />
            <Stat n={passed.length} label="已通过" tone="ok" hint="criterion 判成 true 的判据条数" />
            <Stat
              n={missing.length}
              label="未采集"
              tone="mute"
              hint="缺现场实测量，本轮求不出值，不算通过也不算不通过"
            />
          </div>
        </div>

        {/* 未达标项 */}
        <Collapsible
          icon={<ListChecks size={14} strokeWidth={1.9} />}
          title="未达标项"
          right={<span className="num text-[12px] text-t3">{failed.length}</span>}
        >
          {failed.length === 0 ? (
            <div className="px-4 py-3">
              <EmptyState
                icon={<Check size={24} strokeWidth={1.6} />}
                title="本轮无不通过项"
                hint={`未采集 ${missing.length} 条，采到再判。`}
              />
            </div>
          ) : (
            failed.map((r) => (
              <Tooltip
                key={r.req.id}
                className="w-full"
                content={`${r.req.id} ${r.req.name} · 要求 ${r.req.criterion_text}`}
              >
                <div className="flex min-h-[40px] w-full items-center gap-2 px-4 py-1.5">
                  <StatusDot status="alert" />
                  <span className="cursor-help truncate text-[13px] font-medium text-t1">
                    {short(r.req.name, 10)}
                  </span>
                  <span className="num ml-auto shrink-0 text-[12px] text-t3">{r.req.id}</span>
                </div>
              </Tooltip>
            ))
          )}
        </Collapsible>

        {/* 推荐参数 */}
        <Collapsible
          icon={<Sparkles size={14} strokeWidth={1.9} />}
          title="推荐参数"
          right={<span className="num text-[12px] text-t3">{cands.length}</span>}
        >
          {cands.length === 0 ? (
            <div className="px-4 py-3">
              <EmptyState icon={<Sparkles size={24} strokeWidth={1.6} />} title="经验库无可对上的项" />
            </div>
          ) : (
            cands.map((c) => <RecRow key={c.param.key} c={c} />)
          )}
        </Collapsible>

        {/* 未采集 */}
        <Collapsible
          icon={<CircleDashed size={14} strokeWidth={1.9} />}
          title="未采集"
          right={<span className="num text-[12px] text-t3">{missing.length}</span>}
        >
          {missing.slice(0, 10).map((r) => (
            <Tooltip
              key={r.req.id}
              className="w-full"
              content={`${r.req.id} ${r.req.name} · 缺 ${r.missing.join('、')}`}
            >
              <div className="flex min-h-[36px] w-full items-center gap-2 px-4 py-1">
                <StatusDot status="na" />
                <span className="cursor-help truncate text-[13px] text-t2">{short(r.req.name, 10)}</span>
                <span className="num ml-auto shrink-0 text-[12px] text-t3">缺 {r.missing.length}</span>
              </div>
            </Tooltip>
          ))}
        </Collapsible>
      </div>

      {/* 底部悬浮：本轮将写回的宏 + 主按钮 */}
      <footer className="shrink-0 border-t border-line-soft bg-white/85 px-4 py-3 backdrop-blur">
        {takenList.length ? (
          <ul className="mb-2.5 space-y-1">
            {takenList.slice(0, 3).map((c) => (
              <li key={c.param.key} className="flex items-center gap-2">
                <FileCode2 size={13} strokeWidth={1.9} className="shrink-0 text-p600" />
                <span className="num truncate text-[12px] text-t2">{c.param.key.toUpperCase()}</span>
                <span className="num ml-auto shrink-0 text-[12px] text-t1">
                  {fmt(c.current)} <span className="text-t3">→</span>{' '}
                  <span className="font-semibold text-p700">{fmt(c.suggested)}</span>
                </span>
              </li>
            ))}
            {takenList.length > 3 ? (
              <li className="num text-right text-[12px] text-t3">另 {takenList.length - 3} 项</li>
            ) : null}
          </ul>
        ) : null}
      </footer>
      <ConfirmFooter
        label="确认采纳"
        count={takenList.length}
        unit="项"
        hint={
          takenList.length
            ? '写回只改数值外壳括号内的数字，不换外壳、不动行尾注释。'
            : '先在推荐参数里勾选要采纳的项。'
        }
      />
    </div>
  )
}

/* -------------------------------------------------- 卡片 · 波形对照（hero） */

function WaveOverlay({ full }: { full?: boolean }) {
  const pack = getPack()
  const waves = useWaves()
  const [box, boxH] = useBoxHeight()
  if (!waves.length)
    return <EmptyState icon={<WavesIcon size={24} strokeWidth={1.5} />} title="读取时序" />
  const peak = Math.max(...waves.map((w) => w.metrics.peak))
  const unit = waves[0].unit

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-1.5">
        {waves.map((w) => (
          <Tooltip
            key={w.id}
            content={`${w.title} · ${w.verdictText} · 峰值 ${w.metrics.peak.toFixed(2)} ${w.unit} @ ${w.metrics.peakAt.toFixed(2)} s`}
          >
            <span
              className={cn(
                'num inline-flex h-[22px] cursor-help items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium',
                w.verdict === 'fail'
                  ? 'border-line bg-white text-t2'
                  : 'border-p200 bg-p50 text-p700',
              )}
            >
              <span
                className="h-[3px] w-[12px] shrink-0 rounded-full"
                style={{ background: w.series.color }}
              />
              {w.id}
            </span>
          </Tooltip>
        ))}
        {pack?.caps.syntheticData ? (
          <Badge tone="warn" title={pack.caps.syntheticBanner}>
            合成
          </Badge>
        ) : null}
        <span className="num ml-auto text-[12px] text-t3">
          Δ峰值 {(peak - Math.min(...waves.map((w) => w.metrics.peak))).toFixed(2)} {unit}
        </span>
      </div>
      <div ref={box} className="min-h-0 flex-1">
        <TimeSeriesChart
          series={waves.map((w) => w.series)}
          annotations={[POWERUP_ANNOTATION]}
          thresholds={currentThresholds(full, peak)}
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

/* ---------------------------------------------------------- 卡片 · 候选队列 */

/** 盲试候选的槽位上限：auto-startup-tune 规程写死 10 个固定候选，耗尽即转人工。 */
const QUEUE_CAP = 10

function CandidateQueue({ full }: { full?: boolean }) {
  const cands = useCandidates()
  const picked = useAdopted()
  if (!cands.length) return <EmptyState icon={<Layers size={24} strokeWidth={1.5} />} title="无候选" />
  const cur = cands.findIndex((c) => !picked.has(c.param.key))
  // 放大态逐个铺满 10 个槽位；卡内空间有限，只铺命中的候选，空槽压成一行，
  // 免得把半行硬切在卡底
  const free = Math.max(0, QUEUE_CAP - cands.length)
  const slots = Array.from({ length: full ? QUEUE_CAP : cands.length })

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        <ol className="relative">
          {/* 竖向连线：把 10 个槽位串成一条推进路径 */}
          <span className="absolute top-1.5 bottom-1.5 left-[6px] w-px bg-line-soft" aria-hidden />
          {slots.map((_, i) => {
            const c = cands[i]
            const on = c ? picked.has(c.param.key) : false
            const isCur = i === cur
            return (
              <li key={i} className="relative flex items-center gap-2.5 py-[2px] pl-0">
                <span
                  className={cn(
                    'relative z-10 flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border-2 bg-surface transition-colors',
                    on
                      ? 'border-p600 bg-p600'
                      : isCur
                        ? 'border-p600'
                        : c
                          ? 'border-line'
                          : 'border-dashed border-line',
                  )}
                >
                  {isCur ? <span className="h-[5px] w-[5px] rounded-full bg-p600" /> : null}
                </span>
                {c ? (
                  <Tooltip
                    className="min-w-0 flex-1"
                    content={`${c.param.name}（${c.param.key.toUpperCase()}） · ${c.exp.id} ${c.rationale}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'cursor-help truncate text-[13px]',
                          on ? 'font-medium text-t1' : isCur ? 'font-medium text-p700' : 'text-t2',
                        )}
                      >
                        {paramShort(c.param)}
                      </span>
                      <span className="num ml-auto shrink-0 text-[12px] text-t3">{c.delta}</span>
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-[13px] text-t3">空位</span>
                )}
              </li>
            )
          })}
          {!full && free ? (
            <li className="relative flex items-center gap-2.5 py-[2px]">
              <span className="relative z-10 h-[13px] w-[13px] shrink-0 rounded-full border-2 border-dashed border-line bg-surface" />
              <span className="text-[13px] text-t3">空位</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">{free}</span>
            </li>
          ) : null}
        </ol>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line-soft pt-1.5">
        <span className="num text-[12px] text-t3">
          {cands.length}
          <span className="text-t3">/{QUEUE_CAP}</span>
        </span>
        <span className="text-[12px] text-t3">上限 10 · 耗尽转人工</span>
        <InfoTip
          content="固定候选表出自客户端规程 auto-startup-tune（AItior 安装目录 resources/data/dc-skills/auto-startup-tune/SKILL.md，「## 固定候选」小节）：盲试最多 10 个候选，每个候选只偏离基线一个轴；跑完仍不行判 need_human 转人工，不得创建第 11 个候选，也不得自行扩大搜索区间（经验条目 EXP-022）。表内三个宏名属吸尘器产品线，在本散热风扇工程里零命中，因此本包不做映射，槽位只按本场景匹配得出的候选填。"
        />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- 卡片 · 知识依据 */

/**
 * 现象收成关键词：经验条目的 symptom 写的是整句（「起转起来了，但切闭环瞬间掉速或失步」），
 * 卡面只留第一个短句并压到 8 字，整句与原因、动作、结果一律在 tooltip 里。
 */
function symptomKey(sym: string) {
  return short(sym.split(/[，,。；;：:]/)[0], 8)
}

function EvidencePanel({ full }: { full?: boolean }) {
  const cands = useCandidates()
  const picked = useAdopted()
  if (!cands.length) return <EmptyState icon={<BookOpen size={24} strokeWidth={1.5} />} title="无命中条目" />

  // 一条经验可能带出多个参数，这里按经验去重，只列命中的前 3 条
  const seen = new Set<string>()
  const hits = cands
    .filter((c) => (seen.has(c.exp.id) ? false : (seen.add(c.exp.id), true)))
    .slice(0, full ? 12 : 3)

  return (
    <div
      className="no-scrollbar flex h-full min-h-0 w-full flex-col gap-1.5 overflow-y-auto"
      style={{
        maskImage: 'linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%)',
      }}
    >
      {hits.map((c) => {
        const rank = rankOf(c.exp)
        const on = picked.has(c.param.key)
        return (
          <Tooltip
            key={c.exp.id}
            className="w-full"
            content={
              <span className="block space-y-1">
                <span className="block font-medium">
                  {c.exp.id} · {c.exp.symptom}
                </span>
                <span className="block opacity-80">原因 · {c.exp.cause}</span>
                <span className="block opacity-80">动作 · {c.rationale}</span>
                <span className="block opacity-80">结果 · {c.exp.result}</span>
                <span className="block opacity-70">{sourceLine(c.exp._source)}</span>
              </span>
            }
          >
            <div className="flex w-full shrink-0 cursor-help items-center gap-2.5 rounded-tps border border-line-soft px-2.5 py-1.5 transition-colors hover:border-p200 hover:bg-p50/60">
              <span
                className={cn(
                  'flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-tpx [&>svg]:block',
                  on ? 'bg-p700 text-white' : 'bg-p50 text-p700',
                )}
              >
                <BookOpen size={13} strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-t1">
                {symptomKey(c.exp.symptom)}
              </span>
              {/* 证据级三格条：序位口径，不是概率 */}
              <span className="flex shrink-0 items-center gap-[3px]" aria-label={c.exp.evidence_level}>
                {[1, 2, 3].map((k) => (
                  <span
                    key={k}
                    className={cn('h-[4px] w-[11px] rounded-full', k <= rank ? 'bg-p600' : 'bg-p100')}
                  />
                ))}
              </span>
              <Badge tone="neutral" mono className="shrink-0">
                {c.exp.id}
              </Badge>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 判定卡 */

function VerdictCard({ full }: { full?: boolean }) {
  const pack = getPack()
  const { rows, failed, missing, passed } = useShortfalls()
  if (!pack) return <Empty text="场景包未加载" />
  const judged = passed.length + failed.length
  const list = full ? rows : [...failed, ...passed, ...missing].slice(0, 5)

  // 环：可求值判据里已经判出结果的占比。左栏已经给过三个大数字，这里换成环 + 中心数，
  // 同一条信息不在一屏里用同一种形态说第二遍。
  const evaluable = pack.requirements.evaluable_count || 1
  const R = 24
  const C = 2 * Math.PI * R
  const ratio = Math.min(1, judged / evaluable)

  const Legend = ({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'bad' | 'mute' }) => (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full',
          tone === 'ok' ? 'bg-p600' : tone === 'bad' ? 'bg-alert' : 'bg-t3/40',
        )}
      />
      <span className="text-[12px] text-t3">{label}</span>
      <span className={cn('num ml-auto text-[13px] font-semibold', tone === 'bad' && n > 0 ? 'text-alert' : 'text-t1')}>
        {n}
      </span>
    </span>
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <span className="relative shrink-0">
          <svg width="62" height="62" viewBox="0 0 62 62">
            <circle cx="31" cy="31" r={R} fill="none" stroke="var(--p-100)" strokeWidth="6" />
            <circle
              cx="31"
              cy="31"
              r={R}
              fill="none"
              stroke="var(--p-600)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${C * ratio} ${C}`}
              transform="rotate(-90 31 31)"
              style={{ transition: 'stroke-dasharray .4s cubic-bezier(.22,.75,.3,1)' }}
            />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="num text-[20px] leading-none font-semibold text-t1">{judged}</span>
            <span className="num text-[12px] text-t3">/{evaluable}</span>
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Legend n={passed.length} label="通过" tone="ok" />
          <Legend n={failed.length} label="不通过" tone="bad" />
          <Legend n={missing.length} label="未采集" tone="mute" />
        </span>
        <InfoTip
          content={`已求值 ${judged} / ${pack.requirements.evaluable_count} 条可求值判据，全表 ${rows.length} 条。${
            judged === 0
              ? '本轮一条都判不了：判据要的现场实测量（母线电流、转速、力、位移、声压级）得由台架传感器现场采，本轮只回放了登记进包的曲线，不拿别的数顶替。'
              : ''
          }`}
        />
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        {list.map((r) => (
          <Tooltip
            key={r.req.id}
            className="w-full"
            content={`${r.req.id} ${r.req.name} · ${r.req.criterion_text}${
              r.missing.length ? ` · 缺 ${r.missing.join('、')}` : ''
            }`}
          >
            <div className="flex w-full items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0">
              <StatusDot status={r.state === 'pass' ? 'done' : r.state === 'fail' ? 'alert' : 'na'} />
              <span className="cursor-help truncate text-[12.5px] text-t1">{short(r.req.name, 12)}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">
                {r.state === 'pass' ? '通过' : r.state === 'fail' ? '不通过' : r.state === 'missing' ? '未采集' : '人工判'}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/** 缩略包络：小卡里不画坐标轴，只留曲线本身的形状与 t=0 的位置 */
function Spark({ w }: { w: Wave }) {
  const { x, y } = w.series
  const d = useMemo(() => {
    const N = 160
    const n = y.length
    if (!n) return { top: '', bottom: '', zero: 0 }
    let span = 0
    for (let i = 0; i < n; i += 1) span = Math.max(span, Math.abs(y[i]))
    span = span || 1
    const top: string[] = []
    const bot: string[] = []
    for (let b = 0; b < N; b += 1) {
      const s0 = Math.floor((b * n) / N)
      const s1 = Math.max(s0 + 1, Math.floor(((b + 1) * n) / N))
      let lo = Infinity
      let hi = -Infinity
      for (let i = s0; i < s1 && i < n; i += 1) {
        if (y[i] < lo) lo = y[i]
        if (y[i] > hi) hi = y[i]
      }
      if (!Number.isFinite(lo)) continue
      top.push(`${b},${20 - (hi / span) * 19}`)
      bot.push(`${b},${20 - (lo / span) * 19}`)
    }
    const t0 = x.length ? (-Number(x[0]) / (Number(x[x.length - 1]) - Number(x[0]))) * N : 0
    return { top: top.join(' '), bottom: bot.reverse().join(' '), zero: t0 }
  }, [x, y])

  return (
    <svg viewBox="0 0 160 40" preserveAspectRatio="none" className="h-full w-full" aria-label={`${w.id} 波形缩略`}>
      <line x1="0" y1="20" x2="160" y2="20" stroke="var(--tp-line)" strokeWidth="0.5" />
      <line
        x1={d.zero}
        y1="1"
        x2={d.zero}
        y2="39"
        stroke="var(--tp-line)"
        strokeWidth="0.6"
        strokeDasharray="2 2"
      />
      <polygon points={`${d.top} ${d.bottom}`} fill="var(--p-300)" opacity="0.55" />
      <polyline points={d.top} fill="none" stroke="var(--p-600)" strokeWidth="0.6" />
    </svg>
  )
}

/* ------------------------------------------------------------ 卡片 · 本轮波形 */

/**
 * 本轮那一条曲线的读数。
 * hero 已经把两轮叠在一起对照了，这张卡只盯本轮：取和判定同一条曲线
 * （evaluate 的 runtimeMeasures 也是这么挑的：优先非 PASS 的那条），
 * 给峰值、稳态 RMS、首次响应三个读数 + 一条不带坐标轴的缩略曲线。
 */
function RoundWave({ full }: { full?: boolean }) {
  const waves = useWaves()
  const [box, boxH] = useBoxHeight()
  if (!waves.length)
    return <EmptyState icon={<WavesIcon size={24} strokeWidth={1.5} />} title="读取时序" />
  const w = waves.find((x) => x.verdict !== 'pass') ?? waves[0]

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-baseline gap-2 pb-1">
        <span className="num text-[26px] leading-none font-semibold tracking-tight text-t1">
          {w.metrics.peak.toFixed(2)}
        </span>
        <span className="text-[12px] text-t3">{w.unit || '原始量'} 峰值</span>
        <Tooltip content={`${w.id} ${w.title} · ${w.verdictText} · 峰值出现在 ${w.metrics.peakAt.toFixed(2)} s`}>
          <span className="num ml-auto cursor-help text-[12px] text-t3">{w.id}</span>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-3 pb-1.5">
        <Tooltip content="末段 0.5 s 的均方根，代表稳态">
          <span className="num cursor-help text-[12px] text-t3">
            稳态 <span className="text-[13px] font-semibold text-t1">{w.metrics.steadyRms.toFixed(2)}</span>
          </span>
        </Tooltip>
        <Tooltip content="首次越过本条曲线量程 5% 的时刻">
          <span className="num cursor-help text-[12px] text-t3">
            首响{' '}
            <span className="text-[13px] font-semibold text-t1">
              {Number.isNaN(w.metrics.firstResponseMs) ? '—' : `${Math.round(w.metrics.firstResponseMs)} ms`}
            </span>
          </span>
        </Tooltip>
      </div>
      <div ref={box} className="min-h-0 flex-1">
        {full ? (
          <TimeSeriesChart
            series={[w.series]}
            annotations={[POWERUP_ANNOTATION]}
            thresholds={currentThresholds(true, w.metrics.peak)}
            height={Math.max(220, boxH - 6)}
            xLabel={`时间 s · 纵轴 ${w.unit || '原始量'}`}
          />
        ) : (
          <Spark w={w} />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 卡片 · 参数变更 */

/**
 * 本轮要写回固件的宏，逐行给「宏名 · 原值 → 新值」。
 * 取已勾选采纳的候选；一条都没勾时按队列顺序给前三条待采纳的，并在卡头标明是待采纳。
 * 写回口径：只改数值外壳里的那个数，量纲与括号写法照抄原值——这张卡显示的就是要改的那一行。
 */
function ParamChanges({ full }: { full?: boolean }) {
  const all = useCandidates()
  const picked = useAdopted()
  const numeric = all.filter((c) => typeof c.suggested === 'number')
  const chosen = numeric.filter((c) => picked.has(c.param.key))
  const rows = (chosen.length ? chosen : numeric).slice(0, full ? 10 : 3)
  const pending = chosen.length === 0

  if (!rows.length)
    return <EmptyState icon={<GitCompareArrows size={24} strokeWidth={1.5} />} title="无可写回的宏" />

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-1.5">
        <span className="num text-[26px] leading-none font-semibold tracking-tight text-t1">
          {chosen.length}
        </span>
        <span className="text-[12px] text-t3">项已采纳 / 候选 {numeric.length}</span>
        <Tooltip content="写回沿用原数值外壳与量纲，只改括号里的那个数；落盘与重编重烧一律由人点，助手不写回。">
          <span className="num ml-auto cursor-help text-[12px] text-t3">
            {pending ? '待采纳' : '待写回'}
          </span>
        </Tooltip>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {rows.map((c) => (
          <Tooltip
            key={c.param.key}
            className="w-full"
            content={`${c.param.name}（${c.param.key.toUpperCase()}）· 依据 ${c.exp.id} · ${c.rationale}`}
          >
            <div className="flex w-full cursor-help items-center gap-2 border-b border-line-soft py-[7px] last:border-b-0">
              <span
                className={cn(
                  'h-[7px] w-[7px] shrink-0 rounded-full',
                  picked.has(c.param.key) ? 'bg-p600' : 'bg-p200',
                )}
              />
              <span className="num min-w-0 flex-1 truncate text-[12.5px] font-medium text-t1">
                {c.param.key.toUpperCase()}
              </span>
              <span className="num shrink-0 text-[12px] text-t3">{fmt(c.current)}</span>
              <ArrowRight size={12} strokeWidth={2} className="shrink-0 text-t3" />
              <span className="num shrink-0 text-[13px] font-semibold text-t1">
                {fmt(c.suggested)}
                {c.param.unit ? (
                  <span className="ml-0.5 text-[12px] font-normal text-t3">{c.param.unit}</span>
                ) : null}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- 卡槽登记 */

export const tuneCards = {
  history: WaveOverlay,
  candidates: CandidateQueue,
  verdict: VerdictCard,
  evidence: EvidencePanel,
  timeseries: RoundWave,
  'param-changes': ParamChanges,
}
