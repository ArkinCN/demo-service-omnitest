/* ===========================================================================
   风扇趋势数据获取 hook（/api/fan-tests 轮询）。

   供 /fan-demo 页面与 flow-run 的 FanTrendPanel 卡片共用，避免重复实现：
     - 启动/停止：两档方法
         · requestStart/requestStop —— 弹红线确认卡，人确认后才执行（独立页用）
         · beginNow/stopNow         —— 直接启动/停止，不弹卡（已由外部入口弹过卡时用）
     - 轮询增量点（after_sequence 游标 + in-flight 串行锁）
     - 以后端 terminal 字段判权威终态

     实时性（2026-10-09 提速，方案 A）：
      · 轮询间隔 1000ms → POLL_INTERVAL_MS(400ms)；
      · 用 **setTimeout 自递归** 而非 setInterval —— setInterval 会在慢请求时堆积触发，
        自递归保证「上一轮彻底结束 → 等 400ms → 再发下一轮」，配合 pollingRef 双保险；
      · 单轮内「增量样本」与「运行状态」两个请求 **并发**（原本串行 await 白等一趟往返），
        端到端延迟从约 2.5s 压到约 1.8s（贴近硬件单次采集 1.5~2s 的硬下限）。
     提速只改「多久取一次」，**不改变取到的内容**：缺测字段仍为 null，不补 0、不插值。

     数据纪律：真实数据只来自接口；simulation=true 时调用方须如实标注。
     =========================================================================== */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getFanTest,
  getSamples,
  startFanTest,
  stopFanTest,
  type FanPlan,
  type FanSample,
  type FanTestGate,
} from './api'
import { useAppStore } from '../../state/useAppStore'
import { mergeSamples } from './samples'

export type FanPhase = 'idle' | 'running' | 'stopping' | 'done' | 'error'

/**
 * 轮询间隔（毫秒）。2026-10-09 由 1000 调为 400。
 *
 * 为什么是 400：后端为内存读取（samples 直接切片），一轮两个请求开销可忽略；
 * 硬件单次采集本身要 1.5~2s，400ms 的轮询已足够「采集一完成就取到」，再小只是白刷。
 * 抽成具名常量便于低配机上调参（调大即回退）。
 */
const POLL_INTERVAL_MS = 400

export interface UseFanTrend {
  plan: FanPlan | null
  samples: FanSample[]
  phase: FanPhase
  error: string
  /** 当前运行 id（未启动为 null），供调试/日志/上报 */
  runId: string | null
  /** 弹红线确认卡 → 人确认后才真正启动（独立演示页用） */
  requestStart: () => void
  /** 弹红线确认卡 → 人确认后才真正停止（独立演示页用） */
  requestStop: () => void
  /** 直接启动（不弹卡）：调用方须确保已过红线闸门（如左下角按钮已弹过卡） */
  beginNow: (gate?: FanTestGate) => void
  /** 直接停止（不弹卡） */
  stopNow: () => void
}

export function useFanTrend(): UseFanTrend {
  const [plan, setPlan] = useState<FanPlan | null>(null)
  const [samples, setSamples] = useState<FanSample[]>([])
  const [phase, setPhase] = useState<FanPhase>('idle')
  const [error, setError] = useState<string>('')
  const [runId, setRunId] = useState<string | null>(null)
  const cursorRef = useRef(0) // after_sequence 游标
  const runIdRef = useRef<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const pollingRef = useRef(false) // 轮询串行锁：一次只允许一个在途请求
  // 自递归续期开关：stopPolling 置 false（终态/卸载/换轮都走它），
  // 避免「poll 内部 stopPolling 清掉 timer 后，finally 又 schedule 一轮」的复活 bug。
  const activeRef = useRef(false)
  const aliveRef = useRef(true)
  // phase 的 ref 镜像：beginNow 的防重判定要读最新 phase，
  // 但它自己被包在 useCallback 里，直接依赖 phase 会每次重建回调。
  const phaseRef = useRef<FanPhase>('idle')

  /** 同时更新 state 与 ref，保持两者同步（所有 setPhase 走这里）。 */
  const setPhaseBoth = useCallback((next: FanPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const stopPolling = useCallback(() => {
    activeRef.current = false
    if (timerRef.current != null) {
      // 自递归用 setTimeout，清理必须用 clearTimeout（用 clearInterval 清不掉）
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    // 串行锁：上一次轮询未返回时直接跳过本次，避免慢请求交叠（自递归下是双保险）
    if (pollingRef.current) return
    pollingRef.current = true
    const curRunId = runIdRef.current
    if (!curRunId) {
      pollingRef.current = false
      return
    }
    try {
      // 两个请求无依赖（samples 与 status 各自独立）→ **并发**发出，省掉一趟串行往返。
      // 语义不变：下面仍先合并 samples、推进游标，再用 status 判终态。
      const [res, st] = await Promise.all([
        getSamples(curRunId, cursorRef.current),
        getFanTest(curRunId),
      ])
      if (res.samples.length) {
        // 归一（去重 + 按 t_s 排序）走 features/fan-trend/samples.ts 的唯一实现：
        // 与本文件原先的内联逻辑行为等价，但运行台那条采集路径也共用同一份口径。
        setSamples((prev) => mergeSamples(prev, res.samples))
      }
      // 游标只在成功合并后推进
      cursorRef.current = Math.max(cursorRef.current, res.next_after_sequence)

      setPlan(st)
      // 以后端权威 terminal 字段判断终态（不硬编码 status 字符串）
      if (st.terminal) {
        setPhaseBoth(st.status === 'failed' ? 'error' : 'done')
        if (st.error) setError(st.error)
        // 本轮已终态 → 清掉 runId 残留：留着的后果是「新一轮点不动」
        // （beginNow 防重）与「旧轮次被继续轮询导致每秒 2 次 404」。
        runIdRef.current = null
        setRunId(null)
        stopPolling()
      } else if (st.status === 'stopping') {
        setPhaseBoth('stopping')
      }
    } catch (e) {
      if (!aliveRef.current) return
      // 404 = 该 runId 在后端已不存在（上一轮早已结束、或后端重启丢了内存态）。
      // 这是**轮询对象失效**，不是「本轮采集失败」——直接把后端消息弹到界面上
      // 会让用户在跑新一轮时看到上一轮的「运行不存在」红字，纯属噪声
      //（2026-10-11 实测：旧轮次轮询不停止，每秒 2 次 × 97 次）。
      // 故：停轮询 + 静默回到 idle，不把 404 当成采集错误上报。
      const status = (e as { status?: number }).status
      if (status === 404 || /运行不存在|not found/i.test((e as Error).message)) {
        stopPolling()
        runIdRef.current = null
        setRunId(null)
        setPhaseBoth('idle')
        setError('')
        return
      }
      // 其余错误（网络抖动、5xx 等）照旧如实显示，但不打断轮询：
      // 单次瞬时失败不该让整轮采集停摆。
      setError((e as Error).message)
    } finally {
      pollingRef.current = false
    }
  }, [stopPolling])

  /**
   * 启动轮询（setTimeout 自递归）。
   *
   * 为什么不用 setInterval：慢请求（或后端抖动）下 interval 会按固定节拍继续排队触发，
   * 造成请求堆积；自递归是「本轮彻底结束 → 等 POLL_INTERVAL_MS → 再发下一轮」，
   * 天然不会堆积。`schedule` 抽成内部函数，`poll` 结束后再排下一次。
   * 终态时 `poll` 内部会 `stopPolling()`，此后不再排下一轮（timerRef 已置空）。
   */
  const startPolling = useCallback(() => {
    stopPolling()
    activeRef.current = true
    const schedule = () => {
      timerRef.current = window.setTimeout(() => {
        void poll().finally(() => {
          // 续期条件：仍存活 且 轮询未被 stopPolling 关闭。
          // 终态（poll 内部 stopPolling）/卸载 时 activeRef=false → 不再续期，杜绝空转。
          if (!aliveRef.current || !activeRef.current) return
          schedule()
        })
      }, POLL_INTERVAL_MS)
    }
    schedule()
  }, [poll, stopPolling])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopPolling()
    }
  }, [stopPolling])

  /** 直接启动：不弹确认卡（调用方须确保已过红线闸门）。 */
  const beginNow = useCallback(
    (gate?: FanTestGate) => {
      // 防重：仅在「本轮**真的还在跑**」时拦截。
      // ⚠️ 原来写成 `if (runIdRef.current) return`（只看有没有 runId）——上一轮
      //   结束后 runId 仍留在 ref 里，于是：① 新一轮点不动；② 旧 runId 继续被
      //   轮询，后端已无此轮 → 每秒 2 次 404（2026-10-11 实测 97 次）。
      // 现在按 phase 判定，并顺手清掉上一轮的残留 runId，让新轮次能正常起。
      if (phaseRef.current === 'running' || phaseRef.current === 'stopping') return
      setError('')
      setSamples([])
      cursorRef.current = 0
      setPhaseBoth('running')
      void (async () => {
        try {
          const p = await startFanTest({ gate })
          runIdRef.current = p.run_id
          setRunId(p.run_id)
          setPlan(p)
          startPolling()
        } catch (e) {
          setPhaseBoth('error')
          setError((e as Error).message)
        }
      })()
    },
    [startPolling, setPhaseBoth],
  )

  /** 直接停止：不弹确认卡。 */
  const stopNow = useCallback(() => {
    const curRunId = runIdRef.current
    if (!curRunId) return
    setPhaseBoth('stopping')
    void (async () => {
      try {
        await stopFanTest(curRunId)
        // 继续轮询直到终态
        await poll()
      } catch (e) {
        setPhaseBoth('error')
        setError((e as Error).message)
      }
    })()
  }, [poll, setPhaseBoth])

  const requestStart = useCallback(() => {
    // 启动是被测电机的红线动作：先弹确认卡，人点确认才执行（复用全局确认卡）
    useAppStore.getState().requestRedline({
      action: 'start',
      title: '启动风扇测试',
      prompt:
        '启动被测风扇并按计划运行：台架会真的转起来。确认前请先确认现场无人接触旋转件。',
      argsSummary: '按默认计划 30/50/70/100% 各 20 秒，一轮 80 秒',
      onApprove: () => {
        beginNow()
      },
    })
  }, [beginNow])

  const requestStop = useCallback(() => {
    const curRunId = runIdRef.current
    if (!curRunId) return
    useAppStore.getState().requestRedline({
      action: 'stop',
      title: '停止风扇测试',
      prompt: '按正常流程停止本轮测试：电机减速停转，已采到的数据保留。',
      argsSummary: `run_id ${curRunId.slice(0, 8)}`,
      onApprove: () => {
        stopNow()
      },
    })
  }, [stopNow])

  return { plan, samples, phase, error, runId, requestStart, requestStop, beginNow, stopNow }
}
