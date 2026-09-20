import type { FlowId } from '../../data/types'
import type { RawPack } from '../scene/pack'
import type { ActionDef, ActionScope } from './actions'

/* ===========================================================================
   上下文包（context envelope v1）。

   规格见《上下文感知与预置按钮规格》第 1.3 节。该文件在
   /mnt/f/Main/File/2_Projects/峰岹/峰岹agent/09-实验室demo线/20260919-通用Agent测试系统v2.0/06-第三轮改版/
   目录下，按编号 06c 定位（磁盘上的文件名沿用了第二轮对助手的旧称，本轮起
   全工程一律称「助手」，故此处不再照抄旧名）。八段依次是：
   session / product / flow / zoneB / zoneC / lastRun / kb / policy，
   外加点按钮时才填的 action 段与可为空的 history 段。

   两条纪律：
   一、只装真取得到的东西。取不到的字段写 null，不拿别处的数顶上，
       依赖该字段的按钮据此置灰。
   二、参数只送人改过的那几项 diff，不送全量——场景包的控制参数有七十余项，
       整包塞进每一轮请求既无意义也读不动。
   =========================================================================== */

export interface Envelope {
  envelope_version: '1'
  action: { button_id: string; type: ActionDef['type']; confirmed: boolean } | null
  session: {
    session_id: string
    operator: string
    started_at: string
    transcript_summary: string | null
  }
  product: {
    scene_id: string
    taxonomy_path: [string, string, string]
    taxonomy_name: string
    product_name: string
  }
  flow: {
    id: ActionScope
    label: string
    step: string | null
    confirmed: Partial<Record<FlowId, boolean>>
  }
  zoneB: Record<string, unknown>
  zoneC: Record<string, unknown>
  lastRun: Record<string, unknown> | null
  history: { runs: unknown[] } | null
  kb: Record<string, unknown>
  policy: {
    permission: string
    auto_run: boolean
    redline_actions: string[]
  }
}

export interface EnvelopeInput {
  flow: ActionScope
  flowLabel: string
  pack: RawPack | null
  sceneId: string
  path: [string, string, string]
  operator: string
  /** 人改过的参数键，键形如 `${flow}.${group}.${sub}.${item}` */
  overrides: Record<string, number | string>
  touched: Record<string, true>
  confirmed: Partial<Record<FlowId, boolean>>
  benchBusy: boolean
  benchUser: string
  interlockPending: number
  canvasView: 'canvas' | 'grid'
  canvasSelected: string | null
  model: string
  /** 本轮对话的一句话摘要，没有对话时为 null */
  transcriptSummary: string | null
  /** 流程 4 已勾选的候选改动。空数组表示没选中，zoneB.selected_candidate 据此为 null。 */
  adopted: { key: string; name: string; from: string; to: string }[]
  /** 本会话已跑完第几轮；0 表示没跑过，lastRun.artifacts 据此为 null */
  runRound: number
}

const REDLINE = ['start', 'stop', 'estop', 'write_back', 'export', 'archive']

/** 只送人改过的那几项，键按 `paramKey` 的四段结构拆开 */
function paramDiff(input: EnvelopeInput) {
  return Object.keys(input.touched)
    .filter((k) => k.startsWith(`${input.flow}.`))
    .map((k) => {
      const seg = k.split('.')
      return { key: k, item: seg[seg.length - 1] ?? k, value: input.overrides[k] ?? null }
    })
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
  const p = input.pack
  const attrs = p?.attributes.attributes ?? []
  const params = p?.controls.parameters ?? []
  const reqs = p?.requirements.requirements ?? []
  const interlocks = p?.interlocks.interlocks ?? []

  // lastRun：本壳层还没有真跑过一轮，判定所需的现场实测量一个都没采到。
  // 所以 verdicts 给的是「每条判据当前处于什么状态」，不是判定结论；
  // artifacts 与 history 是轮次产物存储，尚未实现，如实写 null。
  const missingMeasures = [
    ...new Set(
      reqs.flatMap((r) =>
        Object.entries(r.variables ?? {})
          .filter(([, v]) => v.source === 'runtime.measure')
          .map(([name]) => name),
      ),
    ),
  ]
  const lastRun = p
    ? {
        run_id: null,
        finished_at: null,
        overall: 'invalid' as const,
        overall_note: '本轮没有现场实测量，判定不成立，不是「不通过」',
        verdicts: reqs.map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          evaluable: r.evaluable !== false,
          state: '未采集',
        })),
        failed_items: [],
        missing_measures: missingMeasures,
        // 轮次产物：本壳层没有真的落盘文件，跑完一轮后给的是回放态产物索引，
        // 字段里写明 replay，别让下游把它当成真交付件。没跑过就如实 null。
        artifacts:
          input.runRound > 0
            ? {
                run_id: `replay-run-${input.runRound}`,
                replay: true,
                note: '回放态产物索引：页面按场景包登记值回放出来的一轮，不是台架落盘文件',
                items: ['判定表', '报告草稿'],
              }
            : null,
        precheck: {
          hardware: 'ok',
          pending_gates: interlocks.filter((i) => i.type !== '硬件').map((i) => i.id),
          note: '硬件项由脚本化回放给出，人工与流程类闸门须人逐条确认',
        },
      }
    : null

  return {
    envelope_version: '1',
    action: null,
    session: {
      session_id: `shell-${input.sceneId}-${input.flow}`,
      operator: input.operator,
      started_at: new Date().toISOString(),
      transcript_summary: input.transcriptSummary,
    },
    product: {
      scene_id: input.sceneId,
      taxonomy_path: input.path,
      taxonomy_name: input.path.join(' › '),
      product_name: p?.scene.product.name ?? input.path[2],
    },
    flow: {
      id: input.flow,
      label: input.flowLabel,
      step: null,
      confirmed: input.confirmed,
    },
    zoneB: {
      form_groups: (p?.attributes.groups ?? []).map((g) => ({
        id: g,
        name: g,
        item_count: attrs.filter((a) => a.group === g).length,
      })),
      values: Object.fromEntries(paramDiff(input).map((d) => [d.key, d.value])),
      missing: attrs.filter((a) => a.value === null && !a.not_applicable).map((a) => a.key),
      placeholders: attrs.filter((a) => a._placeholder || a._status).map((a) => a.key),
      touched: paramDiff(input).map((d) => d.key),
      selected_item: null,
      // 各流程面板的选中态还是局部 useState，没有统一出口（06c 第 1.5 节已点名），
      // 这里如实写 null，依赖它们的按钮置灰。
      selected_document: null,
      selected_fail_item: null,
      // 候选改动是例外：它的选中态第四轮已上提到 store 的 adoptedKeys / adoptMeta，
      // 这里接上去，勾了候选「写回草稿」就能亮（07i 核验 P3）。
      selected_candidate: input.adopted.length
        ? {
            count: input.adopted.length,
            keys: input.adopted.map((c) => c.key),
            items: input.adopted,
          }
        : null,
      interlocks: interlocks.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        blocking: i.blocking,
      })),
      requirements: reqs.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        evaluable: r.evaluable !== false,
      })),
      control_params: params.map((c) => ({ key: c.key, name: c.name, unit: c.unit })),
      firmware_project: p ? { source: p.base, note: '场景包登记的控制参数来源工程' } : null,
      report_template: p ? { file: p.report.template_file, fields: p.report.header_fields.length } : null,
    },
    zoneC: {
      view: input.canvasView,
      selected_node: input.canvasSelected,
      workflow_nodes: (p?.workflows.workflows ?? []).map((w) => ({ id: w.id, name: w.name })),
      workflow_templates: Object.keys(p?.workflows.count_by_group ?? {}),
      devices: (p?.datasets.datasets ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.mode,
        online: false,
      })),
      bench_status: {
        busy: input.benchBusy,
        user: input.benchUser,
        interlock_pending: input.interlockPending,
      },
    },
    lastRun,
    // 轮次产物与历史轮次尚无存储，第一版为 null（任务卡第 5 条已明写可为 null）
    history: null,
    kb: {
      hits: [],
      index_summary: {
        documents: p?.documents.total ?? 0,
        experiences: p?.experience.count ?? 0,
        by_type: p?.documents.count_by_type ?? {},
      },
      conversion_status: p?.documents.conversion_status_legend ?? {},
      experience_summary: {
        count: p?.experience.count ?? 0,
        evidence_levels: p?.experience.evidence_levels ?? {},
      },
      unclassified: [],
    },
    policy: {
      permission: 'readonly',
      auto_run: true,
      redline_actions: REDLINE,
    },
  }
}

/** JSON 指针取值（只用到 /a/b 这一档，够覆盖 context_requires 的写法） */
export function pointer(env: Envelope, ptr: string): unknown {
  let cur: unknown = env
  for (const seg of ptr.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 缺哪些上下文字段。null 与 undefined 算缺，空数组不算缺。 */
export function missingContext(def: ActionDef, env: Envelope): string[] {
  return def.context_requires.filter((ptr) => {
    const v = pointer(env, ptr)
    return v === null || v === undefined
  })
}

/** 缺字段时按钮悬停提示：缺什么、去哪补 */
const WHERE: Record<string, string> = {
  '/lastRun/artifacts': '先在流程 3 跑完一轮（跑完后给的是回放态产物索引，不是台架落盘文件）',
  '/history/runs': '历史轮次索引（轮次存储尚未实现，至少跑过两轮才能比）',
  '/zoneB/selected_document': '先在知识库页选中一份文档',
  '/zoneB/selected_fail_item': '先在 B 区选中一条未达标项',
  '/zoneB/selected_candidate': '先在流程 4 的推荐参数里勾选至少一条候选改动',
  '/zoneB/firmware_project': '先在流程 1 指定驱动工程目录',
  '/zoneB/report_template': '先在流程 5 载入报告模板',
  '/session/transcript_summary': '先与助手对话至少一轮（本会话对话摘要由对话轮数推出）',
  '/lastRun/precheck': '先跑一次预检',
  '/lastRun/verdicts': '先跑完一轮测试',
  '/lastRun/failed_items': '先跑完一轮测试',
}

export function missingHint(missing: string[]): string {
  return missing.map((m) => WHERE[m] ?? m).join('；')
}

export function withAction(env: Envelope, def: ActionDef, confirmed: boolean): Envelope {
  return { ...env, action: { button_id: def.id, type: def.type, confirmed } }
}
