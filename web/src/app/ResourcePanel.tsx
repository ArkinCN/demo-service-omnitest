import { useMemo, useState, createElement } from 'react'
import { LayoutGrid, Layers, Network } from 'lucide-react'
import { Button, Modal, Panel, PanelCard, PanelHeader, Segmented, cn } from '../components/ui'
import { CARD_LIB } from '../data/cards'
import type { CardId, CardInstance, FlowId, ScenePackage } from '../data/types'
import { getPanelCards, useRegistryVersion } from '../registry'
import { CARD_ICON } from './icons'
import { CardArt } from './CardArt'
import { ToolRail } from './ToolRail'

/** C 区 · 面板：一页只有一个 hero（首卡横跨两格），其余退后。 */

type View = 'grid' | 'canvas'

const cardIcon = (id: CardId, size = 13) =>
  createElement(CARD_ICON[id] ?? Layers, { size, strokeWidth: 1.9 })

function CanvasView({
  flow,
  scene,
  onExpand,
}: {
  flow: FlowId
  scene: ScenePackage
  onExpand: (c: CardInstance) => void
}) {
  const content = scene.flows[flow]
  const layout =
    content.canvas ??
    ({
      nodes: content.cards.map((c, i) => ({
        id: c.id,
        x: 48 + (i % 2) * 420,
        y: 32 + Math.floor(i / 2) * 224,
        w: 360,
        h: 192,
      })),
      links: [],
    } as NonNullable<ScenePackage['flows'][FlowId]['canvas']>)

  const byId = new Map(content.cards.map((c) => [c.id, c]))
  const center = (id: CardId) => {
    const n = layout.nodes.find((x) => x.id === id)
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: 0, y: 0 }
  }

  return (
    <div className="paper-grid relative min-h-0 flex-1 overflow-auto">
      <div className="relative h-[470px] w-[860px]">
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          {layout.links.map((l, i) => {
            const a = center(l.from)
            const b = center(l.to)
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
            return (
              <g key={i}>
                <path
                  d={`M${a.x} ${a.y} L${b.x} ${b.y}`}
                  stroke="var(--p-300)"
                  strokeWidth="1.25"
                  strokeDasharray={l.kind === 'belong' ? '6 5' : undefined}
                  fill="none"
                />
                {l.label ? (
                  <text
                    x={mid.x}
                    y={mid.y - 5}
                    textAnchor="middle"
                    fontSize="11"
                    fill="var(--tp-text-3)"
                    stroke="#fff"
                    strokeWidth="3"
                    paintOrder="stroke"
                  >
                    {l.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
        {layout.nodes.map((n) => {
          const inst = byId.get(n.id) ?? { id: n.id }
          return (
            <div key={n.id} className="absolute" style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
              <PanelCard
                className="h-full"
                icon={cardIcon(n.id)}
                title={CARD_LIB[n.id].title}
                alert={inst.alert}
                active={inst.active}
                onExpand={() => onExpand(inst)}
              >
                <CardArt id={n.id} />
              </PanelCard>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 五卡版式：首卡 hero 横跨两列，其余四张填满第二行与右上角 */
function slotStyle(i: number, n: number): React.CSSProperties {
  if (n >= 5) {
    if (i === 0) return { gridColumn: '1 / span 2', gridRow: '1' }
    if (i === 1) return { gridColumn: '3', gridRow: '1' }
    return { gridColumn: String(i - 1), gridRow: '2' }
  }
  if (n === 4) {
    if (i === 0) return { gridColumn: '1 / span 2', gridRow: '1' }
    if (i === 1) return { gridColumn: '3', gridRow: '1' }
    if (i === 2) return { gridColumn: '1 / span 2', gridRow: '2' }
    return { gridColumn: '3', gridRow: '2' }
  }
  if (n === 3) {
    if (i === 0) return { gridColumn: '1 / span 2', gridRow: '1 / span 2' }
    return { gridColumn: '3', gridRow: String(i) }
  }
  return {}
}

export function ResourcePanel({ flow, scene }: { flow: FlowId; scene: ScenePackage }) {
  useRegistryVersion()
  const [view, setView] = useState<View>('grid')
  const [open, setOpen] = useState<CardInstance | null>(null)

  const registered = useMemo(() => getPanelCards(flow), [flow])
  const regById = useMemo(() => new Map(registered.map((r) => [r.id, r])), [registered])
  const content = scene.flows[flow]

  const slots: CardInstance[] = useMemo(() => {
    const extra = registered
      .filter((r) => !content.cards.some((c) => c.id === r.id))
      .map((r) => ({ id: r.id as CardId }))
    return [...content.cards, ...extra]
  }, [content, registered])

  const GRID_SLOTS = 5
  const [swapped, setSwapped] = useState<Record<string, CardId>>({})
  const gridSlots = useMemo(() => {
    const base = slots.slice(0, GRID_SLOTS)
    return base.map((c) => {
      const to = swapped[c.id]
      return to ? (slots.find((x) => x.id === to) ?? c) : c
    })
  }, [slots, swapped])
  const shown = new Set(gridSlots.map((c) => c.id))
  const hidden = slots.filter((c) => !shown.has(c.id))
  const swap = (from: CardId, to: CardId) => setSwapped((m) => ({ ...m, [from]: to }))

  const renderCard = (id: CardId) => {
    const reg = regById.get(id)
    return reg ? reg.render({ flow, scene }) : <CardArt id={id} />
  }

  return (
    <Panel>
      <PanelHeader
        icon={<Layers size={17} strokeWidth={1.9} />}
        title="面板"
        right={
          <Segmented
            ariaLabel="面板视图"
            value={view}
            onChange={(v) => setView(v as View)}
            items={[
              { value: 'grid', label: '网格', icon: <LayoutGrid size={13} strokeWidth={1.9} /> },
              { value: 'canvas', label: '画布', icon: <Network size={13} strokeWidth={1.9} /> },
            ]}
          />
        }
      />

      <div className="flex min-h-0 flex-1">
        {view === 'grid' ? (
          <div
            className="min-h-0 flex-1 overflow-hidden"
            style={{ padding: 'clamp(12px, 1.05vw, 20px)' }}
          >
            <div
              key={flow}
              className="grid h-full"
              style={{
                gap: 'clamp(12px, 0.9vw, 16px)',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gridTemplateRows: '1.4fr 1fr',
              }}
            >
              {gridSlots.map((c, i) => (
                <PanelCard
                  key={c.id}
                  icon={cardIcon(c.id, i === 0 ? 14 : 13)}
                  title={c.title ?? CARD_LIB[c.id]?.title ?? regById.get(c.id)?.label ?? c.id}
                  stamp={c.stamp}
                  active={c.active}
                  hero={i === 0}
                  alert={c.alert}
                  style={{ ...slotStyle(i, gridSlots.length), animationDelay: `${i * 45}ms` }}
                  onExpand={() => setOpen(c)}
                  onSwap={hidden.length ? (id) => swap(c.id, id as CardId) : undefined}
                  swapOptions={hidden.map((h) => ({
                    value: h.id,
                    label: CARD_LIB[h.id]?.title ?? regById.get(h.id)?.label ?? h.id,
                  }))}
                >
                  {renderCard(c.id)}
                </PanelCard>
              ))}
            </div>
          </div>
        ) : (
          <CanvasView flow={flow} scene={scene} onExpand={setOpen} />
        )}
        <ToolRail groups={scene.toolGroups} />
      </div>

      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        width={1220}
        title={open ? (open.title ?? CARD_LIB[open.id]?.title ?? open.id) : ''}
        meta={open?.summary}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
              关闭
            </Button>
            <Button size="sm" variant="secondary">
              在新窗口打开
            </Button>
            <Button size="sm" variant="primary">
              固定到卡槽
            </Button>
          </>
        }
      >
        <div className={cn('flex h-[min(64vh,470px)] items-center justify-center rounded-tp2 bg-p50 p-2')}>
          {open ? (
            regById.get(open.id) ? (
              (regById.get(open.id)!.renderExpanded ?? regById.get(open.id)!.render)({ flow, scene })
            ) : (
              <div className="h-[min(56vh,400px)] w-[620px]">
                <CardArt id={open.id} />
              </div>
            )
          ) : null}
        </div>
      </Modal>
    </Panel>
  )
}
