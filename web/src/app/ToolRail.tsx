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
  Ruler,
  Terminal,
  Thermometer,
  Waves,
  Wind,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Drawer, StatusDot, Tooltip, cn } from '../components/ui'
import type { ToolGroup, ToolItem } from '../data/types'
import { TOOL_GROUP_ICON } from './icons'

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

/** C 区右侧竖向工具条 56px：四组图标按钮，组间留白，悬停显示名称 */
export function ToolRail({ groups }: { groups: ToolGroup[] }) {
  const [active, setActive] = useState<{ tool: ToolItem; group: string } | null>(null)

  return (
    <>
      <aside
        className="fade-tb no-scrollbar flex w-[56px] shrink-0 flex-col items-center gap-4 overflow-y-auto border-l border-line-soft bg-p50/50 py-4"
      >
        {groups.map((g, gi) => (
          <div
            key={g.id}
            className={cn(
              'flex w-full flex-col items-center gap-1.5 px-2',
              gi > 0 && 'border-t border-line-soft pt-4',
            )}
          >
            <Tooltip content={g.title}>
              <span className="flex h-[18px] w-[18px] items-center justify-center text-p400 [&>svg]:block">
                {createElement(TOOL_GROUP_ICON[g.id] ?? Wind, { size: 14, strokeWidth: 1.9 })}
              </span>
            </Tooltip>
            {g.tools.map((t, ti) => {
              const Icon = iconsOf(g)[ti]
              return (
                <Tooltip key={t.id} content={`${t.label}${t.hint ? ` · ${t.hint}` : ''}`}>
                  <button
                    type="button"
                    aria-label={t.label}
                    onClick={() => setActive({ tool: t, group: g.title })}
                    className={cn(
                      'relative flex h-[34px] w-[34px] items-center justify-center rounded-tps border border-line bg-white',
                      'text-t2 shadow-[0_1px_2px_rgba(31,42,36,.05)] transition-all duration-150 [&>svg]:block',
                      'hover:-translate-y-px hover:border-p200 hover:bg-p50 hover:text-p700 hover:shadow-tp1',
                    )}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                    <span
                      className={cn(
                        'absolute top-[3px] right-[3px] h-[6px] w-[6px] rounded-full ring-2 ring-white',
                        t.state === 'online'
                          ? 'bg-p600'
                          : t.state === 'fault'
                            ? 'bg-alert'
                            : 'bg-t3/40',
                      )}
                    />
                  </button>
                </Tooltip>
              )
            })}
          </div>
        ))}
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
                label={
                  active.tool.state === 'online' ? '在线' : active.tool.state === 'fault' ? '故障' : '离线'
                }
              />
              <span className="text-[12px] text-t3">{active.tool.hint ?? '—'}</span>
            </div>
            <p className="text-[13px] leading-6 text-t2">
              只能在单机上跑的设备不在本页重写控制面板，而是把那台机器的会话拉过来：
              取数走设备侧采集出口，跑脚本走命令行会话，要看原生界面走远程桌面。
              连接参数与凭据由场景包的设备记录提供，不写在前端。
            </p>
            <div className="surface-2 p-3">
              <div className="tick">会话</div>
              <div className="num mt-1 text-[13px] text-t2">bench-a · 远程登录会话就绪</div>
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
