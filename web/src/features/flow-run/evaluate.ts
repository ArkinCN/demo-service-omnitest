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
  /** 合取式里还有子句因缺量判不了，但已有子句为假，结论仍成立 */
  partial?: boolean
  /** 结论是怎么来的，逐字写在卡面 tooltip 上，不让观众自己猜 */
  note?: string
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
export function runtimeMeasures(waves: Wave[], pack?: RawPack): Record<string, number> {
  const out: Record<string, number> = {}

  // 批次统计量：datasets.json 的 package_stats 登记的是真实批次的标注结果
  // （散热风扇包 = 20260811 启动故障 98 次实验，101 次尝试、98 次已标注、
  //   67 次 PASS、30 次 FAIL、1 次作废，_source 指向那份分析报告）。
  // 这是已经采到并标注过的量，不是推算，所以可以进求值；没有登记这一段的
  // 场景包（例如合成的玻璃升降器包）一个数都不给，让判据落到「未采集」。
  const st = pack?.datasets.package_stats as Record<string, unknown> | undefined
  if (st && typeof st.pass === 'number' && typeof st.labeled === 'number') {
    out.pass_count = st.pass as number
  }

  const w = waves.find((x) => x.verdict !== 'pass') ?? waves[0]
  if (!w) return out
  // 波形的物理量写在 Wave.unit 上（由 datasets.json 的列定义推出），
  // 这里只登记「这条曲线本身是什么量」，判据要别的量时匹配不上就是缺。
  if (w.unit === 'A') {
    out.phase_current_peak_a = Number(w.metrics.peak.toFixed(4))
    out.phase_current_steady_a = Number(w.metrics.steadyRms.toFixed(4))
  }
  return out
}

/** 本轮实测量的出处，写在卡面上，避免观众把批次统计当成本轮现采 */
export function measureOrigin(pack: RawPack | null): string | null {
  const st = pack?.datasets.package_stats as Record<string, unknown> | undefined
  if (!st || typeof st.pass !== 'number') return null
  return `起停通过次数取自已标注批次：尝试 ${st.attempts_total} 次、已标注 ${st.labeled} 次、通过 ${st.pass} 次、失败 ${st.fail} 次，出自 datasets.json 的 package_stats（源为 20260811 启动故障 98 次实验分析报告）。这是既有批次的标注结果，不是本轮现场重采。`
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

/**
 * 把一条判据的顶层 `&&` 拆成子句；括号内部的 `&&` 不拆。
 *
 * 为什么要拆：判据多半是合取式。合取式里只要有一个子句已经判成假，整条就是假，
 * 剩下那几个子句缺不缺实测量都改不了这个结论（假 ∧ 未知 = 假）。这不是拿别的数
 * 顶替，也不是猜，是逻辑本身允许的短路。反过来，已算的子句全为真而还有子句缺量时，
 * 整条仍然判不了，照旧落「未采集」——真 ∧ 未知 = 未知。
 */
function clausesOf(expr: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (depth === 0 && ch === '&' && expr[i + 1] === '&') {
      out.push(buf)
      buf = ''
      i += 1
      continue
    }
    // 顶层出现 || 就不拆了：或式没有这条短路规则
    if (depth === 0 && ch === '|' && expr[i + 1] === '|') return [expr]
    buf += ch
  }
  out.push(buf)
  return out.map((x) => x.trim()).filter(Boolean)
}

/** 子句里用到了哪几个自由变量（只认这条判据 variables 段登记过的名字） */
function varsIn(clause: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(clause))
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
    const names = Object.keys(scope)
    // criterion 来自本地场景包，不是用户输入；criterion_globals 只允许 Math 与字面量
    const run = (expr: string) => {
      const fn = new Function('Math', ...names, `"use strict"; return (${expr});`)
      return Boolean(fn(Math, ...names.map((n) => scope[n])))
    }
    if (missing.length) {
      // 合取短路：缺量的判据里，凡是已经能算的子句算一遍；有一个为假就足以判不通过。
      const all = Object.keys(req.variables)
      try {
        for (const cl of clausesOf(req.criterion)) {
          const need = varsIn(cl, all)
          if (!need.length || need.some((n) => !(n in scope))) continue
          if (!run(cl)) {
            return {
              req,
              state: 'fail',
              used,
              missing,
              partial: true,
              note: `按已采到的量判：「${cl}」不成立，这一条就是不通过。还缺 ${missing.join('、')}，但合取式里已有一项为假，补齐也翻不过来。`,
            }
          }
        }
      } catch {
        /* 子句算不动就当没算，照旧落未采集，不编结论 */
      }
      return { req, state: 'missing', used, missing }
    }
    try {
      const ok = run(req.criterion)
      return { req, state: ok ? 'pass' : 'fail', used, missing: [] }
    } catch (e) {
      return { req, state: 'missing', used, missing: [], error: String(e) }
    }
  })
}
