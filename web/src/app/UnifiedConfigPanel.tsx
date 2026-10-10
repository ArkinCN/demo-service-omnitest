import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import type { BuiltTier, Flags } from '../features/shared/tiers'
import type { FlowId } from '../data/types'
import { useAppStore } from '../state/useAppStore'

const SEARCH_FIELDS = new Set(['name', 'key', 'id', 'title', 'label', 'value', 'unit', 'group', 'g', 'criterion_text', 'file', 'locator', 'note', '_status', 'a', 'p', 'i', 'f', 'req', 'param', '_source', 'options'])

/** Search human labels and source values, never metadata property names. */
function searchableValues(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(searchableValues).join(' ')
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => SEARCH_FIELDS.has(key)).map(([, item]) => searchableValues(item)).join(' ')
  return ''
}

/** Presentation only: source items and editing callbacks stay with their flow. */
export function UnifiedConfigPanel<T>({
  tiers, itemKey, render, flags, tierIcon, tierRight,
}: {
  tiers: BuiltTier<T>[]
  itemKey: (item: T) => string
  render: (item: T) => ReactNode
  flags?: (item: T) => Flags
  tierIcon?: (title: string) => ReactNode
  flow?: FlowId
  groupIcon?: (title: string) => ReactNode
  lockTier?: (tier: BuiltTier<T>) => boolean
  defaultOpen?: number
  tierRight?: (tier: BuiltTier<T>) => ReactNode
}) {
  const sceneId = useAppStore((state) => state.sceneId)
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const categoryIds = tiers.map((tier) => tier.id).join('|')
  useEffect(() => { setCategory('all'); setQuery('') }, [categoryIds, sceneId])
  const groups = useMemo(() => tiers.flatMap((tier) => tier.groups.map((group) => ({ tier, group }))), [tiers])
  const total = groups.reduce((count, { group }) => count + group.items.length, 0)
  const needle = query.trim().toLocaleLowerCase()
  const shown = groups.filter(({ tier }) => category === 'all' || category === tier.id).map(({ tier, group }) => ({
    tier, group,
    items: group.items.filter((item) => !needle || `${tier.title} ${group.title} ${searchableValues(item)}`.toLocaleLowerCase().includes(needle)),
  })).filter(({ items }) => items.length)
  const shownCount = shown.reduce((count, { items }) => count + items.length, 0)
  return <section className="unified-config" aria-label="完整配置分类与字段">
    <div className="unified-config-search">
      <Search size={15} aria-hidden="true" />
      <input aria-label="搜索完整配置" placeholder="搜索名称、参数或来源" value={query} onChange={(event) => setQuery(event.target.value)} />
      {query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button> : null}
      <span>{shownCount}/{total}</span>
    </div>
    <nav className="unified-config-tabs" aria-label="配置分类">
      <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部 <small>{total}</small></button>
      {tiers.map((tier) => <div key={tier.id} className="unified-config-tab"><button type="button" aria-pressed={category === tier.id} onClick={() => setCategory(tier.id)}>{tierIcon?.(tier.title)}{tier.title}<small>{tier.count}</small></button>{tierRight?.(tier)}</div>)}
    </nav>
    <div className="unified-config-groups">
      {shown.map(({ tier, group, items }) => <section key={`${tier.id}/${group.id}`} className="unified-config-group">
        <header><div><span>{tier.title}</span><h3>{group.title}</h3></div><small>{items.length} 项</small></header>
        <div className="unified-config-fields">{items.map((item) => {
          const state = flags?.(item)
          return <div key={itemKey(item)} className="unified-config-field" data-pending={state?.pending || undefined} data-alert={state?.alert || undefined}>{render(item)}</div>
        })}</div>
      </section>)}
      {!shown.length ? <div className="unified-config-empty"><strong>没有匹配的配置</strong><span>尝试其他名称，或清除筛选查看全部字段。</span><button type="button" onClick={() => { setCategory('all'); setQuery('') }}>显示全部配置</button></div> : null}
    </div>
  </section>
}
