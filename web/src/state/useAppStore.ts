import { create } from 'zustand'
import { approveConfirmation, rejectConfirmation } from '../features/remote/bridge'
import {
  DEFAULT_SCENE_ID,
  loadCatalog,
  loadScene,
  pathOfScene,
  type CatalogNode,
} from '../data/loadScene'
import { MOCK_SCENE } from '../data/mock/motor.cooling-fan.fu6832'
import type { FlowState } from '../data/flows'
import { FLOW_IDS, type FlowId, type KnowledgeFilter, type ScenePackage } from '../data/types'

export type PanelView = 'canvas' | 'grid'

type ParamValue = number | string

/* ===========================================================================
   红线动作与运行状态（第四轮接线）

   红线的原话：启动、停止、急停、写回参数、导出、归档六个动作只能人点，且必须
   经确认。落到前端就是两条纪律：
     1. 六个动作一律经 requestRedline() 排队，由人在确认卡上点「确认」才执行；
     2. 副驾（features/copilot、features/agent-chat）只允许调 requestRedline，
        不允许直接调 approveRedline——批准只能由人的点击触发。
   接了设备桥（~/lab/spike-device-mcp）之后，批准动作再转发到桥的
   POST /confirmations/{token}/approve，凭据的四道约束仍只在桥里实现一次。

   2026-09-20 补第三条：批准要带 PIN。桥把鉴权拆成调用票（VITE_BRIDGE_TOKEN，
   进浏览器包）与批准权（BRIDGE_APPROVER_PIN，只在桥的服务端）两级。approveRedline
   因此要一个现场输入的 pin 实参，它从确认卡的输入框来，用完即弃：不存进 store、
   不写 localStorage、不进构建产物。没有 PIN 或 PIN 错，桥回 403，凭据保持 pending。
   依据：08a-开发接口契约-v1.0.md 第 3.4 节「两套确认机制，收口方案」。
   =========================================================================== */

export const REDLINE_ACTIONS = ['start', 'stop', 'estop', 'write_param', 'export', 'archive'] as const
export type RedlineAction = (typeof REDLINE_ACTIONS)[number]

export const REDLINE_LABEL: Record<RedlineAction, string> = {
  start: '启动测试',
  stop: '停止',
  estop: '急停',
  write_param: '写回参数',
  export: '导出',
  archive: '归档',
}

export interface RedlineRequest {
  action: RedlineAction
  /** 确认卡标题，用动作全名，不用代号 */
  title: string
  /** 一句话讲清点下去会发生什么，含物理后果 */
  prompt: string
  /** 参数摘要，一行内讲清这次要改什么 */
  argsSummary: string
  /** 破坏性动作：确认按钮走暗红 */
  danger?: boolean
  /** 设备桥签发的凭据。为空表示本轮走回放，没有真设备凭据可批。 */
  confirmToken?: string | null
  /** 凭据所属设备 id，批准时要用 */
  deviceId?: string
  /** 人点「确认」之后才执行的那段动作 */
  onApprove: () => void | Promise<void>
}

/** 流程 3 本轮运行状态机：待启动 → 运行中 → 出判定；停止与急停各有落点 */
export type RunPhase = 'idle' | 'running' | 'done' | 'stopped' | 'estopped'

export const RUN_PHASE_LABEL: Record<RunPhase, string> = {
  idle: '待启动',
  running: '运行中',
  done: '已出判定',
  stopped: '已停止',
  estopped: '已急停',
}

/** 本轮回放的推进时长：2.4 秒走满，够看清「运行中」这一态又不拖慢演示 */
const RUN_TICK_MS = 120
const RUN_TICKS = 20

/**
 * 确认人署名的默认值。真正生效的是 store 里的 operator 字段（可改），
 * 这里只是它的初值。署名只是署名：能不能批由批准 PIN 决定，不由这个名字决定。
 */
export const DEFAULT_OPERATOR = '张工'

interface AppState {
  sceneId: string
  /** 一级场景 / 二级子类 / 三级产品类型 */
  path: [string, string, string]
  scene: ScenePackage
  loading: boolean
  /** 产品三级级联目录，由 public/scenes/index.json 提供 */
  catalog: CatalogNode[]

  /** 参数覆盖值：`${flowId}.${groupId}.${subId}.${itemId}` → 值 */
  overrides: Record<string, ParamValue>
  /** 参数被人改过后来源标记转「人工」 */
  touched: Record<string, true>
  /** 已确认并锁定的流程 */
  confirmed: Partial<Record<FlowId, boolean>>

  /** 全局状态位 */
  benchBusy: boolean
  benchUser: string
  /** 安全联锁总闸：未满足项数，0 表示就绪 */
  interlockPending: number
  quota: string

  /** D 区 */
  model: string

  /* ------------------------------------------------------ 第三轮上提的四组字段 */

  /**
   * C 区视图，按流程各存一份：人手点过分段控件的流程记人的选择，
   * 没点过的流程留空、由场景包 ui.defaultView 或代码兜底决定。
   * 人工选择持久到 localStorage，刷新与切页都不回弹。
   */
  canvasView: Partial<Record<FlowId, PanelView>>
  /** 画板上当前选中的节点 id，无选中为 null（W3 消费） */
  canvasSelected: string | null
  /** 折叠状态记忆，键为 `${flowId}.${groupId}`，true 为展开（W4 消费） */
  collapse: Record<string, boolean>
  /** 知识库三轴筛选（W2 消费）；三个数组都空表示不过滤 */
  kbFilter: KnowledgeFilter

  /** 演示模式：只过滤展示面，不删场景包里的任何数据。默认开。 */
  demoMode: boolean

  /* ----------------------------------------------- 第四轮接线：闸门 / 运行 / 红线 */

  /** 安全确认闸门已勾条目的 id。跨左栏、闸门环、顶栏动作条共用这一份。 */
  gateAcked: string[]
  /** 本场景包里需要人工逐条确认的闸门条数（人员类 + 流程类），由左栏登记 */
  gateTotal: number
  /** 流程 3 本轮运行状态 */
  runPhase: RunPhase
  /** 运行进度 0–100 */
  runProgress: number
  /** 已完成第几轮；0 表示本会话还没跑过 */
  runRound: number
  /** 排队等人确认的红线动作，同一时刻只允许一条 */
  redline: RedlineRequest | null
  /** 批准正在发往设备桥的途中 */
  redlineBusy: boolean
  /** 上一次红线动作失败的原因，确认卡上原样显示 */
  redlineError: string | null
  /**
   * 红线动作留痕：谁在什么时候、以什么渠道确认了什么。
   * channel 恒为 human_pin：现场有人敲过批准 PIN 才可能走到这里。
   * 自动放行的那条旁路已于 2026-09-20 删除，台账里不会再出现无人点击的记录。
   */
  redlineLog: {
    at: string
    action: RedlineAction
    title: string
    token: string | null
    by: string
    channel: 'human_pin' | 'replay_no_bridge'
  }[]
  /** 确认人署名。默认「张工」，可在确认卡上改；只做署名，不做鉴权。 */
  operator: string
  /**
   * 本会话与助手完成的对话轮数。上下文包的 session.transcript_summary 由它推出来：
   * 零轮时如实为 null，依赖该字段的按钮（流程 4 的「经验草稿」）据此置灰。
   * 此前这一项在 ActionDock 里写死 null，于是那枚按钮无论如何都亮不起来（07i 核验 P3）。
   */
  chatRounds: number
  /** 流程 4 勾选中的候选参数 key */
  adoptedKeys: string[]
  /** 候选的回显信息，键为参数 key。勾选时由流程 4 左栏登记，供顶栏动作条复用。 */
  adoptMeta: Record<string, { name: string; from: string; to: string }>
  /** 已确认采纳、待写回的候选。确认采纳（红线 write_param）之后才落这里。 */
  adoptedApplied: { key: string; name: string; from: string; to: string }[]
  /** 从流程 3 判定卡点进流程 4 时带上的判据 id */
  focusReq: string | null
  /** 流程 5 是否已生成报告 */
  reportGenerated: boolean
  /** 一句话即时反馈，四秒后自散。只报实际发生的事，不报没做成的事。 */
  notice: string | null

  toggleGate: (id: string) => void
  setGateTotal: (n: number) => void
  requestRedline: (req: RedlineRequest) => void
  /** pin 由人在确认卡上现场输入；接了桥且没给 pin 时直接报错，不发请求 */
  approveRedline: (pin: string) => Promise<void>
  rejectRedline: () => void
  setOperator: (name: string) => void
  /** 助手跑完一轮时记一笔，供上下文包算对话摘要 */
  noteChatRound: () => void
  setRunPhase: (p: RunPhase) => void
  beginRun: () => void
  toggleAdopt: (key: string, meta?: { name: string; from: string; to: string }) => void
  applyAdopt: (list: { key: string; name: string; from: string; to: string }[]) => void
  setFocusReq: (id: string | null) => void
  setReportGenerated: (v: boolean) => void
  setNotice: (n: string | null) => void

  setCanvasView: (flow: FlowId, v: PanelView) => void
  setDemoMode: (on: boolean) => void
  setCanvasSelected: (id: string | null) => void
  setCollapse: (key: string, open: boolean) => void
  setKbFilter: (patch: Partial<KnowledgeFilter>) => void

  selectProduct: (path: [string, string, string], sceneId?: string) => void
  setParam: (key: string, v: ParamValue) => void
  confirmFlow: (flow: FlowId) => void
  unconfirmFlow: (flow: FlowId) => void
  setModel: (m: string) => void
  /** 启动时把目录与默认场景包读进来（真实包在 public/scenes/ 下） */
  bootstrap: () => void
}

/** 折叠状态记忆的键：流程 × 分组 */
export const collapseKey = (flow: FlowId, group: string) => `${flow}.${group}`

export const paramKey = (flow: FlowId, group: string, sub: string, item: string) =>
  `${flow}.${group}.${sub}.${item}`

/* --------------------------------------------------- 人工选择的本地持久化

   没有后端，人摆过的版式与模式只能落在浏览器本地：换机器、清缓存即丢，
   这是《第三轮实施计划》第六节风险 5 已拍板的取法（甲案）。
   读写一律包 try/catch：隐私窗口与禁用站点数据时 localStorage 会直接抛。 */

const LS_CANVAS_VIEW = 'omnitest.canvasView.v1'
const LS_DEMO_MODE = 'omnitest.demoMode.v1'

function readCanvasView(): Partial<Record<FlowId, PanelView>> {
  try {
    const raw = localStorage.getItem(LS_CANVAS_VIEW)
    if (!raw) return {}
    const j = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<Record<FlowId, PanelView>> = {}
    for (const f of FLOW_IDS) {
      const v = j[f]
      if (v === 'canvas' || v === 'grid') out[f] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeCanvasView(v: Partial<Record<FlowId, PanelView>>) {
  try {
    localStorage.setItem(LS_CANVAS_VIEW, JSON.stringify(v))
  } catch {
    /* 存不下就只在本次会话里生效，不报错、不影响渲染 */
  }
}

/** 演示模式默认开；地址栏 `?mode=full` 仍然直接强制全量，供评审与截图对照 */
function readDemoMode(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('mode')
      if (q === 'full') return false
      if (q === 'demo') return true
    }
    return localStorage.getItem(LS_DEMO_MODE) !== 'full'
  } catch {
    return true
  }
}

function writeDemoMode(on: boolean) {
  try {
    localStorage.setItem(LS_DEMO_MODE, on ? 'demo' : 'full')
  } catch {
    /* 同上 */
  }
}

export const useAppStore = create<AppState>((set) => ({
  sceneId: DEFAULT_SCENE_ID,
  path: ['电机', '散热风扇', 'FU6832 散热风扇驱动板'],
  scene: MOCK_SCENE,
  loading: false,
  catalog: [],

  overrides: {},
  touched: {},
  confirmed: { init: false },

  benchBusy: false,
  benchUser: '张工',
  interlockPending: 0,
  quota: '额度 82%',

  model: 'deepseek-v4-pro',

  canvasView: readCanvasView(),
  demoMode: readDemoMode(),
  canvasSelected: null,
  collapse: {},
  kbFilter: { usage: [], origin: [], owner: [] },

  gateAcked: [],
  gateTotal: 0,
  runPhase: 'idle',
  runProgress: 0,
  runRound: 0,
  redline: null,
  redlineBusy: false,
  redlineError: null,
  redlineLog: [],
  operator: DEFAULT_OPERATOR,
  chatRounds: 0,
  adoptedKeys: [],
  adoptMeta: {},
  adoptedApplied: [],
  focusReq: null,
  reportGenerated: false,
  notice: null,

  toggleGate: (id) =>
    set((s) => {
      const gateAcked = s.gateAcked.includes(id)
        ? s.gateAcked.filter((x) => x !== id)
        : [...s.gateAcked, id]
      // 顶栏那枚盾形徽章读的就是这个数：勾一条少一条，不另存一份口径
      return { gateAcked, interlockPending: Math.max(0, s.gateTotal - gateAcked.length) }
    }),
  setGateTotal: (n) =>
    set((s) =>
      s.gateTotal === n ? {} : { gateTotal: n, interlockPending: Math.max(0, n - s.gateAcked.length) },
    ),

  requestRedline: (req) => set({ redline: req, redlineError: null }),
  rejectRedline: () => {
    const req = useAppStore.getState().redline
    set({ redline: null, redlineBusy: false, redlineError: null })
    // 驳回也要通知桥，让那张凭据落到 rejected，别挂到超时
    if (req?.confirmToken) void rejectConfirmation(req.confirmToken, '操作员在页面上驳回').catch(() => null)
    resolveRedlineWaiter(false)
  },
  approveRedline: async (pin: string) => {
    const st0 = useAppStore.getState()
    const req = st0.redline
    if (!req) return
    // 接了桥就必须有 PIN。前端先拦一道不是为了当闸口（真闸口在桥上），
    // 而是别拿空 PIN 去撞桥的连错计数，把人自己锁掉。
    if (req.confirmToken && !pin.trim()) {
      set({ redlineError: '请先输入批准 PIN（取自设备桥 .env 的 BRIDGE_APPROVER_PIN，不在本页面里）' })
      return
    }
    set({ redlineBusy: true, redlineError: null })
    try {
      // 接了设备桥就把批准转发过去，不在前端另起一套凭据：红线的四道约束
      // （单次使用、180 秒过期、绑工具名、绑参数指纹）只在桥里实现一次。
      // PIN 只在这一行里过一次手，不留任何副本。
      if (req.confirmToken) await approveConfirmation(req.confirmToken, st0.operator, pin, req.title)
      await req.onApprove()
      set((s) => ({
        redline: null,
        redlineBusy: false,
        redlineLog: [
          {
            at: new Date().toISOString(),
            action: req.action,
            title: req.title,
            token: req.confirmToken ?? null,
            by: st0.operator,
            channel: req.confirmToken ? ('human_pin' as const) : ('replay_no_bridge' as const),
          },
          ...s.redlineLog,
        ].slice(0, 50),
      }))
      resolveRedlineWaiter(true)
    } catch (e) {
      set({ redlineBusy: false, redlineError: e instanceof Error ? e.message : String(e) })
    }
  },
  setOperator: (name) => set({ operator: name.trim() || DEFAULT_OPERATOR }),
  noteChatRound: () => set((s) => ({ chatRounds: s.chatRounds + 1 })),

  setRunPhase: (runPhase) => set({ runPhase }),
  beginRun: () => {
    set({ runPhase: 'running', runProgress: 0 })
    let i = 0
    const timer = window.setInterval(() => {
      i += 1
      const st = useAppStore.getState()
      // 中途被停止或急停就不再推进，也不出判定
      if (st.runPhase !== 'running') {
        window.clearInterval(timer)
        return
      }
      if (i >= RUN_TICKS) {
        window.clearInterval(timer)
        set((s) => ({ runPhase: 'done', runProgress: 100, runRound: s.runRound + 1 }))
      } else {
        set({ runProgress: Math.round((i / RUN_TICKS) * 100) })
      }
    }, RUN_TICK_MS)
  },

  toggleAdopt: (key, meta) =>
    set((s) => ({
      adoptedKeys: s.adoptedKeys.includes(key)
        ? s.adoptedKeys.filter((x) => x !== key)
        : [...s.adoptedKeys, key],
      adoptMeta: meta ? { ...s.adoptMeta, [key]: meta } : s.adoptMeta,
    })),
  applyAdopt: (adoptedApplied) => set({ adoptedApplied }),
  setFocusReq: (focusReq) => set({ focusReq }),
  setReportGenerated: (reportGenerated) => set({ reportGenerated }),
  setNotice: (notice) => set({ notice }),

  setCanvasView: (flow, v) =>
    set((s) => {
      const canvasView = { ...s.canvasView, [flow]: v }
      writeCanvasView(canvasView)
      return { canvasView }
    }),
  setDemoMode: (demoMode) => {
    writeDemoMode(demoMode)
    set({ demoMode })
  },
  setCanvasSelected: (canvasSelected) => set({ canvasSelected }),
  setCollapse: (key, open) => set((s) => ({ collapse: { ...s.collapse, [key]: open } })),
  setKbFilter: (patch) => set((s) => ({ kbFilter: { ...s.kbFilter, ...patch } })),

  selectProduct: (path, sceneId) => {
    const id = sceneId ?? DEFAULT_SCENE_ID
    // 换包等于换掉五条流程的全部数据，上一个产品的人工改动与确认状态不再适用，
    // 一并清掉；「要不要丢」的询问在 ProductCascader 里做，这里只负责执行。
    // 闸门、本轮运行、采纳候选同样属于「上一个产品的现场状态」，一并清掉
    set({
      path,
      loading: true,
      overrides: {},
      touched: {},
      confirmed: {},
      gateAcked: [],
      interlockPending: 0,
      runPhase: 'idle',
      runProgress: 0,
      runRound: 0,
      adoptedKeys: [],
      adoptMeta: {},
      adoptedApplied: [],
      focusReq: null,
      reportGenerated: false,
      notice: null,
    })
    void loadScene(id).then((scene) => set({ scene, sceneId: id, loading: false }))
  },
  setParam: (key, v) =>
    set((s) => ({
      overrides: { ...s.overrides, [key]: v },
      touched: { ...s.touched, [key]: true },
    })),
  confirmFlow: (flow) => set((s) => ({ confirmed: { ...s.confirmed, [flow]: true } })),
  unconfirmFlow: (flow) => set((s) => ({ confirmed: { ...s.confirmed, [flow]: false } })),
  setModel: (model) => set({ model }),
  bootstrap: () => {
    set({ loading: true })
    // ?scene=<sceneId> 直接指定开哪个场景包，给截图脚本与分享链接用；
    // 目录里没有这个 id 时忽略，走 index.json 的 default。
    const wanted =
      typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('scene')
    void loadCatalog().then(({ catalog, defaultScene }) => {
      set({ catalog })
      const target = wanted && pathOfScene(catalog, wanted) ? wanted : defaultScene
      void loadScene(target).then((scene) =>
        set({
          scene,
          sceneId: target,
          loading: false,
          path: pathOfScene(catalog, target) ?? [
            scene.meta.scene,
            scene.meta.subclass,
            scene.meta.productType,
          ],
        }),
      )
    })
  },
}))

/** 有没有未确认的人工改动；换产品前要问一句「未保存内容将丢失」 */
export function hasUnsavedChanges(s: {
  touched: Record<string, true>
  confirmed: Partial<Record<FlowId, boolean>>
}): boolean {
  return Object.keys(s.touched).length > 0 || Object.values(s.confirmed).some(Boolean)
}

/** 流程标签状态（规格 5.2）：已确认 / 有异常 / 进行中 / 未开始 */
export function flowStateOf(
  flow: FlowId,
  current: FlowId,
  scene: ScenePackage,
  confirmed: Partial<Record<FlowId, boolean>>,
): FlowState {
  if (confirmed[flow]) return 'confirmed'
  // 暗红每屏 ≤3 处（规格 3.3）：只有当前流程才把异常提到顶部标签上，
  // 其余流程未进入，显示未开始，不预告异常。
  if (flow === current) {
    return scene.flows[flow].checklist.some((c) => c.status === 'alert') ? 'alert' : 'active'
  }
  return 'idle'
}

/* ===========================================================================
   红线的「等人点」承诺版接口。

   副驾那一侧（features/agent-chat）拿到设备桥的 confirm_token 之后，不允许自己去调
   approveConfirmation——那是第二个批准调用点，等于在红线上开了第二个口子。它改走
   这里：把动作排进同一张确认卡，人敲 PIN 点确认才 resolve(true)，点取消 resolve(false)。
   于是全工程批准桥凭据的路径只剩一条：确认卡 → approveRedline → approveConfirmation。
   =========================================================================== */

let redlineWaiter: ((ok: boolean) => void) | null = null

function resolveRedlineWaiter(ok: boolean) {
  const w = redlineWaiter
  redlineWaiter = null
  w?.(ok)
}

/** 排一个红线动作并等人的裁决。返回 true 表示人敲了 PIN 并确认执行。 */
export function requestRedlineAsync(req: Omit<RedlineRequest, 'onApprove'>): Promise<boolean> {
  // 同一时刻只允许一条红线排队；上一条还挂着就按「未获批准」收尾，不静默丢弃
  resolveRedlineWaiter(false)
  return new Promise<boolean>((resolve) => {
    redlineWaiter = resolve
    useAppStore.getState().requestRedline({ ...req, onApprove: () => undefined })
  })
}
