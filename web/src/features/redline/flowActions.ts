/* ===========================================================================
   顶栏动作条与左栏确认按钮的行为表。

   第四轮之前这些按钮全是静态渲染，一个 onClick 都没有（08c-部署联调与演示SOP-v1.0.md
   第零节「点不动的三处」第 1、2、3 条）。本文件把它们逐个接上，并保证六个红线动作
   （启动、停止、急停、写回参数、导出、归档）一律先落确认卡再执行。

   接了设备桥时红线动作走三段式：
     1. 不带 confirm_token 调一次桥的工具 → 桥拒绝执行，回一张 pending 凭据；
     2. 人在确认卡上点「确认执行」→ 前端调 POST /confirmations/{token}/approve；
     3. 带同一张票、同一组参数重调工具 → 才真执行。
   桥不可达时第 1、3 步跳过，只驱动页面回放，确认卡照弹，红线口径不因此松掉。
   =========================================================================== */
import { useNavigate } from 'react-router'
import {
  useAppStore,
  type RedlineAction,
  type RedlineRequest,
} from '../../state/useAppStore'
import { callBridgeTool, previewArgs, useBridgeDevice } from '../remote/bridge'

/** 一个动作按钮点下去要知道的三件事 */
export interface ActionBinding {
  onClick: () => void
  disabled: boolean
  /** 置灰理由，挂 tooltip */
  reason?: string
}

/** 六个红线动作在桥上对应的工具名与本次要送的参数 */
const BRIDGE_CALL: Partial<Record<RedlineAction, { tool: string; args: Record<string, unknown> }>> = {
  start: { tool: 'start', args: { duty_percent: 60, duration_s: 10 } },
  stop: { tool: 'stop', args: {} },
  estop: { tool: 'estop', args: { reason: '页面急停按钮' } },
  write_param: { tool: 'write_param', args: { key: 'ALIGN_CURRENT', value: 0.6 } },
  export: { tool: 'export', args: { run_id: 'demo-run', fmt: 'xlsm' } },
  archive: { tool: 'archive', args: { run_id: 'demo-run', note: '页面归档按钮' } },
}

/**
 * 排一个红线动作。始终先弹确认卡；桥在线时先向桥要一张凭据，凭据拿不到就把
 * 原因写在卡上，不假装拿到了。
 */
export function useRedlineGate(deviceId = 'bench') {
  const bridge = useBridgeDevice(deviceId)
  const requestRedline = useAppStore((s) => s.requestRedline)

  return (
    action: RedlineAction,
    opts: { title: string; prompt: string; argsSummary: string; danger?: boolean; onApprove: () => void },
  ) => {
    const call = BRIDGE_CALL[action]
    const base: RedlineRequest = {
      action,
      title: opts.title,
      prompt: opts.prompt,
      argsSummary: opts.argsSummary,
      danger: opts.danger,
      confirmToken: null,
      deviceId,
      onApprove: opts.onApprove,
    }
    if (bridge.link !== 'online' || !call) {
      requestRedline(base)
      return
    }
    // 第一段：不带票调一次，等桥拒绝并发票
    void callBridgeTool(deviceId, call.tool, call.args)
      .then((r) => {
        const token = r.confirm_token ?? null
        const preview = previewArgs(r.args_preview)
        requestRedline({
          ...base,
          confirmToken: token,
          prompt: r.prompt ? `${r.prompt}。${r.reason ?? '设备桥已拒绝执行并签发凭据'}` : base.prompt,
          argsSummary: preview ? `${preview}（设备桥绑定的参数指纹）` : base.argsSummary,
          onApprove: async () => {
            // 第三段：带同一张票、同一组参数重调。参数改一个字桥都会拒。
            if (token) await callBridgeTool(deviceId, call.tool, { ...call.args, confirm_token: token })
            opts.onApprove()
          },
        })
      })
      .catch((e: unknown) => {
        requestRedline({
          ...base,
          prompt: `${base.prompt}\n设备桥取票失败：${e instanceof Error ? e.message : String(e)}。确认后只驱动页面回放，不向台架下发命令。`,
        })
      })
  }
}

/* --------------------------------------------------------------- 动作绑定表 */

/**
 * 按动作 id 取绑定。TopBar 的动作条与左栏底部确认按钮共用同一份，
 * 同一条动作不会出现两种行为。
 */
export function useFlowActions(): (id: string) => ActionBinding {
  const nav = useNavigate()
  const redline = useRedlineGate()
  const bridge = useBridgeDevice()
  const s = useAppStore()

  const gateGreen = s.gateTotal > 0 && s.gateAcked.length >= s.gateTotal
  const gateLeft = Math.max(0, s.gateTotal - s.gateAcked.length)
  const adoptedCount = s.adoptedKeys.length
  const noop: ActionBinding = {
    onClick: () => undefined,
    disabled: true,
    reason: '该动作在当前原型里未接后端',
  }

  const adoptedList = () =>
    s.adoptedKeys.map((k) => ({
      key: k,
      name: s.adoptMeta[k]?.name ?? k,
      from: s.adoptMeta[k]?.from ?? '—',
      to: s.adoptMeta[k]?.to ?? '—',
    }))

  const table: Record<string, ActionBinding> = {
    /* ------------------------------------------------------------- 流程 3 */
    start: {
      disabled: !gateGreen || s.runPhase === 'running',
      reason: !gateGreen
        ? `安全闸门还差 ${gateLeft} 条未逐条确认，确认前不可启动`
        : s.runPhase === 'running'
          ? '本轮正在运行，先停止再启动'
          : undefined,
      onClick: () =>
        redline('start', {
          title: '启动测试',
          prompt: '启动被测电机并按本轮设置跑一遍：台架会真的转起来。确认前请先确认现场无人接触旋转件。',
          argsSummary: `闸门 ${s.gateAcked.length}/${s.gateTotal} 全绿 · 回放本轮登记时序`,
          onApprove: () => {
            useAppStore.getState().beginRun()
            useAppStore.getState().setNotice('本轮已启动，出判定后可在判定卡上点未达标行进流程 4')
          },
        }),
    },
    precheck: {
      disabled: false,
      onClick: () => {
        if (bridge.link === 'online' && bridge.device) {
          const st = bridge.device.status
          s.setNotice(
            `预检：设备桥 ${st.mode} 模式 · ${st.hostname ?? '主机名未取到'} · 工具 ${bridge.toolCount} 个 · 闸门 ${s.gateAcked.length}/${s.gateTotal}`,
          )
        } else {
          s.setNotice(`预检：设备桥未接入（${bridge.reason ?? '原因未知'}）· 闸门 ${s.gateAcked.length}/${s.gateTotal}`)
        }
      },
    },
    stop: {
      disabled: s.runPhase !== 'running',
      reason: s.runPhase !== 'running' ? '本轮没有在运行的测试' : undefined,
      onClick: () =>
        redline('stop', {
          title: '停止',
          prompt: '按正常流程停止本轮测试：电机减速停转，已采到的数据保留。',
          argsSummary: `本轮进度 ${s.runProgress}%`,
          onApprove: () => {
            useAppStore.getState().setRunPhase('stopped')
            useAppStore.getState().setNotice('本轮已停止，已采数据保留')
          },
        }),
    },
    estop: {
      disabled: false,
      onClick: () =>
        redline('estop', {
          title: '急停',
          prompt: '立即切断驱动输出。软件急停只是补充手段，现场仍须有一条物理急停回路，不能拿它当唯一手段。',
          argsSummary: '原因：页面急停按钮',
          danger: true,
          onApprove: () => {
            useAppStore.getState().setRunPhase('estopped')
            useAppStore.getState().setNotice('已急停：驱动输出切断')
          },
        }),
    },

    /* ------------------------------------------------------------- 流程 4 */
    'adopt-back': {
      disabled: adoptedCount === 0,
      reason: adoptedCount === 0 ? '先在推荐参数里勾选要采纳的项' : undefined,
      onClick: () =>
        redline('write_param', {
          title: '写回参数并回到启动测试',
          prompt: `把 ${adoptedCount} 项采纳的建议值写回驱动板，然后回到流程 3 重跑一轮。写回只改数值外壳括号内的数字，不换外壳、不动行尾注释。`,
          argsSummary: adoptedList()
            .map((c) => `${c.key.toUpperCase()} ${c.from}→${c.to}`)
            .join('；'),
          onApprove: () => {
            const st = useAppStore.getState()
            st.applyAdopt(adoptedList())
            st.confirmFlow('tune')
            st.setRunPhase('idle')
            st.setNotice(`已采纳 ${adoptedCount} 项并回到流程 3，可重新启动一轮`)
            nav('/run')
          },
        }),
    },
    'ignore-all': {
      disabled: adoptedCount === 0,
      reason: adoptedCount === 0 ? '当前没有勾选中的推荐项' : undefined,
      onClick: () => {
        const n = adoptedCount
        s.adoptedKeys.forEach((k) => s.toggleAdopt(k))
        s.setNotice(`已忽略 ${n} 条推荐，本轮不写回任何参数`)
      },
    },
    rollback: {
      disabled: s.adoptedApplied.length === 0,
      reason: s.adoptedApplied.length === 0 ? '本会话还没有写回过参数，没有可回滚的基线' : undefined,
      onClick: () =>
        redline('write_param', {
          title: '回滚基线',
          prompt: `把上一次写回的 ${s.adoptedApplied.length} 项参数改回原值。回滚同样是写回动作，走同一道红线。`,
          argsSummary: s.adoptedApplied.map((c) => `${c.key.toUpperCase()} ${c.to}→${c.from}`).join('；'),
          danger: true,
          onApprove: () => {
            const st = useAppStore.getState()
            st.applyAdopt([])
            st.setNotice('已回滚到写回前的基线')
          },
        }),
    },
    'view-evidence': {
      disabled: false,
      onClick: () => nav('/knowledge'),
    },

    /* ------------------------------------------------------------- 流程 5 */
    'gen-report': {
      disabled: false,
      onClick: () => {
        const st = useAppStore.getState()
        st.setReportGenerated(true)
        st.setNotice('报告已按模板生成，导出与归档仍须人点并确认')
        nav('/report')
      },
    },
    preview: {
      disabled: false,
      onClick: () => {
        useAppStore.getState().setReportGenerated(true)
        nav('/report')
      },
    },
    export: {
      disabled: false,
      onClick: () =>
        redline('export', {
          title: '导出',
          prompt: '把本轮产物导出成交付件落盘。导出件一旦发出即视为对外结论，先核对表头与判定表。',
          argsSummary: 'run_id demo-run · 格式 xlsm',
          onApprove: () => {
            useAppStore.getState().setReportGenerated(true)
            useAppStore.getState().setNotice(`导出已由 ${useAppStore.getState().operator} 确认执行`)
          },
        }),
    },
    'archive-kb': {
      disabled: false,
      onClick: () =>
        redline('archive', {
          title: '归档到知识库',
          prompt: '把本轮产物与判定结论归档进知识库，归档后会被后续检索命中。',
          argsSummary: 'run_id demo-run · 备注：页面归档按钮',
          onApprove: () =>
            useAppStore.getState().setNotice(`归档已由 ${useAppStore.getState().operator} 确认执行`),
        }),
    },

    /* ------------------------------------------------- 流程 1 / 2 的确认类动作 */
    lock: {
      disabled: false,
      onClick: () => {
        useAppStore.getState().confirmFlow('init')
        useAppStore.getState().setNotice('流程 1 配置已提交并锁定')
      },
    },
    baseline: {
      disabled: false,
      onClick: () => {
        useAppStore.getState().confirmFlow('req')
        useAppStore.getState().setNotice('需求基线已确认')
      },
    },
  }

  return (id: string) => table[id] ?? noop
}
