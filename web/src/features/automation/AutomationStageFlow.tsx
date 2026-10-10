import { AlertOctagon, Check } from 'lucide-react'
import { FLOWS } from '../../data/flows'
import { FLOW_ICON, FLOW_SHORT } from '../../app/icons'
import { cn } from '../../components/ui'
import type { StageView } from './automationViewModel'

/* ===========================================================================
   自动化回归 · 五步骤流光条

   视觉口径与顶栏 FlowStepper 同源（同一套 FLOW_ICON/FLOW_SHORT），
   差别只在一处：**连接线带流动粒子** —— 自动化是「一条流程在跑」，
   静态连线看不出「正在往下一步走」，加一颗自左向右流动的粒子才立得住。

   ⚠️ 状态全部来自编排器（StageView.status），不预判、不乐观显示：
   还没到的步骤就是灰圈，不提前打勾。
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
  return (
    <div className="flex min-w-0 flex-1 items-center" data-testid="auto-stage-flow">
      {FLOWS.map((f, i) => {
        const v = views.find((s) => s.id === f.id)
        const status = v?.status ?? 'pending'
        const isCur = v?.isCurrent ?? false
        const done = status === 'success'
        const Icon = FLOW_ICON[f.id]
        return (
          <div key={f.id} className="flex min-w-0 flex-1 items-center">
            {i > 0 ? (
              /* 连接线：已完成实心、进行中流动、未开始灰 */
              <span
                className={cn(
                  'automation-rail-line relative mx-1 h-px min-w-3 flex-1 overflow-hidden rounded-full',
                  done ? 'bg-p600' : isCur ? 'automation-rail-flow' : 'bg-line',
                )}
              >
                {isCur ? <span className="automation-rail-particle" /> : null}
              </span>
            ) : null}
            <div className="flex shrink-0 items-center gap-1.5" title={`${f.index} ${f.label}`}>
              <span
                className={cn(
                  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-all duration-200 [&>svg]:block',
                  tone(status, isCur),
                )}
              >
                {status === 'failed' ? (
                  <AlertOctagon size={14} strokeWidth={2.5} />
                ) : done ? (
                  <Check size={14} strokeWidth={2.5} />
                ) : isCur ? (
                  <Icon size={14} strokeWidth={2} />
                ) : (
                  f.index
                )}
              </span>
              <span
                className={cn(
                  'text-[12px] whitespace-nowrap transition-colors',
                  status === 'failed'
                    ? 'text-alert'
                    : isCur
                      ? 'font-semibold text-p700'
                      : done
                        ? 'text-t2'
                        : 'text-t3',
                )}
              >
                {FLOW_SHORT[f.id]}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}