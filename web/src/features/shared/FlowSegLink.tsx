import type { CSSProperties, ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../components/ui'

/* ===========================================================================
   流程条 · 连接段共享件（2026-10-10 第二轮新增）

   背景：此前两处流程条（顶栏 FlowStepper / 运行台 AutomationStageFlow）的
   **每一段**都无条件挂「流光 + 波浪箭头」→ 用户反馈「满屏动效，看不出流程
   走到哪一步」。本件把「段相位」抽成纯函数 + 分层组件，两处复用同一口径：

   段与节点：FLOWS 顺序 init(1)/req(2)/run(3)/tune(4)/report(5)；
   段 i（1..4）连接节点 [i-1] → [i]，右侧节点即该段的「下一节点」。

   相位口径（用户 2026-10-10 确认，需求单第三部分验收标准）：
     · active    仅「当前节点 → 下一节点」一段：亮色流光 + 亮绿箭头循环平移；
     · returning active 且为调优回退段（段 3：启动测试 → 调优运行）且退回信号
                 置位 → 反向（沿用既有 flow-seg-return / flow-seg-arrow-rev）；
     · done      左节点已完成 → 纯静态线，**无箭头**（已走过区域安静）；
     · pending   运行中但尚未到达 → 纯静态暗线，**无箭头**；
     · idle      非运行态 → 纯静态线，无箭头（空闲态完全安静）。
   curIdx = 4（停在节点 5）时无段满足 active → 无动效段（横向条上无 5→1 连接段）。

   ⚠️ 2026-10-10 二次确认（用户看效果后）：未到达段那个静态暗色小箭头
   "不显示、影响观感" → 已按纯静态线处理（此前实现过锚点居中的暗箭头，
   现整体删除：DOM、CSS 规则与 testid 一并移除，段内不留任何非预期构件）。
   需求单编号 3 原口径（未到达段显示静态暗色箭头）由本次指令覆盖。

   平滑消失（验收标准核心）：动效层**常驻 DOM**，只由 `data-on`
   驱动 CSS transition（opacity + scale 约 0.3s）——节点从「当前进行中」变
   「已完成」时，旧段箭头淡出 + 缩小平滑消失，新段同时淡入；连续切换由
   transition 直接重定向，无闪烁、无残留、不依赖 JS 定时器与动画结束事件。
   =========================================================================== */

export type SegPhase = 'active' | 'returning' | 'done' | 'pending' | 'idle'

export interface SegPhaseArgs {
  /** 段序号 1..4；段 i 连接节点 [i-1] 到节点 [i] */
  segIndex: number
  /** 段起点（左节点）是否已完成（编排器 status === 'success'） */
  leftDone: boolean
  /** 当前节点 0-based 下标（FLOWS 顺序）；-1 = 无当前节点 */
  curIdx: number
  /** 自动化是否运行中（非运行态一律静默） */
  running: boolean
  /** 退回信号（useStageReturnCue）是否置位 */
  returning: boolean
  /** 本段是否为调优回退段（段 3：启动测试 → 调优运行） */
  isReturnSeg: boolean
}

/** 段相位推导（纯函数，两处流程条同口径）。 */
export function segPhaseOf({
  segIndex,
  leftDone,
  curIdx,
  running,
  returning,
  isReturnSeg,
}: SegPhaseArgs): SegPhase {
  // ① 仅「当前 → 下一」段有动效
  if (running && curIdx >= 0 && segIndex === curIdx + 1) {
    return returning && isReturnSeg ? 'returning' : 'active'
  }
  // ② 已走过（左节点完成）→ 静态线，无箭头
  if (leftDone) return 'done'
  // ③ 运行中但未到达 → 静态线 + 静态暗色箭头
  if (running) return 'pending'
  // ④ 非运行态 → 静态线，无箭头（空闲态完全安静）
  return 'idle'
}

/** 基底线色：已走过一段（含当前段所在区间）用品牌浅绿，其余用中性线色 */
const LINE_CLASS: Record<SegPhase, string> = {
  active: 'bg-p200',
  returning: 'bg-p200',
  done: 'bg-p200',
  pending: 'bg-line',
  idle: 'bg-line',
}

/** 段几何：与改造前完全一致，避免影响 useFlowBarScale 测量与顶栏 pill 定位 */
const RAIL_CLASS = 'block h-[calc(var(--fb-scale)*3px)] w-[calc(var(--fb-scale)*48px)] rounded-full'
const ARROW_STYLE: CSSProperties = {
  width: 'calc(var(--fb-scale) * 21px)',
  height: 'calc(var(--fb-scale) * 21px)',
}

export interface FlowSegLinkProps {
  segIndex: number
  phase: SegPhase
  /** 段容器 testid：顶栏 'flow-stepper-link' / 运行台 'auto-stage-link' */
  testId: string
  /** 动效箭头 testid：顶栏 'flow-seg-arrow' / 运行台 'auto-seg-arrow' */
  arrowTestId: string
}

export function FlowSegLink({
  segIndex,
  phase,
  testId,
  arrowTestId,
}: FlowSegLinkProps): ReactElement {
  const animOn = phase === 'active' || phase === 'returning'
  const returning = phase === 'returning'

  return (
    <span
      aria-hidden
      data-testid={testId}
      data-seg={segIndex}
      data-phase={phase}
      className="relative z-10 flex shrink-0 items-center"
      style={
        {
          '--fb-wave-dur': '1.4s',
          '--fb-seg-travel': 'calc(var(--fb-scale) * 34px)',
        } as CSSProperties
      }
    >
      {/* ① 基底线：常显；颜色随相位用 transition-colors 淡变，不突变 */}
      <span className={cn(RAIL_CLASS, 'transition-colors duration-300', LINE_CLASS[phase])} />

      {/* ② 流光带（仅 active/returning）：常驻 DOM，data-on 控制淡入淡出 + 缩放 */}
      <span className="flow-seg-anim" data-on={animOn ? 'true' : 'false'}>
        <span className={cn(RAIL_CLASS, returning ? 'flow-seg-return' : 'automation-rail-flow')} />
      </span>

      {/* ③ 动效箭头（仅 active/returning）：循环平移；退回时反向 */}
      <span className="flow-seg-anim" data-on={animOn ? 'true' : 'false'}>
        <ChevronRight
          size={21}
          strokeWidth={3.5}
          data-testid={arrowTestId}
          className={cn(
            'absolute top-1/2 left-0 -translate-y-1/2',
            returning ? 'flow-seg-arrow-rev' : 'flow-seg-arrow',
          )}
          style={ARROW_STYLE}
        />
      </span>

      {/* ④ 未到达段（pending）：只保留基底线，不渲染任何箭头
          （2026-10-10 用户确认「暗色小箭头不显示、影响观感」）。 */}
    </span>
  )
}
