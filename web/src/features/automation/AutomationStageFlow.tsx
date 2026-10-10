import { useLayoutEffect } from 'react'
import { AlertOctagon, Check, ChevronRight } from 'lucide-react'
import { FLOWS } from '../../data/flows'
import { FLOW_ICON, FLOW_SHORT } from '../../app/icons'
import { cn } from '../../components/ui'
import { useFlowBarScale } from '../shared/useFlowBarScale'
import type { StageView } from './automationViewModel'
import { useStageReturnCue } from './useStageReturnCue'

/* ===========================================================================
   自动化回归 · 五步骤流光条

   视觉口径与顶栏 FlowStepper 同源（同一套 FLOW_ICON/FLOW_SHORT）。两条条
   共用 `useFlowBarScale` 缩放与同一套箭头/退回样式类，保证观感一致。

   2026-10-10 改造历程：
     ① 去掉全部 `flex-1` 拉伸 → 内容宽紧凑集群 + 居中（此前节点被弹性均分撑满整行）；
     ② 放大 2 倍（尺寸全部乘 --fb-scale），任何分辨率单行、文字过小则进入紧凑模式；
     ③ 箭头与细光带**分层**（此前 11px 箭头画在 h-[2px]+overflow-hidden 里被裁成细条，
        肉眼不可见）；箭头改亮绿实心 + 轻发光，波浪相位错开形成 1→2→3→4→5 连续滚动；
     ④ 「调优运行 → 启动测试」退回时（编排器 tune 采纳后回 run 重跑），
        该段连线走反向流动 + 箭头反向（useStageReturnCue 检测真实 stage 跳变）。

   ⚠️ 状态全部来自编排器（StageView.status），不预判、不乐观显示。
   =========================================================================== */

/** 圆点色调：与顶栏 Stepper 的 grad-ink / 墨绿体系保持一致 */
function tone(status: StageView['status'], isCurrent: boolean): string {
  if (status === 'failed') return 'bg-alert text-white'
  if (status === 'success') return 'bg-p100 text-p700'
  if (isCurrent) return 'grad-ink text-white shadow-tpink automation-pulse'
  if (status === 'skipped') return 'border border-line bg-p50 text-t3'
  return 'border border-line bg-white text-t3'
}

export function AutomationStageFlow({ views }: { views: StageView[] }) {
  // 退回提示：编排器调优循环「tune 采纳 → 回 run 重跑」时，该段走反向动效
  const returning = useStageReturnCue()
  // 缩放：与顶栏同口径（2026-10-10 由 2× 回落到 1.5×；标签基准 20px×s < 10px 进紧凑模式）
  const { slotRef, barRef, scale, compact } = useFlowBarScale<HTMLDivElement>({
    labelPx: 20,
    compactTextPx: 10,
  })

  // 运行台 HeaderBar 高度：随流程条放大（1.5×→120×s，不低于 56px），避免条被压扁/溢出
  useLayoutEffect(() => {
    const bar = slotRef.current?.closest('header')
    if (!bar) return
    bar.style.setProperty('--auto-header-h', `${Math.round(120 * scale)}px`)
  }, [scale, slotRef])

  return (
    <div
      ref={slotRef}
      className="flex min-w-0 flex-1 items-center justify-center"
      data-testid="auto-stage-flow"
    >
      <div
        ref={barRef}
        data-flow-bar="console"
        style={{ '--fb-scale': scale } as React.CSSProperties}
        className="flex w-fit shrink-0 items-center"
      >
        {FLOWS.map((f, i) => {
          const v = views.find((s) => s.id === f.id)
          const status = v?.status ?? 'pending'
          const isCur = v?.isCurrent ?? false
          const done = status === 'success'
          const Icon = FLOW_ICON[f.id]
          // 退回段＝「调优运行」这一步之前的连接段（启动测试 → 调优运行），退回时反向闪
          const isReturnSeg = f.id === 'tune'
          return (
            <div key={f.id} className="flex shrink-0 items-center">
              {i > 0 ? (
                /* 连接段：外层容纳箭头（不裁切），内层细光带，箭头独立层波浪错相 */
                <span
                  aria-hidden
                  data-testid="auto-stage-link"
                  data-seg={i}
                  className="relative z-10 flex shrink-0 items-center"
                  style={{
                    '--fb-wave-dur': '6.4s',
                    '--fb-seg-travel': 'calc(var(--fb-scale) * 34px)',
                  } as React.CSSProperties}
                >
                  <span
                    className={cn(
                      'block h-[calc(var(--fb-scale)*3px)] w-[calc(var(--fb-scale)*48px)] rounded-full',
                      isReturnSeg && returning ? 'flow-seg-return' : 'automation-rail-flow',
                    )}
                  />
                  <ChevronRight
                    size={21}
                    strokeWidth={3.5}
                    aria-hidden
                    data-testid="auto-seg-arrow"
                    className={cn(
                      'absolute top-1/2 left-0 -translate-y-1/2',
                      isReturnSeg && returning ? 'flow-seg-arrow-rev' : 'flow-seg-arrow',
                    )}
                    style={{
                      width: 'calc(var(--fb-scale) * 21px)',
                      height: 'calc(var(--fb-scale) * 21px)',
                      animationDelay: isReturnSeg && returning ? '0s' : `${(i - 1) * 1.6}s`,
                    }}
                  />
                </span>
              ) : null}
              <div
                className="flex shrink-0 items-center gap-[calc(var(--fb-scale)*5px)]"
                title={`${f.index} ${f.label}`}
              >
                <span
                  className={cn(
                    'flex h-[calc(var(--fb-scale)*39px)] w-[calc(var(--fb-scale)*39px)] shrink-0 items-center justify-center rounded-full font-semibold transition-all duration-200 [&>svg]:block',
                    tone(status, isCur),
                    // 已到达 / 当前节点发光脉冲，提示进度
                    done || isCur ? 'automation-pulse' : '',
                  )}
                  style={{ fontSize: 'calc(var(--fb-scale) * 19px)' }}
                >
                  {status === 'failed' ? (
                    <AlertOctagon size={21} strokeWidth={2.5} style={{ width: 'calc(var(--fb-scale) * 21px)', height: 'calc(var(--fb-scale) * 21px)' }} />
                  ) : done ? (
                    <Check size={21} strokeWidth={2.5} style={{ width: 'calc(var(--fb-scale) * 21px)', height: 'calc(var(--fb-scale) * 21px)' }} />
                  ) : isCur ? (
                    <Icon size={21} strokeWidth={2} style={{ width: 'calc(var(--fb-scale) * 21px)', height: 'calc(var(--fb-scale) * 21px)' }} />
                  ) : (
                    f.index
                  )}
                </span>
                {/* 标签：紧凑模式（文字过小）下隐藏，仅保留圆标+序号，悬停 title 显示全称 */}
                {!compact ? (
                  <span
                    className={cn(
                      'whitespace-nowrap transition-colors',
                      status === 'failed'
                        ? 'text-alert'
                        : isCur
                          ? 'font-semibold text-p700'
                          : done
                            ? 'text-t2'
                            : 'text-t3',
                    )}
                    style={{ fontSize: 'calc(var(--fb-scale) * 20px)' }}
                  >
                    {FLOW_SHORT[f.id]}
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
