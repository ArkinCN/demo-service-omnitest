/* ===========================================================================
   设备 MCP 节点的两个视图：画板上的节点体、放大态。
   设备记录、接入形态、工具统计与探活钩子在同目录的 device.ts。
   =========================================================================== */
import { useState } from 'react'
import { Button, Tooltip } from '../../components/ui'
import type { ScenePackage } from '../../data/types'
import { RemoteDeviceCard } from './RemoteDeviceCard'
import { RemoteTerminal } from './RemoteTerminal'
import type { ConnState } from './types'
import { ACCESS_FORMS, BENCH_DEVICE, deviceToolStat, useDeviceState } from './device'

/** 画板上的节点体：只有三行事实，没有终端 */
export function DeviceMcpNodeBody({ scene, state }: { scene: ScenePackage; state: ConnState }) {
  const stat = deviceToolStat(scene)
  const rows: [string, string][] = [
    ['工具', `${stat.total} 个 · 在线 ${stat.online}`],
    ['形态', ACCESS_FORMS.slice(0, 2).join(' · ')],
    ['地址', `${BENCH_DEVICE.host}:${BENCH_DEVICE.port}`],
  ]
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2 text-[12px] leading-none">
          <span className="w-[30px] shrink-0 text-t3">{k}</span>
          <Tooltip content={k === '形态' ? ACCESS_FORMS.join(' / ') : v}>
            <span className="num truncate text-t2">{v}</span>
          </Tooltip>
        </div>
      ))}
      <div className="text-[12px] leading-none text-t3">
        {state === 'connected' ? '网关已连通' : '网关未连通'}
      </div>
    </div>
  )
}

/** 放大态：设备卡 + 接入形态 + 终端。终端按需打开，关掉即回画板。 */
export function DeviceMcpExpanded({ scene }: { scene: ScenePackage }) {
  const state = useDeviceState()
  const [term, setTerm] = useState(false)
  const stat = deviceToolStat(scene)

  return (
    <div className="flex h-full min-h-0 w-full gap-3">
      <div className="flex w-[320px] shrink-0 flex-col gap-2">
        <RemoteDeviceCard device={BENCH_DEVICE} state={state} onOpenTerminal={() => setTerm(true)} />
        <div className="surface-2 p-3">
          <div className="tick">接入形态</div>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-5 text-t2">
            {ACCESS_FORMS.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="surface-2 p-3">
          <div className="tick">已挂工具</div>
          <div className="num mt-1 text-[13px] text-t2">
            {stat.total} 个 · 在线 {stat.online} · 异常 {stat.fault}
          </div>
          <p className="mt-2 text-[12px] leading-5 text-t3">
            工具清单取自当前场景包的工具条登记。SSH 只是「命令行会话」这一种接入形态的实现细节，
            凭据不进浏览器：网关侧只按环境变量名 {BENCH_DEVICE.keyRef} 取私钥。
          </p>
        </div>
        {term ? (
          <div className="min-h-0 flex-1">
            <RemoteTerminal
              deviceId={BENCH_DEVICE.id}
              target={BENCH_DEVICE}
              title={BENCH_DEVICE.name}
              presets={BENCH_DEVICE.presets}
            />
          </div>
        ) : (
          <div className="surface-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3">
            <p className="text-[12px] text-t3">终端只在放大态出现，画板层不开终端</p>
            <Button size="sm" variant="secondary" onClick={() => setTerm(true)}>
              打开终端
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
