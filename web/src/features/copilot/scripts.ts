import type { FlowId } from '../../data/types'
import type { EvidenceItem } from '../agent-chat'
import { sourceLine, type RawPack } from '../scene/pack'
import type { Step } from './adapter'

/* ===========================================================================
   六条流程各一段短脚本。

   数值、路径、条目名全部从当前场景包取，脚本本身不带任何产品知识——
   换场景包时这里一个字都不用改，助手说的数会跟着换。凡是场景包里没有的东西
   一律不提，宁可少说一句，也不拿上一个场景的结论套到这个场景上。
   =========================================================================== */

function ev(id: string, kind: EvidenceItem['kind'], title: string, excerpt: string, src: string): EvidenceItem {
  const [file, loc] = src.split('（')
  return {
    id,
    kind,
    title,
    excerpt,
    source: file,
    locator: loc ? loc.replace(/）$/, '') : '—',
  }
}

export function scriptFor(flow: FlowId, p: RawPack): Step[] {
  const exps = p.experience.experiences
  const gate = p.interlocks.interlocks.filter((i) => i.type === '人员' || i.type === '流程')
  const tuneExps = exps.filter((e) => e.tags.flow?.startsWith('F5'))
  const topExp = tuneExps[0] ?? exps[0]
  const holes = p.attributes.attributes.filter((a) => a._placeholder)
  const na = p.attributes.attributes.filter((a) => a.not_applicable)

  switch (flow) {
    case 'init':
      return [
        {
          kind: 'say',
          text: `本体属性 ${p.attributes.attributes.length} 项已从客户工程读出，其中 ${holes.length} 项是占位、${na.length} 项不适用。源材料没写的一律留空不编。`,
        },
        {
          kind: 'tool',
          callId: 'init-1',
          name: 'attributes_load',
          title: '读取本体属性',
          args: { groups: p.attributes.groups, count: p.attributes.attributes.length },
          argsSummary: `按 ${p.attributes.groups.length} 个分组读 product-attributes.json`,
          durationMs: 610,
          resultSummary: `本体属性 ${p.attributes.attributes.length} 项，占位 ${holes.length} 处，不适用 ${na.length} 项`,
          result: {
            attributes: p.attributes.attributes.length,
            placeholders: holes.map((a) => a.name),
            notApplicable: na.map((a) => a.name),
          },
        },
        {
          kind: 'say',
          text: `${holes.length ? `占位的 ${holes.length} 项（${holes.slice(0, 3).map((a) => a.name).join('、')}${holes.length > 3 ? ' 等' : ''}）源材料确实没给，已标「待确认」，需要向客户索取，不要拿占位值当真值用。` : '没有占位项。'}${na.length ? ` ${na.map((a) => a.name).join('、')} 在本产品上不适用——${na[0].note?.slice(0, 48) ?? '控制器不需要这个量'}，所以标「不适用」而不是留空。` : ''}`,
        },
      ]

    case 'req':
      return [
        {
          kind: 'say',
          text: `判据 ${p.requirements.requirements.length} 条按 ${p.requirements.categories.length} 类列出，可自动求值 ${p.requirements.evaluable_count} 条。我先对一遍判据与工作流步骤。`,
        },
        {
          kind: 'tool',
          callId: 'req-1',
          name: 'criteria_extract',
          title: '判据抽取',
          args: { source: 'test-requirements.json', categories: p.requirements.categories.length },
          argsSummary: `按 ${p.requirements.categories.length} 类抽判据`,
          durationMs: 1180,
          resultSummary: `判据 ${p.requirements.requirements.length} 条，可自动求值 ${p.requirements.evaluable_count} 条、只能人工判 ${p.requirements.not_evaluable_count} 条`,
          result: { total: p.requirements.requirements.length, categories: p.requirements.categories },
        },
        {
          kind: 'tool',
          callId: 'req-2',
          name: 'workflow_index',
          title: '工作流库检索',
          args: { source: p.caps.workflowSource, total: p.workflows.total },
          argsSummary:
            p.caps.workflowSource === 'pack-assets'
              ? '读场景包自带的 assets/workflows/*.json'
              : '读 public/data 下的归档 .wfw',
          durationMs: 420,
          resultSummary: `库内 ${p.workflows.total} 条，分 ${Object.keys(p.workflows.count_by_group).length} 组${p.workflows.all_placeholder ? '，全部是示例占位' : ''}`,
          result: { total: p.workflows.total, byGroup: p.workflows.count_by_group },
        },
        {
          kind: 'say',
          text: `${p.requirements.not_evaluable_count} 条判据写不出布尔表达式——排程规则与目视检查那一类，标准本身就没给可测量的量，不硬凑。${p.workflows.all_placeholder ? '工作流这边一条真实文件都没有，4 条示例是本包自建的骨架，跑之前要按现场台架重做。' : ''}`,
        },
      ]

    case 'run':
      return [
        {
          kind: 'say',
          text: `控制参数 ${p.controls.parameters.length} 项已载入，安全确认闸门 ${gate.length} 条未全绿前「启动测试」保持置灰。我先跑预检再回放时序，启动属改动类动作，我不点。`,
        },
        {
          kind: 'tool',
          callId: 'run-1',
          name: 'precheck',
          title: '预检自检',
          args: { items: gate.slice(0, 3).map((g) => g.id) },
          argsSummary: `硬件项自检 + ${gate.length} 条人工闸门清点`,
          durationMs: 2260,
          resultSummary: `硬件项通过，安全确认闸门 ${gate.length} 条待人工逐条确认`,
          result: { hardware: 'ok', pendingGates: gate.map((g) => g.id) },
        },
        {
          kind: 'tool',
          callId: 'run-2',
          name: 'test_start',
          title: '启动测试',
          args: { gates: gate.length },
          argsSummary: '改动类动作，闸门全绿后由人点',
          mutating: true,
          durationMs: 0,
          resultSummary: '（需人工确认）',
          result: {},
        },
        {
          kind: 'tool',
          callId: 'run-3',
          name: 'waveform_replay',
          title: '时序回放与取指标',
          args: {
            datasets: p.datasets.datasets.map((d) => d.id),
            rate: p.datasets.datasets[0]?.sample_rate_sa_per_s ?? null,
          },
          argsSummary: `回放 ${p.datasets.datasets.length} 条登记时序`,
          durationMs: 3120,
          resultSummary: p.caps.syntheticData
            ? `${p.datasets.datasets.length} 条全部是合成数据，不是实测`
            : `${p.datasets.datasets.length} 条实测时序`,
          result: { synthetic: p.caps.syntheticData, datasets: p.datasets.datasets.map((d) => d.id) },
        },
        {
          kind: 'say',
          text: `判定这一步我给不出结论：判据要的现场实测量本轮一个都没采到。缺什么已逐条列在判定卡上，不拿别的量顶替。${p.caps.syntheticData ? ` ${p.caps.syntheticBanner}` : ''}${p.caps.probeUnconfirmed ? ` ${p.caps.probeNote}` : ''}`,
        },
        {
          kind: 'evidence',
          items: [
            ev(
              'run-ev-1',
              'case',
              p.datasets.datasets[0]?.name ?? '本场景登记的时序数据',
              p.datasets.datasets[0]?.note ?? '',
              sourceLine(p.datasets.datasets[0]?._source),
            ),
          ],
        },
      ]

    case 'tune':
      return [
        {
          kind: 'say',
          text: `经验库 ${exps.length} 条里有 ${tuneExps.length} 条属调优流程。我按判定结果归因，只推能在本包控制参数里按宏名对上的候选。`,
        },
        {
          kind: 'tool',
          callId: 'tune-1',
          name: 'experience_search',
          title: '经验检索',
          args: { flow: 'F5', parameters: topExp?.tags.parameters ?? [] },
          argsSummary: '按流程与参数名检索经验库',
          durationMs: 760,
          resultSummary: `命中 ${tuneExps.length} 条 F5 经验${topExp ? `，首选 ${topExp.id}（${topExp.evidence_level}）` : ''}`,
          result: { hits: tuneExps.map((e) => e.id) },
        },
        topExp
          ? {
              kind: 'say',
              text: `${topExp.id} 给的动作是：${topExp.action}`,
            }
          : { kind: 'say', text: '经验库里没有能对上本场景参数名的 F5 条目，这一轮我不给推荐。' },
        {
          kind: 'evidence',
          items: topExp
            ? [ev('tune-ev-1', 'procedure', `${topExp.id} · ${topExp.evidence_level}`, topExp.cause, sourceLine(topExp._source))]
            : [],
        },
        { kind: 'say', text: '候选按能否给出具体数值排队，一次只动一项。采纳与写回都要你点，我不写回也不触发重跑。' },
      ]

    case 'report':
    default:
      return [
        {
          kind: 'say',
          text: `报告模板表头 ${p.report.header_fields.length} 字段，我按模板填一遍。填不上的字段单独列出来，不编。`,
        },
        {
          kind: 'tool',
          callId: 'rep-1',
          name: 'template_fill',
          title: '模板填充',
          args: { template: p.report.template_file, sections: p.report.spec_sections.length },
          argsSummary: `表头 ${p.report.header_fields.length} 字段 + 分节 ${p.report.spec_sections.length} 节`,
          durationMs: 1540,
          resultSummary: `可由上游流程带入 ${p.report.header_fields.filter((f) => !f.from_flow.startsWith('F6')).length} 项，需本流程补全 ${p.report.header_fields.filter((f) => f.from_flow.startsWith('F6')).length} 项`,
          result: {
            header: p.report.header_fields.map((f) => ({
              name: f.name,
              labelSlot: f.label_slot,
              valueSlot: f.value_slot,
              section: f.label_section ?? null,
              from: f.from_flow,
            })),
          },
        },
        {
          kind: 'say',
          text: `字段定位统一成「一个标题位 + 一个取值位」，Excel 模板与 PDF 样张共用同一套填充逻辑。图片位共 ${p.report.artifact_groups.reduce((a, b) => a + b.count, 0)} 张。${p.caps.syntheticData ? '注意：本场景时序全部是合成数据，按场景包的流程联锁，不得进入任何合规报告。' : ''}导出与归档要你点，我不做。`,
        },
      ]
  }
}
