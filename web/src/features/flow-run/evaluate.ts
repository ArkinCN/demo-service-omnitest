import type { RawPack, RawRequirement } from '../scene/pack'
import type { Wave } from '../waveforms'

/* ===========================================================================
   判据求值。

   test-requirements.json 给了四样东西，判定卡因此可以真求值而不是写死：
   - `evaluable`  这条判据的表达式能不能自动求值；false 的只登记、不判
   - `criterion`  JavaScript 表达式（criterion_syntax 字段声明），求值结果为布尔
   - `criterion_text` 人读版本
   - `variables`  每个自由变量的来源，四种：
       runtime.measure     现场实测量，必须真采到，采不到就判「未采集」
       threshold           本条自己的 threshold 字段
       control-parameters  control-parameters.json 里按 key 取的当前配置值
       constant            编译期常量（故障位掩码一类），字面值写在变量自己身上

   规矩：凡是有 runtime.measure 变量拿不到的，一律判「未采集」并列出缺哪几个，
   不拿别的数顶替、不给结论。一条判据只要有一个量没采到，它就既不是通过也不是
   不通过——这条在调优流程里同样成立，未采集的项不进未达标清单、不进推荐。
   =========================================================================== */

export type VerdictState = 'pass' | 'fail' | 'missing' | 'manual'

export interface Evaluated {
  req: RawRequirement
  state: VerdictState
  /** 求值用到的量，用于卡面展示 */
  used: { name: string; value: number | boolean | string; unit?: string | null }[]
  /** 缺哪些现场实测量（中文名） */
  missing: string[]
  error?: string
}

type Scalar = number | boolean | string | (number | string)[]

/**
 * 本轮能提供的现场实测量。
 *
 * 只从真的采到的波形里取，采到什么给什么，一个都不推算：
 * 本轮只回放了主信号一条曲线，能给的就是它的峰值与稳态两项，而且只在判据要的
 * 物理量与波形的物理量对得上时才给。对不上的（例如判据要母线电流、波形是相电流）
 * 一律不给，让那条判据落到「未采集」，不拿相电流冒充母线电流。
 */
export function runtimeMeasures(waves: Wave[]): Record<string, number> {
  const w = waves.find((x) => x.verdict !== 'pass') ?? waves[0]
  if (!w) return {}
  // 波形的物理量写在 Wave.unit 上（由 datasets.json 的列定义推出），
  // 这里只登记「这条曲线本身是什么量」，判据要别的量时匹配不上就是缺。
  const out: Record<string, number> = {}
  if (w.unit === 'A') {
    out.phase_current_peak_a = Number(w.metrics.peak.toFixed(4))
    out.phase_current_steady_a = Number(w.metrics.steadyRms.toFixed(4))
  }
  return out
}

function toScalar(v: unknown): Scalar | undefined {
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'number' || typeof x === 'string'))
    return v as (number | string)[]
  return undefined
}

/** 变量取值：按 source 分派到四个来源，取不到返回 undefined */
function resolve(
  pack: RawPack,
  req: RawRequirement,
  name: string,
  v: { source: string; ref?: string; value?: unknown },
  measures: Record<string, number>,
): Scalar | undefined {
  switch (v.source) {
    case 'threshold':
      return toScalar((req.threshold as Record<string, unknown> | null)?.[name])
    case 'constant':
      return toScalar(v.value)
    case 'control-parameters': {
      // ref 形如 control-parameters.<key>
      const key = (v.ref ?? '').split('.').pop() ?? name
      const p = pack.controls.parameters.find((x) => x.key === key)
      return toScalar(p?.value)
    }
    default:
      return toScalar(measures[name])
  }
}

export function evaluateAll(pack: RawPack, measures: Record<string, number>): Evaluated[] {
  const legend = pack.requirements.runtime_measures ?? {}
  return pack.requirements.requirements.map<Evaluated>((req) => {
    if (req.evaluable === false || !req.criterion || !req.variables) {
      return { req, state: 'manual', used: [], missing: [] }
    }
    const scope: Record<string, Scalar> = {}
    const used: Evaluated['used'] = []
    const missing: string[] = []
    for (const [name, v] of Object.entries(req.variables)) {
      const value = resolve(pack, req, name, v, measures)
      if (value === undefined) {
        missing.push(legend[name]?.name ?? v.desc ?? name)
        continue
      }
      scope[name] = value
      // 阈值与常量不进「用到的量」展示位，那里只放实测与配置值，免得卡面全是阈值
      if (v.source !== 'threshold' && v.source !== 'constant')
        used.push({ name: v.desc ?? name, value: value as number | boolean | string, unit: v.unit })
    }
    if (missing.length) return { req, state: 'missing', used, missing }
    try {
      const names = Object.keys(scope)
      // criterion 来自本地场景包，不是用户输入；criterion_globals 只允许 Math 与字面量
      const fn = new Function('Math', ...names, `"use strict"; return (${req.criterion});`)
      const ok = Boolean(fn(Math, ...names.map((n) => scope[n])))
      return { req, state: ok ? 'pass' : 'fail', used, missing: [] }
    } catch (e) {
      return { req, state: 'missing', used, missing: [], error: String(e) }
    }
  })
}
