import { useCallback, useEffect, useRef, useState } from 'react'
import type { FlowId } from '../data/types'
import { useAppStore } from '../state/useAppStore'
import { cn } from '../components/ui'
import { AssistantPanel } from './AssistantPanel'
import { LeftPanel } from './LeftPanel'
import { ResourcePanel } from './ResourcePanel'

/** 一屏三块：左栏参数 380 · 右上面板（hero）· 右下助手。块间距 24。
 *
 *  右列两行的比例（助手高 / 面板高）现由一条可拖拽分隔条控制，助手还可整块收起。
 *  起因：助手消息一多就被压到只剩输入框，看不到上下文。原来写死在 index.css 的
 *  .right-rows（1.75fr / 1fr）只按视口高度分档，改不了人手想要的即时比例。
 *
 *  三条纪律：
 *  一、默认值与原来一致（1.75 : 1），不拖的话观感不变；
 *  二、比例存 localStorage，跨刷新保留，但每个流程各自记一份；
 *  三、收起是「零高 + 一条窄条」，不是卸载——收起时不打断正在跑的会话。
 */

/**
 * 助手行占右列总高的最小/最大比例。
 *
 * 上限给到 0.97：用户要「上拉能盖住上面的面板卡片」，拉到 0.97 时上方面板
 * 只剩一条缝，等于把助手当主区用来看回答、翻历史——这正是他要的用法。
 * 上一版卡在 0.92 且上方面板另有 120px 下限，两者叠加导致「拉不到顶」，
 * 故一并放开：上方面板下限改成 0（允许被压扁），上限提到 0.97。
 *
 * 下限 0.15 仍保留：保证输入框与消息区还能用，不至于一拖就没了。
 */
const MIN_ASSISTANT_RATIO = 0.15
const MAX_ASSISTANT_RATIO = 0.97
/** 与 index.css 里 .right-rows 的默认行比保持一致（1fr / (1.75fr + 1fr)） */
const DEFAULT_ASSISTANT_RATIO = 1 / 2.75

const ratioKey = (flow: FlowId) => `flow-assistant-ratio:${flow}`
const collapsedKey = (flow: FlowId) => `flow-assistant-collapsed:${flow}`

function readRatio(flow: FlowId): number {
  if (typeof localStorage === 'undefined') return DEFAULT_ASSISTANT_RATIO
  const raw = Number(localStorage.getItem(ratioKey(flow)))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ASSISTANT_RATIO
  return Math.min(MAX_ASSISTANT_RATIO, Math.max(MIN_ASSISTANT_RATIO, raw))
}

export function FlowScreen({ flow }: { flow: FlowId }) {
  const scene = useAppStore((s) => s.scene)
  // 自动化运行期间：左栏收起、右上大屏与右下 AI 拉伸铺满（有过渡，见 index.css）。
  const autoRunning = useAppStore((s) => s.automationRunStatus === 'running')
  // 比例与收起态都按流程分别记住：流程 3 想把助手拉大，不该顺带改到流程 5。
  const [ratio, setRatio] = useState(() => readRatio(flow))
  const [collapsed, setCollapsed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(collapsedKey(flow)) === '1',
  )
  const rowsRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // 切流程：把该流程自己那份比例与收起态读回来
  useEffect(() => {
    setRatio(readRatio(flow))
    setCollapsed(
      typeof localStorage !== 'undefined' && localStorage.getItem(collapsedKey(flow)) === '1',
    )
  }, [flow])

  const persistRatio = useCallback(
    (r: number) => {
      setRatio(r)
      try {
        localStorage.setItem(ratioKey(flow), String(r))
      } catch {
        // 隐私模式下 localStorage 可能被禁；记不住不影响本次调整
      }
    },
    [flow],
  )

  const persistCollapsed = useCallback(
    (c: boolean) => {
      setCollapsed(c)
      try {
        localStorage.setItem(collapsedKey(flow), c ? '1' : '0')
      } catch {
        // 同上
      }
    },
    [flow],
  )

  /**
   * 拖拽：按下分隔条后监听 window 的 move/up，而不是分隔条自己的。
   * 指针很容易在拖动中滑出那条 6px 的细线，绑在自己身上会中途丢事件。
   */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const box = rowsRef.current?.getBoundingClientRect()
      if (!box || box.height <= 0) return
      // 助手在下面：从底部往上量，得到的就是助手应占的比例
      const fromBottom = (box.bottom - e.clientY) / box.height
      persistRatio(Math.min(MAX_ASSISTANT_RATIO, Math.max(MIN_ASSISTANT_RATIO, fromBottom)))
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [persistRatio])

  const startDrag = () => {
    dragging.current = true
    // 拖动全程锁住光标与选区，否则手一快就选中了半屏文字
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  /**
   * 分隔条高度：拖动区做成实心条，占掉上下 gap 之和。
   *
   * 原来分隔条只有 6px，而两行之间还有一条 gap（clamp 14~24px），等于在拖动条
   * 上下各留了一道空档，视觉上是一大块空白。现在条本身就有 gap 那么高，
   * 并把 gap 全收进条里（下方 gap=0），空档不再出现。
   */
  const HANDLE_H = 20

  /**
   * 助手行的最小高度（px）。
   *
   * 必须给死数：助手外面那层 Panel 是 overflow-hidden，行一旦能被压到 0，
   * 输入框与消息区就被整块裁掉（2026-09-23 出现过：只剩一个「发送」按钮）。
   *
   * 这个数要按**内容的真实占用**给，给少了底部会被裁、给多了会顶出视口。
   * 实测「头部 44 + 动作条约 34 + 输入框约 58 + 底部模型行约 40 + 内边距」
   * ≈ 215px；取 216 让整套控件（含「模型 / 权限」那一行）在任何视口都完整可见。
   *
   * 之所以敢给这么大：上方面板行是 minmax(0, Xfr)，会被自动压扁让位，
   * 两行加起来不会超过容器高度。
   */
  const ASSISTANT_MIN_H = 216

  /**
   * 上方面板行的最小高度（px）—— 2026-10-09 新增。
   *
   * 为什么需要：上方面板行原本是 `minmax(0, Xfr)`，**下限是 0**，会被助手行
   * （下限 216px）挤到极扁。实测（1440×900 视口、助手默认比例）：
   *   右列总高 565px → 上方面板 209px → 卡槽网格 138px → 趋势图 hero 卡 136px
   * → 减去卡头与读数行，绘图区只剩 **21px**，曲线与三根纵轴全都看不见
   * （实测：tooltip 都抓不到，5 项精度断言全「失败」——那是抓不到，不是格式化失效）。
   *
   * 为什么给 300：卡槽网格自身也有下限（见 ResourcePanel 的 minmax(220px,…)），
   * 两者相加 ~520px 才够「卡头 + 读数行 + 三轴 + 底部滑块」完整显示。
   *
   * ⚠️ 与「助手可拉到 0.97 盖住面板」那条既有设计的关系：那条是**用户主动拖到顶**
   * 时的行为（把面板压到只剩一条缝，助手当主区用来看回答）。这里给的是
   * **默认/常规状态下的保底**——拖到顶时 0.97fr 仍然远大于 300px，用户意图不受影响。
   * 换句话说：拖动仍可任意压缩，但**不会因为视口一矮就自动把图表压没**。
   */
  const PANEL_MIN_H = 300

  /**
   * 用比例换算 grid 行高。
   *
   * 三行结构：上方面板 / 分隔条 / 助手。上方面板下限给 PANEL_MIN_H（保住图表可读），
   * 助手行给像素下限 ASSISTANT_MIN_H 保住输入框。两处下限对称，才不会一边被压扁。
   *
   * 收起时只剩两行：上方面板占满 + 一条「展开助手」窄条自己撑高度。
   */
  const rows = collapsed
    ? 'minmax(0, 1fr) auto'
    : `minmax(${PANEL_MIN_H}px, ${(1 - ratio).toFixed(4)}fr) ${HANDLE_H}px minmax(${ASSISTANT_MIN_H}px, ${ratio.toFixed(4)}fr)`

  return (
    <div
      /*
       * 只需 flex-1 + min-h-0：由父级 flex 容器分配剩余高度。
       * 不要再加 h-full —— flex-1 与 height:100% 同时存在会互相打架，
       * 父级高度不确定时整块会撑出视口，把助手底部（输入框那一行）挤出屏幕
       * （2026-09-23 出现过：输入框下的「模型 / 权限」行只露一半）。
       * items-stretch 保留：左右两列等高。
       */
      className={cn(
        'grid min-h-0 w-full flex-1 items-stretch overflow-hidden',
        autoRunning && 'automation-grid',
      )}
      style={{
        gridTemplateColumns: autoRunning ? '0px minmax(0, 1fr)' : 'minmax(300px, 380px) minmax(0, 1fr)',
        gap: autoRunning ? '0px' : 'clamp(14px, 1.25vw, 24px)',
      }}
    >
      {autoRunning ? null : <LeftPanel flow={flow} scene={scene} />}
      <div
        ref={rowsRef}
        className="right-rows grid min-h-0 min-w-0 overflow-hidden"
        // 右列不设 gap：竖排间距完全由分隔条那一行承担。
        // 若这里也留 gap，条上下会各多一道空档（4-N 修过一次）。
        style={{ gridTemplateRows: rows, gap: '0' }}
      >
        <ResourcePanel flow={flow} scene={scene} />

        {collapsed ? (
          <button
            type="button"
            onClick={() => persistCollapsed(false)}
            aria-expanded={false}
            title="展开助手"
            className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-tp border border-line-soft bg-surface text-[12px] text-t2 transition-colors hover:border-ink hover:text-ink"
          >
            <span aria-hidden>▲</span>
            展开助手
          </button>
        ) : (
          <>
            {/*
              可拖拽分隔条：一个有高度的实心条，鼠标进入才显形（平时只一条细线，
              不与内容抢注意力）。role="separator" + aria-* 让读屏软件知道这是
              可调整的分隔，方向键也能调——键盘可达，不只有鼠标能改。

              条本身充当了两行之间的间隔，"视觉上像一条可抓的缝"，而不是
              "两块内容之间空了一大截"。
            */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整助手高度"
              aria-valuenow={Math.round(ratio * 100)}
              aria-valuemin={Math.round(MIN_ASSISTANT_RATIO * 100)}
              aria-valuemax={Math.round(MAX_ASSISTANT_RATIO * 100)}
              tabIndex={0}
              onPointerDown={startDrag}
              onDoubleClick={() => persistRatio(DEFAULT_ASSISTANT_RATIO)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.05 : 0.02
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  persistRatio(Math.min(MAX_ASSISTANT_RATIO, ratio + step))
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  persistRatio(Math.max(MIN_ASSISTANT_RATIO, ratio - step))
                }
              }}
              className="group flex cursor-row-resize items-center justify-center focus-visible:outline-none"
              title="拖动调整助手高度（双击复位）"
            >
              {/*
                ⚠️ 2026-10-09 用户反馈「没注意到这里有拖动条」——原设计**平时几乎不可见**
                （一条 bg-line 细线，悬停才显形）。现改为**常显抓握手柄**：
                 · 坐着也不藏：外层圆角 capsule 底 + 中间一条较深的横条 + 两侧渐隐短线，
                   静止即读作「一根可抓的把手」；悬停/聚焦进一步加深加粗。
                 · 拖动逻辑（指针拖拽 / 双击复位 / 键盘方向键 / aria-*）**完全不变**。
              */}
              <span className="flex items-center gap-1 rounded-full bg-p50/70 px-2.5 py-[3px] transition-colors group-hover:bg-p50 group-focus-visible:bg-p50">
                <span className="h-[2px] w-5 rounded-full bg-t3/60 transition-colors group-hover:bg-ink group-focus-visible:bg-ink" />
                <span className="h-[4px] w-14 rounded-full bg-t2/70 transition-all group-hover:h-[5px] group-hover:bg-ink group-focus-visible:h-[5px] group-focus-visible:bg-ink" />
                <span className="h-[2px] w-5 rounded-full bg-t3/60 transition-colors group-hover:bg-ink group-focus-visible:bg-ink" />
              </span>
            </div>

            {/*
              收起按钮交给 AssistantPanel 自己渲染在头部右侧（由它决定落点），
              不再绝对定位浮在右上角——那样会压住头部的「沉淀为经验 / 依据」按钮。
            */}
            <AssistantPanel
              flow={flow}
              scene={scene}
              onCollapse={() => persistCollapsed(true)}
            />
          </>
        )}
      </div>
    </div>
  )
}
