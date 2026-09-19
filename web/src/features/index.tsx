/* ===========================================================================
   扩展装配点。

   卡片注册表按卡片库标识（CardId）唯一，因此同一张卡在多条流程里要显示不同
   内容时，只能注册一次、在 render 里按 ctx.flow 分派——这里的 CARD_IMPL 就是
   那张分派表。左栏与副驾按流程各注册一次。
   =========================================================================== */
import type { CardId, FlowId } from '../data/types'
import { registerAssistant, registerLeftPanel, registerPanelCard } from '../registry'
import { useAppStore } from '../state/useAppStore'
import { FlowCopilot } from './copilot'
import { kbCards, KbLeftPanel } from './flow-kb/panel'
import { initCards } from './flow-init/panel'
import { reqCards, ReqLeftPanel } from './flow-req/panel'
import { runCards, RunLeftPanel } from './flow-run/panel'
import { tuneCards, TuneLeftPanel } from './flow-tune/panel'
import { reportCards, ReportLeftPanel } from './flow-report/panel'

type CardImpl = (p: { full?: boolean }) => React.ReactNode

/** 卡片库标识 → 各流程的实现。key 是流程，缺省表示该流程不出这张卡。 */
const CARD_IMPL: Partial<Record<CardId, Partial<Record<FlowId, CardImpl>>>> = {
  'project-tree': { kb: kbCards['project-tree'], init: initCards['project-tree'] },
  'wf-lib': { req: reqCards['wf-lib'] },
  evidence: { kb: kbCards.evidence, req: reqCards.evidence, tune: tuneCards.evidence },
  history: {
    req: reqCards.history,
    tune: tuneCards.history,
    report: reportCards.history,
  },
  experience: { kb: kbCards.experience },
  pipeline: { kb: kbCards.pipeline },
  progress: { run: runCards.progress },
  candidates: { tune: tuneCards.candidates },
  tools: { kb: kbCards.tools },
  'product-view': { init: initCards['product-view'] },
  schematic: { init: initCards.schematic, run: runCards.schematic },
  'bench-live': { init: initCards['bench-live'] },
  interlock: { init: initCards.interlock, run: runCards.interlock },
  workflow: { req: reqCards.workflow },
  verdict: {
    req: reqCards.verdict,
    run: runCards.verdict,
    tune: tuneCards.verdict,
    report: reportCards.verdict,
  },
  timeseries: { run: runCards.timeseries, tune: tuneCards.timeseries },
  'remote-device': { run: runCards['remote-device'] },
  'report-preview': { report: reportCards['report-preview'] },
  artifacts: { report: reportCards.artifacts },
  'template-fields': { report: reportCards['template-fields'] },
}

const LABEL: Partial<Record<CardId, string>> = {
  'project-tree': '文档库 / 工程树',
  'wf-lib': '工作流库',
  evidence: '知识库依据',
  history: '历史对比',
  experience: '经验库',
  pipeline: '转化流水线',
  progress: '执行进度与日志',
  candidates: '候选队列',
  verdict: '判定卡',
}

for (const [id, impls] of Object.entries(CARD_IMPL) as [CardId, Record<FlowId, CardImpl>][]) {
  const flows = Object.keys(impls) as FlowId[]
  registerPanelCard({
    id,
    label: LABEL[id] ?? id,
    flows,
    render: ({ flow }) => {
      const C = impls[flow]
      return C ? <C /> : null
    },
    renderExpanded: ({ flow }) => {
      const C = impls[flow]
      return C ? (
        <div className="h-[430px] w-[1180px] max-w-full bg-surface p-2">
          <C full />
        </div>
      ) : null
    },
  })
}

registerLeftPanel('kb', KbLeftPanel)
registerLeftPanel('req', ReqLeftPanel)
registerLeftPanel('run', RunLeftPanel)
registerLeftPanel('tune', TuneLeftPanel)
registerLeftPanel('report', ReportLeftPanel)
// 流程 2 初始化配置的左栏就是 product-attributes.json 的 29 项参数，
// 壳层默认参数栏（Stepper + 来源标签）已经正好，不另外接管。

for (const f of ['kb', 'init', 'req', 'run', 'tune', 'report'] as FlowId[]) {
  registerAssistant(f, () => <FlowCopilot flow={f} />)
}

/** 启动即把真实场景包读进来（public/scenes/motor.cooling-fan.fortior-fu6832/）。 */
useAppStore.getState().bootstrap()

