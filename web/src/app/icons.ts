/** 六流程与四组工具的图标表。导航、卡头、工具条、分组统一从这里取。 */
import {
  Activity,
  BookOpen,
  Boxes,
  Cable,
  CircuitBoard,
  ClipboardCheck,
  FileBarChart,
  Gauge,
  GitCompareArrows,
  Lightbulb,
  ListChecks,
  ListTree,
  PlayCircle,
  ShieldCheck,
  SlidersHorizontal,
  Waves,
  Wind,
  Workflow,
  Wrench,
} from 'lucide-react'
import type { FlowId } from '../data/types'

export const FLOW_ICON = {
  kb: BookOpen,
  init: SlidersHorizontal,
  req: ClipboardCheck,
  run: PlayCircle,
  tune: Gauge,
  report: FileBarChart,
} as const satisfies Record<FlowId, unknown>

/** 导航短名 ≤6 字 */
export const FLOW_SHORT: Record<FlowId, string> = {
  kb: '知识库',
  init: '初始化',
  req: '测试需求',
  run: '启动测试',
  tune: '调优运行',
  report: '测试报告',
}

export const TOOL_GROUP_ICON = {
  acquire: Waves,
  stimulus: Wind,
  device: Wrench,
  session: Cable,
} as const

export const CARD_ICON = {
  'product-view': Boxes,
  schematic: CircuitBoard,
  'project-tree': BookOpen,
  tools: Wrench,
  'bench-live': Activity,
  'remote-device': Cable,
  interlock: ShieldCheck,
  workflow: ClipboardCheck,
  'wf-lib': ListTree,
  timeseries: Waves,
  progress: Activity,
  pipeline: Workflow,
  candidates: ListChecks,
  'param-changes': GitCompareArrows,
  verdict: ShieldCheck,
  evidence: BookOpen,
  history: FileBarChart,
  experience: Lightbulb,
  artifacts: Boxes,
  'report-preview': FileBarChart,
  'template-fields': ClipboardCheck,
} as const
