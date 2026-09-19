import { createElement, useState } from 'react'
import {
  Activity,
  Camera,
  Cable,
  Fan,
  Gauge,
  Monitor,
  Plug,
  Radio,
  RefreshCw,
  Ruler,
  Terminal,
  Thermometer,
  Waves,
  Wind,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Drawer, StatusDot, Tooltip, cn } from '../components/ui'
import type { CanvasNodeType, ToolGroup, ToolItem } from '../data/types'
import { probeDevice } from '../features/remote'
import { CANVAS_DND_MIME, CANVAS_NODE_META, type CanvasDragPayload } from '../features/canvas'
import { TOOL_GROUP_ICON } from './icons'

/* ===========================================================================
   C 区右侧竖工具条 56px。

   第三轮改三件事（依据《第三轮实施计划 · 并行派工》W3 卡第 5 条）：
     1. 十四枚图标由无分组平铺改为按能力域分组，每组带组名与分隔线；
     2. 每枚工具块可拖进画板，落点即建节点，落点之外放手取消；
     3. 连接状态由右上角小圆点改为绿 / 红 / 灰三态描边，顶部单独放一枚刷新。
   组名在 56 宽里只放得下两字，全称进 tooltip——标签 ≤6 字的口径见 DESIGN.md 第 4 节。
   =========================================================================== */

/** 组名的两字短名。全称仍在 tooltip 里。 */
const GROUP_SHORT: Record<ToolGroup['id'], string> = {
  acquire: '采集',
  stimulus: '激励',
  device: '调试',
  session: '接入',
}

/** 组默认落成哪类画板节点 */
const GROUP_NODE: Record<ToolGroup['id'], CanvasNodeType> = {
  acquire: 'scope',
  stimulus: 'psu',
  device: 'device-mcp',
  session: 'device-mcp',
}

/** 工具名命中关键词时按工具本身定节点类型，命不中落回组默认 */
const NODE_BY_WORD: [RegExp, CanvasNodeType][] = [
  [/示波|波形|采样|采集/, 'scope'],
  [/电源|供电/, 'psu'],
  [/台架|工装|涵道|风/, 'bench'],
  [/终端|命令|远程|桌面|会话|网关/, 'device-mcp'],
  [/联锁|安全/, 'interlock'],
]

function nodeTypeOf(g: ToolGroup, t: ToolItem): CanvasNodeType {
  for (const [re, type] of NODE_BY_WORD) if (re.test(t.label)) return type
  return GROUP_NODE[g.id] ?? 'device-mcp'
}

/** 工具图标：按名称关键词取，取不到就退回本组图标 */
const BY_WORD: [RegExp, LucideIcon][] = [
  [/示波|波形|采样/, Waves],
  [/电流|电压|功率|电源/, Zap],
  [/转速|测速|频率/, Gauge],
  [/温|热/, Thermometer],
  [/风|涵道|逆风/, Fan],
  [/声|噪/, Radio],
  [/位移|尺寸|量/, Ruler],
  [/相机|截图|图像/, Camera],
  [/终端|命令|脚本/, Terminal],
  [/远程|桌面|主机|工控/, Monitor],
  [/接线|通道|接入/, Plug],
  [/网关|会话|连接/, Cable],
  [/采集|记录/, Activity],
]

/** 同组里图标不重样：命中关键词优先，重了就按组内序号从备选池取 */
const POOL: LucideIcon[] = [Activity, Gauge, Zap, Ruler, Plug, Camera, Radio, Thermometer]

function iconsOf(g: ToolGroup): LucideIcon[] {
  const used = new Set<LucideIcon>()
  return g.tools.map((t, i) => {
    let ic: LucideIcon | undefined
    for (const [re, cand] of BY_WORD) {
      if (re.test(t.label) && !used.has(cand)) {
        ic = cand
        break
      }
    }
    if (!ic) ic = POOL.find((c) => !used.has(c)) ?? POOL[i % POOL.length]
    used.add(ic)
    return ic
  })
}

/** 三态描边：绿已接入、暗红异常、灰未接入 */
const STATE_RING: Record<ToolItem['state'], string> = {
  online: 'border-p300 bg-p50 text-p700',
  fault: 'border-alert/60 bg-alert-wash text-alert',
  offline: 'border-line bg-white text-t2',
}

const STATE_TEXT: Record<ToolItem['state'], string> = {
  online: '已接入',
  fault: '异常',
  offline: '未接入',
}

export function ToolRail({ groups }: { groups: ToolGroup[] }) {
  const [active, setActive] = useState<{ tool: ToolItem; group: string } | null>(null)
  const [busy, setBusy] = useState(false)

  /** 重新枚举设备：探一次网关，探不通就维持原状，不假报在线 */
  const refresh = () => {
    setBusy(true)
    void probeDevice('bench')
      .catch(() => null)
      .finally(() => window.setTimeout(() => setBusy(false), 500))
  }

  return (
    <>
      <aside className="fade-tb no-scrollbar flex w-[56px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-l border-line-soft bg-p50/50 py-3">
        <Tooltip content="重新枚举设备">
          <button
            type="button"
            aria-label="刷新设备"
            onClick={refresh}
            className={cn(
              'flex h-[28px] w-[40px] items-center justify-center rounded-tps border border-line bg-white',
              'text-t2 transition-colors duration-150 hover:border-p300 hover:bg-p50 hover:text-p700 [&>svg]:block',
            )}
          >
            <RefreshCw size={14} strokeWidth={1.8} className={busy ? 'animate-spin' : undefined} />
          </button>
        </Tooltip>

        {groups.map((g, gi) => {
          const icons = iconsOf(g)
          return (
            <div
              key={g.id}
              className={cn(
                'flex w-full flex-col items-center gap-1.5 px-2',
                gi > 0 && 'border-t border-line-soft pt-3',
              )}
            >
              <Tooltip content={g.title}>
                <span className="mb-0.5 flex items-center justify-center gap-1 text-[12px] leading-none whitespace-nowrap text-t3">
                  {createElement(TOOL_GROUP_ICON[g.id] ?? Wind, { size: 11, strokeWidth: 1.9 })}
                  {GROUP_SHORT[g.id] ?? ''}
                </span>
              </Tooltip>
              {g.tools.map((t, ti) => {
                const Icon = icons[ti]
                const type = nodeTypeOf(g, t)
                return (
                  <Tooltip
                    key={t.id}
                    content={`${t.label} · ${STATE_TEXT[t.state]}${t.hint ? ` · ${t.hint}` : ''} · 可拖入画板建「${CANVAS_NODE_META[type].label}」节点`}
                  >
                    <button
                      type="button"
                      aria-label={t.label}
                      draggable
                      onDragStart={(e) => {
                        const payload: CanvasDragPayload = { type, label: t.label }
                        e.dataTransfer.setData(CANVAS_DND_MIME, JSON.stringify(payload))
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => setActive({ tool: t, group: g.title })}
                      className={cn(
                        'flex h-[34px] w-[34px] cursor-grab items-center justify-center rounded-tps border',
                        'shadow-[0_1px_2px_rgba(31,42,36,.05)] transition-all duration-150 [&>svg]:block',
                        'hover:-translate-y-px hover:shadow-tp1 active:cursor-grabbing',
                        STATE_RING[t.state],
                      )}
                    >
                      <Icon size={16} strokeWidth={1.75} />
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          )
        })}
      </aside>

      <Drawer
        open={!!active}
        onClose={() => setActive(null)}
        title={active?.tool.label ?? ''}
        meta={active?.group}
      >
        {active ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <StatusDot
                status={
                  active.tool.state === 'online' ? 'done' : active.tool.state === 'fault' ? 'alert' : 'empty'
                }
                label={STATE_TEXT[active.tool.state]}
              />
              <span className="text-[12px] text-t3">{active.tool.hint ?? '—'}</span>
            </div>
            <p className="text-[13px] leading-6 text-t2">
              设备一律以 MCP 节点的形式落在画板上：节点只显示挂了几个工具、健康状态与接入形态，
              取数走设备侧采集出口，跑脚本走命令行会话，要看原生界面走远程桌面。终端只在节点放大态里出现。
              连接参数与凭据由场景包的设备记录提供，不写在前端。
            </p>
            <div className="surface-2 p-3">
              <div className="tick">拖入画板</div>
              <div className="num mt-1 text-[13px] text-t2">按住本工具拖到画板落点即建节点</div>
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
