/* ===========================================================================
   分层折叠树的骨架与取数（第三轮 B 区改版）· 纯函数，无组件

   骨架一律来自场景包 JSON 的 `group_tiers` 段，不写死在代码里——换行业换的是
   场景包的叶子与分组名，页面骨架不动（依据 06b 第 1.4 节的结论）。
   一级类 → 二级组 → 三级子组，最多三层；三层还装不下的改弹层，不再往下嵌。
   渲染组件 `TierTree` 在同目录的 bits.tsx。
   =========================================================================== */
import { useAppStore } from '../../state/useAppStore'

/** 三级子组：按条目 id 精确点名，不按数量硬切 */
export interface TierSubSpec {
  id: string
  title: string
  items: string[]
}

/** 二级组：`members` 按源数据自带的分组名收，`items` 按条目 id 收，二选一 */
export interface TierGroupSpec {
  id: string
  title: string
  members?: string[]
  items?: string[]
  subgroups?: TierSubSpec[]
}

/** 一级类 */
export interface TierSpec {
  id: string
  title: string
  groups: TierGroupSpec[]
}

export interface BuiltSub<T> {
  id: string
  title: string
  items: T[]
}
export interface BuiltGroup<T> {
  id: string
  title: string
  items: T[]
  subs: BuiltSub<T>[]
}
export interface BuiltTier<T> {
  id: string
  title: string
  groups: BuiltGroup<T>[]
  count: number
}

/** 从场景包某一段里读 `group_tiers`；没有这一段就返回空数组，调用方回落到旧版平铺 */
export function readTiers(section: unknown): TierSpec[] {
  const t = (section as { group_tiers?: unknown } | null | undefined)?.group_tiers
  return Array.isArray(t) ? (t as TierSpec[]) : []
}

/**
 * 按骨架把一批条目装进「一级类 → 二级组 → 三级子组」。
 * 骨架没点名的条目不丢，一律落到末尾的「其他」类，避免分类表漏一条就少一条数据。
 */
export function buildTiers<T>(
  spec: TierSpec[],
  all: T[],
  idOf: (t: T) => string,
  groupOf?: (t: T) => string,
): BuiltTier<T>[] {
  const used = new Set<string>()
  const out: BuiltTier<T>[] = []
  for (const tier of spec) {
    const groups: BuiltGroup<T>[] = []
    for (const g of tier.groups) {
      const members = new Set(g.members ?? [])
      const ids = new Set((g.items ?? []).map((x) => x.toLowerCase()))
      const items = all.filter((x) => {
        if (used.has(idOf(x))) return false
        const hit =
          (members.size > 0 && groupOf ? members.has(groupOf(x)) : false) ||
          (ids.size > 0 ? ids.has(idOf(x).toLowerCase()) : false)
        if (hit) used.add(idOf(x))
        return hit
      })
      if (!items.length) continue
      // 条目不超过 5 条的组不再往下切三级：平铺规则一的门槛就是 5 条，
      // 一条也要套三层只会多两次点击（按流程过滤之后常见）。
      if (items.length <= 5) {
        groups.push({ id: g.id, title: g.title, items, subs: [] })
        continue
      }
      const subs: BuiltSub<T>[] = []
      const taken = new Set<string>()
      for (const s of g.subgroups ?? []) {
        const want = new Set(s.items.map((x) => x.toLowerCase()))
        const xs = items.filter((x) => want.has(idOf(x).toLowerCase()))
        for (const x of xs) taken.add(idOf(x))
        if (xs.length) subs.push({ id: s.id, title: s.title, items: xs })
      }
      const rest = items.filter((x) => !taken.has(idOf(x)))
      if (subs.length && rest.length) subs.push({ id: `${g.id}-rest`, title: '其余', items: rest })
      groups.push({ id: g.id, title: g.title, items, subs })
    }
    if (groups.length)
      out.push({
        id: tier.id,
        title: tier.title,
        groups,
        count: groups.reduce((n, g) => n + g.items.length, 0),
      })
  }
  const left = all.filter((x) => !used.has(idOf(x)))
  if (left.length)
    out.push({
      id: 'rest',
      title: '其他',
      groups: [{ id: 'rest-all', title: '未归类', items: left, subs: [] }],
      count: left.length,
    })
  return out
}

/** 组头状态汇总：已填 n/m、异常 k、待核实 j */
export interface Flags {
  filled?: boolean
  alert?: boolean
  pending?: boolean
}

export function tally<T>(items: T[], f: (t: T) => Flags) {
  let done = 0
  let alert = 0
  let pending = 0
  for (const x of items) {
    const g = f(x)
    if (g.filled) done += 1
    if (g.alert) alert += 1
    if (g.pending) pending += 1
  }
  return { done, total: items.length, alert, pending }
}

/* ------------------------------------------------------------------ 演示模式 */

/**
 * 演示模式开关。真源在 store 的 `demoMode` 上（持久化 + `?mode=demo|full` 强制口）。
 * 2026-10-10：顶栏的「演示 / 全量」分段控件已按用户要求删除，此后**没有可见的
 * 切换入口**，取值就是持久化里的那一份；要改口径走 `?mode=full`（或再决定恒为全量）。
 * 全量模式下一切照旧：演示模式只过滤展示面，不删场景包里的任何数据。
 *
 * 本函数在渲染期被调用，读的是 store 快照而不是订阅；调用点落在由
 * `demoMode` 之外的状态驱动重渲的组件里。
 */
export function demoOn(): boolean {
  return useAppStore.getState().demoMode
}

/** 读场景包某一段的 `demo_profile.<key>` 列表；没登记就返回 null，调用方不过滤 */
export function demoList(section: unknown, key: string): string[] | null {
  const d = (section as { demo_profile?: Record<string, unknown> } | null | undefined)?.demo_profile
  const v = d?.[key]
  return Array.isArray(v) && v.length ? (v as string[]) : null
}

/** 演示模式下按 `demo_profile` 过滤；未开演示或没登记就原样返回 */
export function demoFilter<T>(section: unknown, key: string, items: T[], idOf: (t: T) => string): T[] {
  if (!demoOn()) return items
  const want = demoList(section, key)
  if (!want) return items
  const set = new Set(want.map((x) => x.toLowerCase()))
  const out = items.filter((x) => set.has(idOf(x).toLowerCase()))
  return out.length ? out : items
}
