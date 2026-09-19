import { create } from 'zustand'
import {
  DEFAULT_SCENE_ID,
  loadCatalog,
  loadScene,
  pathOfScene,
  type CatalogNode,
} from '../data/loadScene'
import { MOCK_SCENE } from '../data/mock/motor.cooling-fan.fu6832'
import type { FlowState } from '../data/flows'
import type { FlowId, ScenePackage } from '../data/types'

type ParamValue = number | string

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

  selectProduct: (path: [string, string, string], sceneId?: string) => void
  setParam: (key: string, v: ParamValue) => void
  confirmFlow: (flow: FlowId) => void
  unconfirmFlow: (flow: FlowId) => void
  setModel: (m: string) => void
  /** 启动时把目录与默认场景包读进来（真实包在 public/scenes/ 下） */
  bootstrap: () => void
}

export const paramKey = (flow: FlowId, group: string, sub: string, item: string) =>
  `${flow}.${group}.${sub}.${item}`

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
  interlockPending: 2,
  quota: '额度 82%',

  model: 'deepseek-v4-pro',

  selectProduct: (path, sceneId) => {
    const id = sceneId ?? DEFAULT_SCENE_ID
    // 换包等于换掉六条流程的全部数据，上一个产品的人工改动与确认状态不再适用，
    // 一并清掉；「要不要丢」的询问在 ProductCascader 里做，这里只负责执行。
    set({ path, loading: true, overrides: {}, touched: {}, confirmed: {} })
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
