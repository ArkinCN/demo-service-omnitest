/* ===========================================================================
   数据契约。命名与结构对齐设计规格
   《设计规格 · 信息架构与页面》
   /mnt/f/Main/File/2_Projects/峰岹/峰岹agent/09-实验室demo线/20260919-通用Agent测试系统v2.0/01-设计规格-信息架构与页面.md
   （第 4 节层级树、第 6 节 B 区、第 7 节卡片库、第 9 节六流程页面规格）

   场景包源目录 /mnt/f/Main/File/2_Projects/峰岹/40_工程/agent-test-web-data/scenes/<sceneId>/，
   两个包都已就位（散热风扇、玻璃升降器）。两包之间的字段差异在加载时由
   src/features/scene/pack.ts 的 normalize() 抹平，压成本契约的映射在
   src/data/loadScene.ts 的 adaptScene() 里做，UI 层只认这一套字段。
   =========================================================================== */

export const FLOW_IDS = ['kb', 'init', 'req', 'run', 'tune', 'report'] as const
export type FlowId = (typeof FLOW_IDS)[number]

/** 卡片库标识（规格 7.2） */
export const CARD_IDS = [
  'product-view',
  'schematic',
  'project-tree',
  'tools',
  'bench-live',
  'remote-device',
  'interlock',
  'workflow',
  'wf-lib',
  'timeseries',
  'progress',
  'pipeline',
  'candidates',
  'param-changes',
  'verdict',
  'evidence',
  'history',
  'experience',
  'artifacts',
  'report-preview',
  'template-fields',
] as const
export type CardId = (typeof CARD_IDS)[number]

/** 来源标记三态（规格 6.2） */
export type ParamSource = '文档' | '人工' | '建议'

/** 状态语义只三档 + 不适用（规格 3.3 / 6.1） */
export type ItemStatus = 'empty' | 'done' | 'alert' | 'na'

/** 三级：参数行 */
export interface ParamItem {
  id: string
  name: string
  value: number | string
  unit?: string
  kind?: 'number' | 'select' | 'switch' | 'readonly' | 'file' | 'table'
  step?: number
  min?: number
  max?: number
  precision?: number
  options?: string[]
  /** 与 options 一一对应的中文显示名；缺省时直接显示 options 里的原值 */
  optionLabels?: string[]
  source?: ParamSource
  status?: ItemStatus
  /** 11px 弱注：单位与取值范围说明 */
  note?: string
  /** 依据：文档名 + 位置 */
  evidence?: string
  /**
   * 「待核实」角标的说明文字。
   * 与 status: 'alert' 不同——alert 是「这个数是编的」（_placeholder），
   * pending 是「这个数有来源但来源本身还没定版」（_status），数值照常可用，
   * 只是引用时要说明。两者可以同时出现。
   */
  pending?: string
}

/** 二级：参数子组 */
export interface ParamSubGroup {
  id: string
  title: string
  items: ParamItem[]
}

/** 一级：参数分组（手风琴） */
export interface ParamGroup {
  id: string
  index: string
  title: string
  defaultOpen?: boolean
  subgroups: ParamSubGroup[]
}

/** B 区顶部输入清单行（规格 6.1） */
export interface ChecklistItem {
  id: string
  index: string
  name: string
  status: ItemStatus
  /** 定位按钮跳到哪个分组 */
  groupId: string
}

/** C 区卡片实例 */
export interface CardInstance {
  id: CardId
  /** 卡名覆写：同一张卡在不同场景包里指的东西不同时用（例如初始化 hero 图，
   *  散热风扇包里是原理图、玻璃升降器包里是结构示意图）。缺省用 CARD_LIB 的卡名。 */
  title?: string
  /** 卡头右侧的灰色时间戳 */
  stamp?: string
  /** 卡内一行摘要 */
  summary?: string
  /** 异常标记，出现即用暗红 */
  alert?: string
  /** 当前流程正在用：卡头左侧墨绿竖条 */
  active?: boolean
}

/** C 区工具条（规格 7.1，四组固定） */
export interface ToolItem {
  id: string
  label: string
  glyph: string
  state: 'online' | 'offline' | 'fault'
  hint?: string
}

export interface ToolGroup {
  id: 'acquire' | 'stimulus' | 'device' | 'session'
  title: string
  tools: ToolItem[]
}

/** D 区快捷指令片 */
export type QuickCommand = string

export interface FlowContent {
  checklist: ChecklistItem[]
  groups: ParamGroup[]
  /** 网格视图四个卡槽 */
  cards: CardInstance[]
  /** 画布视图的默认版式：卡片位置与连线 */
  canvas?: {
    nodes: { id: CardId; x: number; y: number; w: number; h: number }[]
    links: { from: CardId; to: CardId; kind: 'belong' | 'signal'; label?: string }[]
  }
  greeting: string
  quick: QuickCommand[]
  /** 确认条左侧的校验结果一行 */
  verifyLine: string
}

/** 三级产品体系：一级场景 › 二级子类 › 三级产品类型 */
export interface SceneMeta {
  id: string
  scene: string
  subclass: string
  productType: string
  /** 场景包名与版本，显示在全局状态位 */
  packName: string
  packVersion: string
  bench?: string
}

export interface ScenePackage {
  meta: SceneMeta
  toolGroups: ToolGroup[]
  flows: Record<FlowId, FlowContent>
}
