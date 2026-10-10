import { useLayoutEffect } from 'react'
import { AlertOctagon, Check } from 'lucide-react'
import { FLOWS } from '../../data/flows'
import { FLOW_ICON, FLOW_SHORT } from '../../app/icons'
import { cn } from '../../components/ui'
import { useAppStore } from '../../state/useAppStore'
import { useFlowBarScale } from '../shared/useFlowBarScale'
import { FlowSegLink, segPhaseOf } from '../shared/FlowSegLink'
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
        肉眼不可见）；箭头改亮绿实心 + 轻发光；
     ④ 「调优运行 → 启动测试」退回时（编排器 tune 采纳后回 run 重跑），
        该段连线走反向流动 + 箭头反向（useStageReturnCue 检测真实 stage 跳变）；
     ⑤ [第二轮] 动效范围收紧（用户需求单）：仅「当前节点 → 下一节点」段有动效，
        已走过/未到达段全部静态，节点由「当前」变「已完成」时旧段动效淡出+缩小平滑
        消失；空闲态整条完全安静。段相位统一由 shared/FlowSegLink 的 segPhaseOf()
        推导（与顶栏同一口径），平滑进出由 CSS（.flow-seg-anim + data-on）承担。

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
  // 运行态与当前节点下标：仅「当前 → 下一」段播放进度动效，非运行态整条安静
  const running = useAppStore((s) => s.automationRunStatus === 'running')
  const curViewId = views.find((v) => v.isCurrent)?.id ?? null
  const curIdx = curViewId ? FLOWS.findIndex((f) => f.id === curViewId) : -1
  // 缩放：与顶栏同口径（2026-10-10 由 2× 回落到 1.5×；标签基准 20px×s < 10px 进紧凑模式）
  const { slotRef, barRef, scale, compact } = useFlowBarScale<HTMLDivElement>({
    labelPx: 20,
    compactTextPx: 10,
  })

  /*
   * 把缩放口径写到 HeaderBar（最近的 header）：
   *   · --auto-header-h：顶栏高度随流程条放大（1.5×→120×s，不低于 56px），
   *     避免条被压扁/溢出；
   *   · --fb-scale：供 header 内的**退出按钮**使用（2026-10-10 新增）——
   *     它要与流程条节点同族，必须共用同一套缩放；不写出去的话 header 取不到
   *     该变量，1.5× 下按钮与流程条比例会失衡。
   */
  useLayoutEffect(() => {
    const bar = slotRef.current?.closest('header')
    if (!bar) return
    bar.style.setProperty('--auto-header-h', `${Math.round(120 * scale)}px`)
    bar.style.setProperty('--fb-scale', String(scale))
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
          /* 段相位（与顶栏同一口径，见 shared/FlowSegLink）：
               仅「当前 → 下一」段有动效；已走过段与未到达段都是纯静态线（无箭头）；
               非运行态整条安静。平滑消失由 CSS（.flow-seg-anim + data-on）承担。 */
          const leftId = i > 0 ? FLOWS[i - 1].id : null
          const leftDone = !!leftId && views.find((s) => s.id === leftId)?.status === 'success'
          const segPhase =
            i > 0
              ? segPhaseOf({
                  segIndex: i,
                  leftDone,
                  curIdx,
                  running,
                  returning,
                  isReturnSeg,
                })
              : null
          return (
            <div key={f.id} className="flex shrink-0 items-center">
              {segPhase ? (
                <FlowSegLink
                  segIndex={i}
                  phase={segPhase}
                  testId="auto-stage-link"
                  arrowTestId="auto-seg-arrow"
                />
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
