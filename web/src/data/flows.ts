import type { FlowId } from './types'

export interface FlowAction {
  id: string
  label: string
  /** 主动作：墨绿描边实心文字，每流程一个（规格 5.3） */
  primary?: boolean
  /** 破坏性动作：暗红描边 */
  danger?: boolean
  /** 前置条件未满足时置灰 */
  disabled?: boolean
  disabledReason?: string
}

export interface FlowDef {
  id: FlowId
  path: string
  index: string
  label: string
  /** 标签状态（规格 5.2） */
  precondition?: string
  actions: FlowAction[]
}

export const FLOWS: FlowDef[] = [
  {
    id: 'kb',
    path: '/kb',
    index: '1',
    label: '知识库管理',
    actions: [
      { id: 'upload', label: '上传文档', primary: true },
      { id: 'new-class', label: '新建分类' },
      { id: 'to-exp', label: '沉淀为经验' },
      { id: 'manage-entry', label: '管理条目' },
    ],
  },
  {
    id: 'init',
    path: '/init',
    index: '2',
    label: '初始化配置',
    precondition: '需先选定产品类型',
    actions: [
      { id: 'autofill', label: '读取文档自动填充', primary: true },
      { id: 'save-tpl', label: '另存为参数模板' },
      { id: 'validate', label: '校验配置' },
      { id: 'lock', label: '提交并锁定' },
    ],
  },
  {
    id: 'req',
    path: '/requirements',
    index: '3',
    label: '测试需求确认',
    precondition: '需流程 2 已确认',
    actions: [
      { id: 'baseline', label: '确认需求基线', primary: true },
      { id: 'import-std', label: '导入标准' },
      { id: 'edit-wf', label: '编辑工作流' },
      { id: 'save-tpl', label: '另存模板' },
    ],
  },
  {
    id: 'run',
    path: '/run',
    index: '4',
    label: '启动测试及结果分析',
    precondition: '需流程 3 已确认且安全联锁全绿',
    actions: [
      {
        id: 'start',
        label: '启动测试',
        primary: true,
        disabled: true,
        disabledReason: '安全确认闸门未逐条确认前不可启动',
      },
      { id: 'precheck', label: '预检自检' },
      { id: 'stop', label: '停止' },
      { id: 'estop', label: '急停', danger: true },
    ],
  },
  {
    id: 'tune',
    path: '/tune',
    index: '5',
    label: '调优确认及运行',
    precondition: '需流程 4 有一轮结果',
    actions: [
      { id: 'adopt-back', label: '采纳并回到启动测试', primary: true },
      { id: 'ignore-all', label: '全部忽略' },
      { id: 'rollback', label: '回滚基线', danger: true },
      { id: 'view-evidence', label: '查看依据' },
    ],
  },
  {
    id: 'report',
    path: '/report',
    index: '6',
    label: '测试报告及产出',
    precondition: '需流程 4 有明确结论',
    actions: [
      { id: 'gen-report', label: '生成报告', primary: true },
      { id: 'preview', label: '预览' },
      { id: 'export', label: '导出' },
      // 「归档到知识库」只留在「产物留档」卡内那一处——它紧贴产物列表，语义完整；
      // 动作条再放一遍是同一条动作出现两次（DESIGN.md §4 文案纪律 4）。
    ],
  },
]

export const FLOW_BY_ID = Object.fromEntries(FLOWS.map((f) => [f.id, f])) as Record<
  FlowId,
  FlowDef
>

export const FLOW_BY_PATH = Object.fromEntries(FLOWS.map((f) => [f.path, f]))

/** 流程标签状态（规格 5.2）：未开始 / 进行中 / 已确认 / 有异常 */
export type FlowState = 'idle' | 'active' | 'confirmed' | 'alert'
