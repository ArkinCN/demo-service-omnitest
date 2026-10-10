import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Braces,
  Cpu,
  Download,
  FileSpreadsheet,
  FileText,
  Images,
  LayoutList,
  Mail,
  Waves as WavesIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Collapsible,
  EmptyState,
  InfoTip,
  Input,
  Modal,
  SourceTag,
  Tooltip,
  cn,
} from '../../components/ui'
import { collapseKey, useAppStore } from '../../state/useAppStore'
import { useFlowActions } from '../redline'
import { assembleReport } from './assemble'
import {
  downloadUrl,
  persistReportInstance,
  reportExists,
  resolveReportRunId,
  templateStatus,
  uploadTemplate,
} from './reportApi'
import { getPack, fileName, sizeText, type RawHeaderField } from '../scene/pack'
import { ConfigOverview } from '../../app/LeftPanel'
import { UnifiedConfigPanel } from '../../app/UnifiedConfigPanel'
import { ConfirmFooter, Empty } from '../shared/bits'
import { buildTiers, demoFilter, readTiers } from '../shared/tiers'
import { simp } from '../shared/zh'
import { TimeSeriesChart } from '../timeseries'
import { loadWaves, type Wave } from '../waveforms'
import { evaluateAll, runtimeMeasures } from '../flow-run/evaluate'

/* ===========================================================================
   流程 6 · 测试报告及产出（v2 视觉）
   左栏：模板选择 + 表头 10 字段（上游带入 6 / 本流程补全 4）+ 导出格式
   卡片：报告预览（hero，三页纸样）/ 产物留档 / 判定汇总 / 历史对比 / 模板字段
   数据逻辑不动：字段定位仍是 label_cell → label_slot、value_cell → value_slot，
   上游字段一律留空显示「由上游带入」，不拿模板样张的 sample_value 顶真值。
   =========================================================================== */

/** 标签一律收到 6 字以内，全名进 tooltip */
function short(s: string, n = 6) {
  const clean = s.replace(/[（(].*$/, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/** 模板分节里的「上传模板文件」行：上传客户正式模板（.xlsm），覆盖式替换系统自建模板。 */
function TemplateUploadRow() {
  const [tpl, setTpl] = useState<{ ready: boolean; filename?: string; bytes?: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void templateStatus()
      .then((t) => { if (alive) setTpl(t) })
      .catch(() => { if (alive) setTpl({ ready: false }) })
    return () => { alive = false }
  }, [])

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = '' // 允许重复选同一个文件
    if (!f) return
    setBusy(true)
    const st = useAppStore.getState()
    try {
      const r = await uploadTemplate(f)
      setTpl({ ready: true, filename: r.filename, bytes: r.bytes })
      st.setNotice(`客户模板已上传（${r.filename}，${r.bytes} 字节），重新生成报告即为正式报告`)
    } catch (err) {
      st.setNotice(`模板上传失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5">
      <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-t1">
        {tpl?.ready ? '客户模板已就位' : '当前用系统自建模板'}
      </span>
      {tpl?.ready && (
        <span className="num truncate text-[12px] text-t3">
          {tpl.filename}（{sizeText(tpl.bytes ?? 0)}）
        </span>
      )}
      <span className="ml-auto shrink-0">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsm"
          className="hidden"
          onChange={onPick}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="num cursor-pointer rounded-tpx border border-line px-2 py-1 text-[12px] text-t1 transition-colors hover:bg-p50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? '上传中…' : tpl?.ready ? '替换模板' : '上传模板文件'}
        </button>
      </span>
    </div>
  )
}

/** 表头字段的短标签。英文位址字段用它的限定词（Inlet / Outlet）区分，全名进 tooltip。 */
const FIELD_SHORT: Record<string, string> = {
  model: '机型',
  inlet_start_addr: 'Inlet',
  outlet_start_addr: 'Outlet',
  bootloader: 'Boot',
  customer_engineer: '工程师',
}
/** 左栏与卡面用：模板字段名是繁体（客戶名稱 / 韌體版本…），界面一律归一成简体 */
const fieldShort = (f: RawHeaderField) => simp(FIELD_SHORT[f.key] ?? short(f.name))
/** 报告预览纸面用：照抄模板原文，不做简繁归一，纸面上另标「模板原文」 */
const rawFieldLabel = (f: RawHeaderField) => short(f.name, 6)

/* ------------------------------------------------- 跨卡片共享：表头 / 导出格式
 *
 * ⚠️ 2026-09-28 修 G-10：这两个原先都是**模块级变量**（`let header = {}` +
 * 自建订阅、`const fmt = { value }`），刷新即丢——与「其它已确认参数都持久」
 * 不一致，人会以为「填了表头没保存」。现全部指向 store，由 store 负责持久化。
 *
 * `useShared()` / `setHeader` / `setFmt` 的**签名保持不变**，只是内部换成 store，
 * 这样页面里十余处调用点一处都不用改（改动面最小、回归风险最低）。
 */

/** 表头（走 store，含 localStorage 持久化） */
function useShared(): Record<string, string> {
  return useAppStore((s) => s.reportHeader)
}
function setHeader(k: string, v: string) {
  useAppStore.getState().setReportHeader(k, v)
}

/**
 * 表头字段的初值：**只从场景包补一项 `firmware_version`**。
 *
 * 为什么只补这一项：它是「场景包里确有其值」的唯一一项（`controls.parameters`
 * 里含 version 的那个宏）。其余由上游流程带入的字段**不编**——那要真读
 * `config-snapshot`（见 `assemble.ts`，修 G-04），拿场景包登记值顶替会让人
 * 把「登记值」当成「本轮确认过的基线」，是两回事。
 *
 * 写进 store 而非模块变量（G-10）；**已经是空才写**，不覆盖上游装配或人填的值。
 */
function seed() {
  const pack = getPack()
  if (!pack) return
  const ver = pack.controls.parameters.find((p) => p.key.includes('version'))
  if (ver && ver.value !== null) {
    const st = useAppStore.getState()
    if (!st.reportHeader.firmware_version) {
      st.setReportHeader('firmware_version', String(ver.value))
    }
  }
}

const upstream = (f: RawHeaderField) => !f.from_flow.startsWith('F6')

/**
 * 上游装配（修 G-04）：进报告页时按 runId 把 `config-snapshot` 读回来填表头。
 *
 * 三条行为约定：
 *   一、**只在取到值时才写**（`mergeReportHeader` 只补不覆盖）；
 *   二、取不到**不报错、不静默**——把状态落进 `upstreamState`，界面据此显示
 *       「上游产物未取到」而不是继续显示误导性的「由上游带入」；
 *   三、**跑一次就够**（用 ref 防重复），避免每次重渲染都打后端。
 */
type UpstreamState = 'idle' | 'loading' | 'ok' | 'none'
/** 装配状态：模块级 + 自建订阅（与 store 里的 header 不同，这个**不需要持久化**——
 *  它是「本次进页面读到了什么」的瞬时状态，刷新后本来就该重算） */
const upstreamState: { state: UpstreamState; note: string } = { state: 'idle', note: '' }
const upListeners = new Set<() => void>()
const emitUp = () => upListeners.forEach((l) => l())
let triedRunId: string | null = null

function useUpstreamState(): { state: UpstreamState; note: string } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((v) => v + 1)
    upListeners.add(l)
    return () => {
      upListeners.delete(l)
    }
  }, [])
  return upstreamState
}

/** 供挂载点调用：按「本轮 or 最近一轮」装配一次 */
function useAssembleUpstream() {
  const runId = useAppStore((s) => s.runId)
  const sceneId = useAppStore((s) => s.sceneId)
  useEffect(() => {
    if (triedRunId === runId) return
    triedRunId = runId
    upstreamState.state = 'loading'
    emitUp()
    // ⚠️ 用 `resolveReportRunId` 兜底（与 gen-report / export 同款）：
    // 报告页与其它下游一样，不该因为"本会话没点过启动"就取不到上游基线。
    // 内存里没有 runId 时按场景取**最近一轮**（真实存在的轮次，不是编的）。
    void resolveReportRunId(sceneId, runId)
      .then((rid) => assembleReport(rid))
      .then((r) => {
        if (!r) {
          upstreamState.state = 'none'
          upstreamState.note = '上游产物没读到（该轮可能还没落 config-snapshot，或后端不可用）'
        } else if (Object.keys(r.header).length) {
          useAppStore.getState().mergeReportHeader(r.header)
          upstreamState.state = 'ok'
          upstreamState.note = `已从配置快照带入 ${Object.keys(r.header).length} 项（轮次 ${r.runId.slice(0, 8)}）`
        } else {
          upstreamState.state = 'none'
          upstreamState.note = `轮次 ${r.runId.slice(0, 8)} 的配置快照里没有报告表头字段（该轮快照可能只记了场景与时刻）`
        }
        emitUp()
      })
      .catch((e: unknown) => {
        upstreamState.state = 'none'
        upstreamState.note = e instanceof Error ? e.message : String(e)
        emitUp()
      })
  }, [runId, sceneId])
}

/** 模板全名可能是一条绝对路径（Excel 模板）或一句长标题（PDF 样张） */
function templateTitle(raw: string) {
  return (raw.startsWith('/') ? fileName(raw) : raw.split(/[，,。]/)[0]).slice(0, 64)
}

/* ------------------------------------------------------------------ 左栏 */

/** 分组图标：按一级类 / 二级组的标题取 */
const GROUP_ICON: [RegExp, LucideIcon][] = [
  [/身份|机型|固件$/, Cpu],
  [/位址|引导|基线/, Braces],
  [/交付|客户|联系/, Mail],
  [/标识|编号/, Archive],
  [/内容|标题|周期/, FileText],
  [/机构|合同|主办/, Archive],
]
const iconOf = (name: string, size = 14) => {
  let Ic: LucideIcon = LayoutList
  for (const [re, ic] of GROUP_ICON) {
    if (re.test(name)) {
      Ic = ic
      break
    }
  }
  return <Ic size={size} strokeWidth={1.9} />
}

function FieldRow({ f }: { f: RawHeaderField }) {
  const h = useShared()
  const up = upstream(f)
  const filled = !!h[f.key]
  const detail = (
    <span className="block space-y-1">
      <span className="block font-medium">{f.name}</span>
      <span className="num block opacity-75">
        标题位 {f.label_slot || '—'} → 取值位 {f.value_slot || '—'}
        {f.label_section ? ` · ${f.label_section}` : ''}
      </span>
      <span className="block opacity-75">{up ? `由 ${f.from_flow} 带入` : '本流程补全'}</span>
    </span>
  )

  return (
    <div className="flex min-h-[40px] items-center gap-2 px-4 py-1.5 transition-colors hover:bg-p50/60">
      <Tooltip className="min-w-0" content={detail}>
        <span className="flex min-w-0 items-center gap-1.5">
          <SourceTag source={up ? '文档' : filled ? '人工' : '建议'} />
          <span className="cursor-help truncate text-[13px] font-medium text-t1">{fieldShort(f)}</span>
        </span>
      </Tooltip>
      <span className="ml-auto shrink-0">
        {up ? (
          <span className={cn('num text-[13px]', filled ? 'text-t1' : 'text-t3')}>
            {h[f.key] || '由上游带入'}
          </span>
        ) : (
          <Input
            value={h[f.key] ?? ''}
            onChange={(e) => setHeader(f.key, e.target.value)}
            aria-label={f.name}
            placeholder="待填"
            className="h-[28px] w-[152px] text-[13px]"
          />
        )}
      </span>
    </div>
  )
}

/**
 * 「确认表头」的落库动作（2026-09-30 新增）。
 *
 * 语义与流程 2 的 `useConfirmBaseline` 一致：**单一入口、落库成功才置确认态、
 * 失败必须可见**。此前这颗按钮误绑到「生成报告」上（点确认=生成+下载），
 * 且表头只存 localStorage，从不落库、也不进生成的报告——本函数修的就是这条断裂。
 *
 * 三条纪律：
 *   一、**不触发生成、不触发下载**——确认与生成是两件事，生成由顶栏按钮负责；
 *   二、落库前 `resolveReportRunId` 兜底（同 gen-report），一轮都没有时抛可见错误；
 *   三、**不编值**：表头里空的项不落进 header（空 ≠ 确认了空），由后端显示「未提供」。
 */
function useConfirmReportHeader(opts: {
  sceneId: string
  header: Record<string, string>
  fields: { key: string; name: string; from_flow: string; value_slot: string }[]
}) {
  const { sceneId, header, fields } = opts
  const setNotice = useAppStore((s) => s.setNotice)
  const [saving, setSaving] = useState(false)

  const run = useCallback(async () => {
    setSaving(true)
    try {
      const st = useAppStore.getState()
      const { runId, instance } = await persistReportInstance({
        sceneId,
        runId: st.runId,
        header,
        fields,
        operator: st.benchUser,
      })
      st.setRunId(runId)
      st.confirmFlow('report')
      const n = Object.keys(instance.header).length
      setNotice(
        `已确认报告表头：${n}/${instance.header_total} 项有值（轮次 ${runId.slice(0, 8)}），` +
          `已写入轮次产物，生成报告时按此填写`,
      )
    } catch (e) {
      // 落库失败必须看得见：没存上是没存上，不能让人以为确认好了
      setNotice(
        `确认表头失败（未持久化，刷新后仍是未确认）：${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setSaving(false)
    }
  }, [sceneId, header, fields, setNotice])

  return { run, saving }
}

export function ReportLeftPanel() {
  const pack = getPack()
  seed()
  // G-04：进报告页时按 runId 把 config-snapshot 读回来填表头（取不到会落状态）
  useAssembleUpstream()
  const up = useUpstreamState()
  const h = useShared()
  const sceneId = useAppStore((s) => s.sceneId)
  const confirmed = !!useAppStore((s) => s.confirmed.report)
  const setNotice = useAppStore((s) => s.setNotice)
  const unconfirmFlow = useAppStore((s) => s.unconfirmFlow)

  // ⚠️ 所有 hook 必须无条件调用（铁律）：确认 hook 放在空值分支之前，
  // 依赖值缺省为空数组，`if (!pack) return` 只在 hook 之后做。
  const rawFields = pack?.report.header_fields ?? []
  const fieldDefs = rawFields.map((f) => ({
    key: f.key,
    name: f.name,
    from_flow: f.from_flow,
    value_slot: f.value_slot,
  }))
  const { run: confirmHeader, saving } = useConfirmReportHeader({
    sceneId,
    header: h,
    fields: fieldDefs,
  })

  // 整篇预览弹层：顶栏「预览」置的 flag 在这里落地渲染。
  // 离开报告页时清 flag——否则 flag 残留，下次进任何页面回来会「重进即弹」。
  const previewOpen = useAppStore((s) => s.reportPreviewOpen)
  const setPreviewOpen = useAppStore((s) => s.setReportPreviewOpen)
  useEffect(() => () => setPreviewOpen(false), [setPreviewOpen])

  // hook 全部就位后再做空值分支
  if (!pack) return <Empty text="场景包未加载" />

  const fields = pack.report.header_fields
  const mine = fields.filter((f) => !upstream(f))
  const left = mine.filter((f) => !h[f.key]).length
  const filled = fields.filter((f) => h[f.key]).length
  const raw = pack.report.template_file
  // 三层骨架取自场景包 report-template.json 的 group_tiers，不写死在代码里
  const tiers = buildTiers<RawHeaderField>(readTiers(pack.report), fields, (f) => f.key)
  // 模板分节 10 节按「由哪条流程写入」再分一层，不十行平铺（平铺规则一）
  const secGroups = (() => {
    const order: string[] = []
    const bag = new Map<string, typeof pack.report.spec_sections>()
    for (const sec of pack.report.spec_sections) {
      const k = `由${sec.from_flow.split(' ')[0]} 写入`
      if (!bag.has(k)) {
        bag.set(k, [])
        order.push(k)
      }
      bag.get(k)!.push(sec)
    }
    return order.map((k) => ({ title: k, items: bag.get(k)! }))
  })()

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line-soft px-4">
        <FileText size={17} strokeWidth={1.9} className="shrink-0 text-p700" />
        <h2 className="text-[16px] leading-none font-semibold tracking-tight text-t1">报告信息</h2>
        <span className="num text-[12px] text-t3">
          {filled}/{fields.length}
        </span>
        {left > 0 ? (
          <Badge tone="neutral" dot className="ml-auto">
            待补 {left}
          </Badge>
        ) : (
          <Badge tone="soft" dot className="ml-auto">
            已齐
          </Badge>
        )}
      </header>

      {/* G-04：上游装配状态**必须显示出来**。
          取不到时若继续显示「由上游带入」，人会以为「报告本来就该空」，
          而实际是没读到产物——两种情况的处置完全不同（一个要跑一轮，一个要查后端）。 */}
      {up.state !== 'idle' ? (
        <div
          className={
            'shrink-0 border-b px-4 py-[6px] text-[11.5px] ' +
            (up.state === 'ok'
              ? 'border-line-soft bg-p50/60 text-p700'
              : up.state === 'loading'
                ? 'border-line-soft bg-p50/40 text-t3'
                : 'border-warn/30 bg-warn-wash text-t2')
          }
        >
          {up.state === 'loading'
            ? '正在从上游产物带入表头…'
            : up.state === 'ok'
              ? `✔ ${up.note}`
              : `上游产物未取到：${up.note}`}
        </div>
      ) : null}

      <div className="fade-b min-h-0 flex-1 overflow-y-auto pb-2">
        {/* 模板选择 */}
        <div className="px-4 pt-3 pb-2">
          <Tooltip
            className="w-full min-w-0"
            content={
              <span className="block space-y-1">
                <span className="block font-medium">{raw}</span>
                {pack.report.filled_sample_file ? (
                  <span className="block opacity-75">已填样例 {pack.report.filled_sample_file}</span>
                ) : null}
                {pack.report.filler_tool ? (
                  <span className="num block opacity-75">{pack.report.filler_tool.cli}</span>
                ) : (
                  <span className="block opacity-75">{pack.report.template_note}</span>
                )}
              </span>
            }
          >
            <div className="surface-2 flex w-full min-w-0 cursor-help items-center gap-2.5 overflow-hidden px-3 py-2.5">
              <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-tpx bg-p700 text-white [&>svg]:block">
                <FileSpreadsheet size={17} strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-t1">
                  {templateTitle(raw)}
                </span>
                <span className="num block truncate text-[12px] text-t3">
                  {pack.report.sheets.length
                    ? `${pack.report.sheets.length} 分页 · ${pack.report.spec_sections.length} 节`
                    : `${pack.report.spec_sections.length} 节`}
                </span>
              </span>
              <Badge tone="soft" mono>
                {pack.scene.generated_at ?? 'v1'}
              </Badge>
            </div>
          </Tooltip>
        </div>

        {/* 表头三层（06b 第 2.2 节）：被测件身份 / 固件位址基线 / 交付对象。
            分组维度是「这一格填错了，谁会先发现、会出什么事」，只展开第一层。 */}
        <ConfigOverview
          key={pack.scene.id}
          count={fields.length}
          quick={
            <>
              {(mine.length ? mine : fields).slice(0, 3).map((f) => (
                <div className="config-quick-card" key={f.key}>
                  <FieldRow f={f} />
                </div>
              ))}
            </>
          }
        >
          <UnifiedConfigPanel
            flow="report"
            tiers={tiers}
            // 一级类只展开第一个「被测件身份」，位址基线与交付对象默认折叠
            defaultOpen={0}
            itemKey={(f) => f.key}
            render={(f) => <FieldRow f={f} />}
            flags={(f) => ({ filled: !!h[f.key], pending: upstream(f) && !h[f.key] })}
            tierIcon={(t) => iconOf(t, 15)}
            groupIcon={(t) => iconOf(t)}
          />
        </ConfigOverview>

        {/* 模板分节：表头之外的正文由这几节构成 */}
        <Collapsible
          level={1}
          icon={<LayoutList size={15} strokeWidth={1.9} />}
          title="模板分节"
          storeKey={collapseKey('report', 'rp-sec')}
          defaultOpen={false}
          stat={{ total: pack.report.spec_sections.length }}
        >
          <TemplateUploadRow />
          {secGroups.map((grp, gi) => (
            <Collapsible
              key={grp.title}
              level={2}
              icon={<LayoutList size={14} strokeWidth={1.9} />}
              title={grp.title}
              storeKey={collapseKey('report', `rp-sec-${gi}`)}
              defaultOpen={gi === 0}
              stat={{ total: grp.items.length }}
            >
          {grp.items.map((sec) => (
            <Tooltip
              key={sec.section}
              className="block w-full"
              content={
                <span className="block space-y-1">
                  <span className="block font-medium">{simp(sec.section)}</span>
                  <span className="num block opacity-75">
                    {sec.rows} · 由 {sec.from_flow} 写入
                  </span>
                  <span className="block opacity-75">{sec.fields.map(simp).join(' · ')}</span>
                </span>
              }
            >
              <span className="flex min-h-[40px] w-full cursor-help items-center gap-2 px-4 py-1.5 transition-colors hover:bg-p50/60">
                <SourceTag source={sec.from_flow.startsWith('F6') ? '建议' : '文档'} />
                <span className="truncate text-[13px] font-medium text-t1">
                  {sectionShort(sec.section)}
                </span>
                <span className="num ml-auto shrink-0 text-[13px] font-semibold text-t1">
                  {sec.fields.length}
                  <span className="ml-1 text-[12px] font-normal text-t3">字段</span>
                </span>
              </span>
            </Tooltip>
          ))}
            </Collapsible>
          ))}
        </Collapsible>
      </div>

      {/* ──────── 唯一的「确认表头」入口（2026-09-30）───────
          此前这颗按钮的 onClick 直接绑 `bind('gen-report').onClick`——点确认表头
          等于点生成报告（生成+下载），而且表头只存 localStorage、从不落库、
          也不进生成的报告。现改为：**落 report-instance(confirmed) 产物 + 置确认态**，
          不触发生成、不下载。生成报告仍由顶栏「生成报告」承担（一步到位自动下载）。
          确认后变「解除确认」，与流程 1/2 的形态一致（反悔出口保留）。 */}
      {confirmed ? (
        <ConfirmFooter
          label="解除确认"
          count={fields.length}
          unit="项"
          variant="secondary"
          icon="unlock"
          hint={`表头已确认并写入轮次产物（${filled}/${fields.length} 项有值）。点此解除后可继续修改；生成报告时按确认值填写表头。`}
          onClick={() => {
            unconfirmFlow('report')
            setNotice('已解除确认：可继续修改表头，改完再点「确认表头」')
          }}
        />
      ) : (
        <ConfirmFooter
          label={saving ? '确认中…' : '确认表头'}
          count={fields.length}
          unit="项"
          onClick={() => void confirmHeader()}
          hint={
            (left === 0
              ? `表头 ${fields.length} 项已补全。`
              : `表头 ${fields.length} 项，本流程还差 ${left} 项未填；未填字段一律留空，不编。`) +
            '点击后写入轮次产物（生成报告时按此填写表头），不会触发生成。'
          }
        />
      )}

      {/* 整篇报告预览弹层（顶栏「预览」打开）。复用 FullReport（按模板节结构渲染，
          读 store 里已确认/已装配的表头与真判定行），与卡片放大态同一份实现，
          不另写一套预览。Modal 走 portal，不受左栏布局裁剪。 */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="报告预览"
        meta="按模板节结构渲染 · 非最终成稿"
        width={880}
      >
        <div className="max-h-[70vh] overflow-y-auto bg-p50 p-3">
          <FullReport />
        </div>
      </Modal>
    </div>
  )
}

/* -------------------------------------------------------------- 公共取数 */

function useWaves() {
  const pack = getPack()
  const [w, setW] = useState<Wave[]>([])
  useEffect(() => {
    let alive = true
    void loadWaves().then((x) => alive && setW(x))
    return () => {
      alive = false
    }
  }, [pack])
  // 演示主线只回放一失败一成功两条，与流程 3、流程 4 同一口径
  return pack ? demoFilter(pack.datasets, 'datasets', w, (x) => x.id) : w
}

const STATE_TEXT: Record<string, string> = {
  pass: '通过',
  fail: '不通过',
  missing: '未采集',
  manual: '人工判',
  // 2026-10-08 新增第五态；缺了这一项会让报告页显示 undefined
  not_applicable: '本台架不适用',
}

/** 判定行：走和流程 4 同一套求值，不另写一份口径 */
/** 判定口径与流程 3、流程 4 同一套；演示模式下同样只统计 demo_profile 点名的判据 */
function useVerdictRows() {
  const pack = getPack()
  const waves = useWaves()
  // 采纳/人工改过的控制参数：判定口径与流程 3/4 一致（读采纳值，不读场景包原值）。
  // ⚠️ hook 必须放在提前 return 之前（Hooks 规则）。
  const overrides = useAppStore((s) => s.overrides)
  const snapshotValues = useAppStore((s) => s.snapshotValues)
  // 本轮台架实测（2026-10-08 补）：报告页原先只吃离线回放波形，**不读本轮实测**，
  // 于是流程 3/4 判出的通过项到了报告页又变回「未采集」——同一轮出现两套结论，
  // 且报告是唯一对外产物，结论不一致等于报告不可信。
  // 并入 runMeasures 后与流程 3/4 完全同口径（本轮实测优先，回放波形只作兜底）。
  const runMeasures = useAppStore((s) => s.runMeasures)
  if (!pack) return []
  // 判定口径与流程 3、流程 4 同一套：runtimeMeasures 少传 pack 会漏掉
  // datasets.json 里 package_stats 登记的批次量，报告页的通过数会比另两页少一截
  const all = evaluateAll(
    pack,
    { ...runtimeMeasures(waves, pack), ...runMeasures },
    overrides,
    snapshotValues,
  )
  return demoFilter(pack.requirements, 'requirements', all, (r) => r.req.id)
}

/** 横向分段条：只用墨绿明度 + 一处暗红，不引第三色相 */
function StackBar({ seg }: { seg: { n: number; cls: string; title: string }[] }) {
  const total = seg.reduce((a, b) => a + b.n, 0) || 1
  return (
    <span className="flex h-[7px] w-full overflow-hidden rounded-full bg-p100">
      {seg.map((s) => (
        <span
          key={s.title}
          title={`${s.title} ${s.n}`}
          className={cn('block h-full', s.cls)}
          style={{ width: `${(s.n / total) * 100}%`, transition: 'width .5s cubic-bezier(.22,.75,.3,1)' }}
        />
      ))}
    </span>
  )
}

/* ------------------------------------------------- 卡片 · 报告预览（hero） */

/** 波形缩略：报告图位里的一张小图，只画轮廓，不带坐标轴 */
function MiniWave({ w, h = 34 }: { w: Wave; h?: number }) {
  const d = useMemo(() => {
    const ys = w.series.y as ArrayLike<number>
    const n = ys.length
    if (!n) return ''
    const step = Math.max(1, Math.floor(n / 220))
    let lo = Infinity
    let hi = -Infinity
    const pts: number[] = []
    for (let i = 0; i < n; i += step) {
      const v = ys[i]
      pts.push(v)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    const span = hi - lo || 1
    return pts
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (pts.length - 1)) * 100).toFixed(2)} ${(30 - ((v - lo) / span) * 30).toFixed(2)}`)
      .join(' ')
  }, [w])

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      style={{ height: h }}
      className="block w-full"
      aria-hidden
    >
      <path d="M0 15 H100" stroke="var(--tp-line-soft)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      <path
        d={d}
        fill="none"
        stroke="var(--p-600)"
        strokeWidth="1.1"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SheetTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="block shrink-0 border-l-2 border-p700 pl-1.5 text-[12px] leading-none font-semibold text-t1">
      {children}
    </span>
  )
}

/** 卡体高度随视口缩放：矮到放不下页脚时切紧凑排，不把纸面挤成三条标题。 */
function useBoxHeight() {
  const [h, setH] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    const obs = new ResizeObserver(() => setH(el.clientHeight))
    obs.observe(el)
    ro.current = obs
    setH(el.clientHeight)
  }, [])
  return [ref, h] as const
}

/**
 * 一页纸样的预览：浅绿衬底上浮一张白纸，纸面分三栏——表头、波形图位、判定表，
 * 页脚给模板名与页码。A4 竖版按卡体高度缩放后只有 140 px 宽，字全部要压到 9 px
 * 以下，所以这里按「横开的一页」排，宁可不守 A4 比例，也不破 12 px 字号下限。
 */
function ReportPreview({ full }: { full?: boolean }) {
  const pack = getPack()
  seed()
  const h = useShared()
  const waves = useWaves()
  const rows = useVerdictRows()
  const [box, boxH] = useBoxHeight()
  if (!pack) return <Empty text="场景包未加载" />
  if (full) return <FullReport />
  const compact = boxH > 0 && boxH < 180

  const raw = pack.report.template_file
  const title = templateTitle(raw)
  const fields = pack.report.header_fields.slice(0, 6)
  const verdicts = rows.slice(0, 5)
  const shots = Object.values(pack.report.waveform_image_slots?.counted_images ?? {}).reduce(
    (a, b) => a + b,
    0,
  )

  const mask = {
    maskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
  }

  return (
    <div
      ref={box}
      className={cn(
        'surface-2 relative flex h-full min-h-0 w-full flex-col',
        compact ? 'p-1.5' : 'p-2.5',
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col rounded-tpx border border-line bg-white shadow-[0_1px_2px_rgba(31,42,36,.05),0_10px_26px_rgba(31,42,36,.06)]',
          compact ? 'px-3.5 py-2' : 'px-5 py-3',
        )}
      >
        {/* 报告标题区 */}
        <div
          className={cn(
            'flex shrink-0 items-baseline gap-2 border-b border-p700',
            compact ? 'pb-1.5' : 'pb-2',
          )}
        >
          <Tooltip content={raw}>
            <span
              className={cn(
                'cursor-help truncate font-semibold tracking-tight text-t1',
                compact ? 'text-[13px]' : 'text-[14px]',
              )}
            >
              {title}
            </span>
          </Tooltip>
          <span className="num shrink-0 text-[12px] text-t3">{pack.scene.generated_at}</span>
          {pack.caps.syntheticData ? (
            <Badge tone="warn" className="ml-auto" title={pack.caps.syntheticBanner}>
              合成
            </Badge>
          ) : null}
        </div>

        {/* 纸面三栏 */}
        <div
          className={cn('grid min-h-0 flex-1', compact ? 'gap-3 pt-1.5' : 'gap-5 pt-2.5')}
          style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr) minmax(0,0.85fr)' }}
        >
          {/* 表头 */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <span className="flex shrink-0 items-baseline gap-1.5">
              <SheetTitle>表头</SheetTitle>
              <span className="shrink-0 text-[12px] text-t3" title="这一列的字段名照抄模板原文，模板本身是繁体，界面其余各处一律用简体">
                模板原文
              </span>
            </span>
            <ul className="no-scrollbar min-h-0 flex-1 overflow-hidden" style={mask}>
              {fields.map((f) => (
                <li
                  key={f.key}
                  className="flex items-baseline gap-2 border-b border-line-soft py-[3px] last:border-b-0"
                >
                  <span className="shrink-0 text-[12px] text-t3">{rawFieldLabel(f)}</span>
                  <span
                    className={cn(
                      'num ml-auto truncate text-[12px]',
                      h[f.key] ? 'text-t1' : 'text-t3',
                    )}
                  >
                    {h[f.key] || (upstream(f) ? '上游带入' : '待填')}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 波形图位 */}
          <div
            className={cn(
              'flex min-h-0 flex-col gap-1.5 border-l border-line-soft',
              compact ? 'pl-3' : 'pl-5',
            )}
          >
            <SheetTitle>波形图位</SheetTitle>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden" style={mask}>
              {waves.slice(0, 2).map((w) => (
                <figure key={w.id} className="m-0 shrink-0">
                  <span className="block rounded-tpx bg-p50/50 px-1 py-0.5">
                    <MiniWave w={w} h={compact ? 18 : 22} />
                  </span>
                  <figcaption className="num truncate pt-[3px] text-[12px] text-t3">
                    {w.id} · 峰值 {w.metrics.peak.toFixed(2)} {w.unit}
                  </figcaption>
                </figure>
              ))}
              {waves.length === 0 ? (
                <span className="text-[12px] text-t3">读取时序</span>
              ) : null}
            </div>
          </div>

          {/* 判定表片段 */}
          <div
            className={cn(
              'flex min-h-0 flex-col gap-1.5 border-l border-line-soft',
              compact ? 'pl-3' : 'pl-5',
            )}
          >
            <SheetTitle>判定表</SheetTitle>
            <ul className="no-scrollbar min-h-0 flex-1 overflow-hidden" style={mask}>
              {verdicts.map((r) => (
                <li
                  key={r.req.id}
                  className="flex items-baseline gap-2 border-b border-line-soft py-[3px] last:border-b-0"
                >
                  <span className="truncate text-[12px] text-t1">{short(r.req.name, 7)}</span>
                  <span
                    className={cn(
                      'num ml-auto shrink-0 text-[12px]',
                      r.state === 'fail' ? 'text-alert' : 'text-t3',
                    )}
                  >
                    {STATE_TEXT[r.state]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 页脚：矮版让位给纸面内容 */}
        <div
          className={cn(
            'num shrink-0 items-center gap-2 border-t border-line-soft pt-1.5 text-[12px] text-t3',
            compact ? 'hidden' : 'flex',
          )}
        >
          <span className="truncate">{fileName(raw)}</span>
          <span className="ml-auto shrink-0">
            首页 / 共 {pack.report.sheets.length || pack.report.spec_sections.length} 页 · 图位{' '}
            {shots}
          </span>
        </div>
      </div>

      {/* 卡头右侧是壳层的「放大」。这里只留「下载报告文件」——取回已生成的文件，
          非破坏性，不弹卡、直接下。原先并排还有一颗「导出」（红线动作）已删除：
          「生成报告」成功后已自动下载，导出是重复的第二入口（2026-09-30 用户口径）。 */}
      <span className="absolute top-1 right-1 flex items-center gap-1">
        <Tooltip content="下载报告文件（取回已生成的文件，无需确认）">
          <button
            type="button"
            aria-label="下载报告"
            data-action="download-report"
            onClick={async () => {
              const st = useAppStore.getState()
              try {
                const rid = await resolveReportRunId(st.sceneId, st.runId)
                const ok = await reportExists(rid)
                if (!ok) {
                  st.setNotice('报告还没生成，先点顶栏「生成报告」（生成后会自动下载）')
                  return
                }
                const a = document.createElement('a')
                a.href = downloadUrl(rid)
                a.download = ''
                document.body.appendChild(a)
                a.click()
                a.remove()
              } catch (e) {
                st.setNotice(`下载失败：${e instanceof Error ? e.message : String(e)}`)
              }
            }}
            className="flex h-[24px] w-[24px] cursor-pointer items-center justify-center rounded-tpx bg-white/70 text-t3 transition-colors hover:bg-white hover:text-p700 [&>svg]:block"
          >
            <Download size={14} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </span>
    </div>
  )
}

/** 放大态：按模板节结构渲染的整篇预览 */
function FullReport() {
  const pack = getPack()
  const h = useShared()
  const waves = useWaves()
  const rows = useVerdictRows()
  if (!pack) return <Empty text="场景包未加载" />
  const pt = pack.report.performance_table
  const raw = pack.report.template_file

  return (
    <div className="h-full w-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[760px] bg-white px-5 py-4">
        <h1 title={raw} className="border-b border-p700 pb-1.5 text-center text-[16px] font-semibold text-t1">
          {templateTitle(raw)}
        </h1>
        <table className="mt-2.5 w-full border-collapse text-[12px]">
          <tbody>
            {pack.report.header_fields.map((f) => (
              <tr key={f.key} className="border-b border-line-soft">
                <td className="w-[34%] py-1 text-t3">
                  {f.name} <span className="num text-t3">{f.value_slot || '—'}</span>
                </td>
                <td className={cn('num py-1', h[f.key] ? 'text-t1' : 'text-t3')}>
                  {h[f.key] || (upstream(f) ? '由上游流程带入' : '待补全')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-4 border-l-2 border-p700 pl-2 text-[13px] font-semibold text-t1">
          分节 · {pack.report.spec_sections.length} 节
        </h2>
        {pack.report.spec_sections.map((s) => (
          <div key={s.section} className="border-b border-line-soft py-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] text-t1">{s.section}</span>
              <span className="num ml-auto text-[12px] text-t3">{s.rows}</span>
            </div>
            <p className="pt-0.5 text-[12px] leading-5 text-t2">{s.fields.join(' · ')}</p>
          </div>
        ))}

        {pt ? (
          <>
            <h2 className="mt-4 border-l-2 border-p700 pl-2 text-[13px] font-semibold text-t1">
              {pt.sheet} · 通過條件 {pt.pass_condition.length} 條
            </h2>
            <ul className="m-0 list-none p-0 pt-1">
              {pt.pass_condition.map((c) => (
                <li key={c.key} className="flex items-baseline gap-2 py-[2px] text-[12px]">
                  <span className="text-t1">{c.text}</span>
                  <span className="num ml-auto text-t3">{c.maps_to}</span>
                </li>
              ))}
            </ul>
            <table className="mt-2 w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line bg-p50">
                  {pt.columns.slice(0, 10).map((c) => (
                    <th
                      key={c.key}
                      className="px-1 py-1 text-left font-medium text-t2"
                      title={`${c.note ?? ''}${
                        c.scale_factor && c.scale_factor !== 1 ? ` · CSV 值 ×${c.scale_factor}` : ''
                      }`}
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pt.duty_rows.points.slice(0, 11).map((d, i) => (
                  <tr key={d} className="border-b border-line-soft">
                    {pt.columns.slice(0, 10).map((c, j) => (
                      <td key={c.key} className="num px-1 py-1 text-t3">
                        {j === 0 ? `${d}%` : i === 0 && j > 0 ? '—' : '待填'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <h2 className="mt-4 border-l-2 border-p700 pl-2 text-[13px] font-semibold text-t1">
          波形圖位
          {pack.caps.syntheticData ? (
            <span className="ml-2 rounded-full border border-warn/30 bg-warn-wash px-2 text-[12px] font-normal text-warn">
              合成数据，非实测
            </span>
          ) : null}
        </h2>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {waves.map((w) => (
            <figure key={w.id} className="m-0 rounded-tpx border border-line-soft p-1.5">
              <TimeSeriesChart
                series={[w.series]}
                showOverlayLabels={false}
                legend={false}
                cursor={false}
                zoom={false}
                height={110}
                xLabel=""
              />
              <figcaption className="num pt-1 text-[12px] text-t3">
                {w.id} · {w.verdictText} · 峰值 {w.metrics.peak.toFixed(2)} {w.unit}
              </figcaption>
            </figure>
          ))}
        </div>

        <h2 className="mt-4 border-l-2 border-p700 pl-2 text-[13px] font-semibold text-t1">判定表</h2>
        <table className="mt-1.5 w-full border-collapse text-[12px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.req.id} className="border-b border-line-soft">
                <td className="num w-[92px] py-1 text-t3">{r.req.id}</td>
                <td className="py-1 text-t1">{r.req.name}</td>
                <td
                  className={cn(
                    'num w-[72px] py-1 text-right',
                    r.state === 'fail' ? 'text-alert' : 'text-t3',
                  )}
                >
                  {STATE_TEXT[r.state]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {pack.report.conclusion_binding ? (
          <>
            <h2 className="mt-4 border-l-2 border-p700 pl-2 text-[13px] font-semibold text-t1">
              結論聚合規則
            </h2>
            <p className="pt-1 text-[12px] leading-5 text-t2">{pack.report.conclusion_binding.note}</p>
          </>
        ) : null}

        <p className="pt-3 text-[12px] leading-5 text-t3">
          预览按 report-template.json 的节结构渲染，不是最终成稿。模板全名：{raw}
          {pack.report.known_gap ? ` ${pack.report.known_gap.text}` : ''}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- 卡片 · 产物留档 */

function Artifacts({ full }: { full?: boolean }) {
  const bind = useFlowActions()
  const pack = getPack()
  const rows = useVerdictRows()
  useShared()
  if (!pack) return <Empty text="场景包未加载" />

  const inPack = pack.datasets.datasets.filter((d) => d.mode.includes('into_pack'))
  const registered = pack.datasets.datasets.filter((d) => !d.mode.includes('into_pack'))
  const csvBytes = inPack.reduce((a, d) => a + (d.file_size_bytes ?? 0), 0)
  const shots = Object.values(pack.report.waveform_image_slots?.counted_images ?? {}).reduce(
    (a, b) => a + b,
    0,
  )
  const synthetic = pack.caps.syntheticData

  const items = [
    {
      key: 'csv',
      icon: WavesIcon,
      name: '波形 CSV',
      meta: `${inPack.length} 份`,
      size: sizeText(csvBytes),
      ready: true,
      tip: `包内时序：${inPack.map((d) => fileName(d.file_path)).join('、')}。另有 ${registered.length} 份仅登记未入包（${registered
        .map((d) => `${fileName(d.file_path)} ${sizeText(d.file_size_bytes)}`)
        .join('、')}）。`,
      tag: synthetic ? '合成' : null,
    },
    {
      key: 'shot',
      icon: Images,
      name: '波形截图',
      meta: `图位 ${shots} 张`,
      size: '待采集',
      ready: false,
      tip: `模板三个电压分页的波形图位共 ${shots} 张：${Object.entries(
        pack.report.waveform_image_slots?.counted_images ?? {},
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}。截图由台架现场采集后按文件名规则插入。`,
      tag: null,
    },
    {
      key: 'json',
      icon: Braces,
      name: '判定 JSON',
      meta: `${rows.length} 条`,
      size: '待导出',
      ready: false,
      tip: '判定结果按 test-requirements.json 的判据逐条导出，口径与流程 4 的判定卡同源。',
      tag: null,
    },
    {
      key: 'report',
      icon: FileSpreadsheet,
      name: '报告文件',
      meta: 'report.xlsm',
      size: '未生成',
      ready: false,
      tip: pack.report.filler_tool
        ? `${pack.report.filler_tool.name}：${pack.report.filler_tool.cli}`
        : (pack.report.template_note ?? '按模板节结构生成'),
      tag: null,
    },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ul
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
        }}
      >
        {items.map((it) => {
          const Icon = it.icon
          return (
            <li key={it.key}>
              <Tooltip className="block w-full" content={it.tip}>
                <span className="flex w-full cursor-help items-center gap-2.5 border-b border-line-soft py-[7px] last:border-b-0">
                  <span
                    className={cn(
                      'flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-tpx [&>svg]:block',
                      it.ready ? 'bg-p50 text-p700' : 'bg-sunk text-t3',
                    )}
                  >
                    <Icon size={13} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 truncate text-[13px] font-medium text-t1">{it.name}</span>
                  <span className="num shrink-0 text-[12px] text-t3">{it.meta}</span>
                  {it.tag ? (
                    <Badge tone="warn" className="ml-auto" title={pack.caps.syntheticBanner}>
                      {it.tag}
                    </Badge>
                  ) : null}
                  <Badge tone={it.ready ? 'soft' : 'neutral'} mono className={it.tag ? '' : 'ml-auto'}>
                    {it.size}
                  </Badge>
                </span>
              </Tooltip>
            </li>
          )
        })}
      </ul>
      <div className="shrink-0 pt-2.5">
        {/* 归档是六条红线之一：点下去先弹确认卡，人再点一次才执行 */}
        <Button
          block
          size="sm"
          variant="secondary"
          data-action="archive-kb"
          onClick={bind('archive-kb').onClick}
          icon={<Archive size={13} strokeWidth={1.9} />}
        >
          归档到知识库
        </Button>
      </div>
      {full ? (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line-soft pt-2">
          {pack.datasets.datasets.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-2 border-b border-line-soft py-1.5 last:border-b-0"
              title={d.note ?? d.file_path}
            >
              <span className="num shrink-0 text-[12px] text-t3">{d.id}</span>
              <span className="truncate text-[12.5px] text-t1">{fileName(d.file_path)}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">
                {d.mode.includes('into_pack') ? sizeText(d.file_size_bytes) : '仅登记'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------- 卡片 · 判定汇总 */

function VerdictSummary({ full }: { full?: boolean }) {
  const pack = getPack()
  const rows = useVerdictRows()
  if (!pack) return <Empty text="场景包未加载" />
  const pass = rows.filter((r) => r.state === 'pass').length
  const fail = rows.filter((r) => r.state === 'fail').length
  const missing = rows.filter((r) => r.state === 'missing').length
  // 本台架不适用（2026-10-08）：与 missing 分开，不进通过/不通过
  const notApplicable = rows.filter((r) => r.state === 'not_applicable').length
  const judged = pass + fail
  // 不适用项排在未采集之前（有明确结论，已写明缺什么设备）
  const list = full
    ? rows
    : [
        ...rows.filter((r) => r.state === 'pass' || r.state === 'fail'),
        ...rows.filter((r) => r.state === 'not_applicable'),
        ...rows.filter((r) => r.state === 'missing'),
      ].slice(0, 6)

  const Stat = ({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'bad' | 'mute' }) => (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            tone === 'ok' ? 'bg-p600' : tone === 'bad' ? 'bg-alert' : 'bg-t3/40',
          )}
        />
        <span className="text-[12px] text-t3">{label}</span>
      </span>
      <span
        className={cn(
          'num text-[26px] leading-none font-semibold tracking-tight',
          tone === 'bad' && n > 0 ? 'text-alert' : 'text-t1',
        )}
      >
        {n}
      </span>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-start gap-2 pb-2.5">
        <Stat n={pass} label="通过" tone="ok" />
        <Stat n={fail} label="不通过" tone="bad" />
        {/* 有「本台架不适用」项时优先展示它：已写明缺什么设备，比笼统的未采集更利于决策 */}
        {notApplicable > 0 ? (
          <Stat n={notApplicable} label="本台架不适用" tone="mute" />
        ) : (
          <Stat n={missing} label="未采集" tone="mute" />
        )}
        <InfoTip
          content={`全表 ${rows.length} 条判据，可自动求值 ${pack.requirements.evaluable_count} 条，本轮已求值 ${judged} 条。${
            notApplicable
              ? `其中 ${notApplicable} 条为「本台架不适用」：需本台架未配置的测量手段（MCU 故障寄存器 / FG 转速信号 / 母线电流探头 / 程控电源等），逐条写明缺什么，不计入通过或不通过。`
              : ''
          }结论段按判定结果聚合，不自由撰写。`}
        />
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%)',
        }}
      >
        {list.map((r) => (
          <Tooltip
            key={r.req.id}
            className="w-full"
            content={`${r.req.criterion_text}${r.missing.length ? ` · 缺 ${r.missing.join('、')}` : ''}`}
          >
            <div className="flex w-full items-center gap-2 border-b border-line-soft py-[5px] last:border-b-0">
              <span
                className={cn(
                  'h-[6px] w-[6px] shrink-0 rounded-full',
                  r.state === 'pass' ? 'bg-p600' : r.state === 'fail' ? 'bg-alert' : 'bg-t3/35',
                )}
              />
              <span className="truncate text-[12.5px] text-t1">{short(r.req.name, 12)}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">{STATE_TEXT[r.state]}</span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------- 卡片 · 历史对比 */

/**
 * 「历史」不编：历史报告库尚未建立，这里对照的是场景包里确有其数的两个批次——
 * 20260811 启动故障实验批的标注结果，与本轮判定。口径差异写在 tooltip 里。
 */
function ReportHistory({ full }: { full?: boolean }) {
  const pack = getPack()
  const rows = useVerdictRows()
  if (!pack) return <Empty text="场景包未加载" />

  const st = pack.datasets.package_stats as Record<string, number | undefined>
  const hPass = Number(st.pass ?? 0)
  const hFail = Number(st.fail ?? 0)
  const hOther = Math.max(0, Number(st.attempts_total ?? 0) - hPass - hFail)
  const pass = rows.filter((r) => r.state === 'pass').length
  const fail = rows.filter((r) => r.state === 'fail').length
  // 本台架不适用（2026-10-08）：从「未采集」里拆出来，避免把"缺测量设备"说成"漏采"
  const na = rows.filter((r) => r.state === 'not_applicable').length
  const other = rows.length - pass - fail - na

  const batches = [
    {
      key: 'hist',
      name: '20260811 批',
      total: Number(st.attempts_total ?? hPass + hFail + hOther),
      pass: hPass,
      fail: hFail,
      other: hOther,
      na: 0,
      tip: `20260811_启动故障98次实验与30例对照数据包：登记 ${st.attempts_total ?? '—'} 次尝试，已标注 ${
        st.labeled ?? '—'
      } 次，通过 ${hPass}、不通过 ${hFail}、无效 ${st.invalid ?? 0}。这是实验批次的标注结果，不是历史报告——历史报告库尚未建立。`,
    },
    {
      key: 'now',
      name: '本轮',
      total: rows.length,
      pass,
      fail,
      other,
      na,
      tip: `本轮按 test-requirements.json 逐条求值：通过 ${pass}、不通过 ${fail}、未采集 ${other}${
        na ? `、本台架不适用 ${na}` : ''
      }。与历史批次口径不同（那批按单次启动尝试计，本轮按判据条目计）。`,
    },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col justify-center gap-3.5">
      {batches.map((b) => {
        const rate = b.total ? Math.round((b.pass / b.total) * 100) : 0
        return (
          <Tooltip key={b.key} className="block w-full" content={b.tip}>
            <span className="block w-full cursor-help">
              <span className="flex items-baseline gap-2 pb-1.5">
                <span className="truncate text-[13px] font-medium text-t1">{b.name}</span>
                <span className="num shrink-0 text-[12px] text-t3">{b.total}</span>
                <span className="num ml-auto shrink-0 text-[17px] leading-none font-semibold text-t1">
                  {rate}
                  <span className="text-[12px] font-normal text-t3">%</span>
                </span>
              </span>
              <StackBar
                seg={[
                  { n: b.pass, cls: 'bg-p600', title: '通过' },
                  { n: b.fail, cls: 'bg-alert', title: '不通过' },
                  // 不适用单独一段（中性灰），与「未判」分开，一眼可见缺的是设备不是数据
                  { n: b.na, cls: 'bg-t3/25', title: '本台架不适用' },
                  { n: b.other, cls: 'bg-p100', title: '未判' },
                ]}
              />
            </span>
          </Tooltip>
        )
      })}
      {full ? (
        <div className="min-h-0 flex-1 overflow-y-auto pt-2">
          {(pack.report.sheets.length
            ? pack.report.sheets.map((s) => ({
                k: s.name,
                v: `${s.max_row ?? '—'} 行 × ${s.max_column ?? '—'} 列${
                  s.image_count ? ` · 图 ${s.image_count}` : ''
                }`,
              }))
            : pack.report.spec_sections.map((s) => ({ k: s.section, v: s.rows }))
          ).map((r) => (
            <div key={r.k} className="flex items-center gap-2 border-b border-line-soft py-1.5">
              <span className="truncate text-[12.5px] text-t1">{r.k}</span>
              <span className="num ml-auto shrink-0 text-[12px] text-t3">{r.v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------- 卡片 · 模板字段 */

/** 节名取「、」之后的中文段，英文副名进 tooltip */
function sectionShort(s: string) {
  const body = s.includes('、') ? s.split('、')[1] : s
  return simp(short(body.replace(/[A-Za-z][A-Za-z /]*$/, '').trim(), 6))
}

function TemplateFields({ full }: { full?: boolean }) {
  const pack = getPack()
  const h = useShared()
  if (!pack) return <Empty text="场景包未加载" />
  const fields = pack.report.header_fields
  const filled = fields.filter((f) => h[f.key]).length
  const secs = pack.report.spec_sections
  const max = Math.max(1, ...secs.map((s) => s.fields.length))

  if (!secs.length)
    return <EmptyState icon={<LayoutList size={24} strokeWidth={1.5} />} title="模板未登记分节" />

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <span className="num text-[13px] font-semibold text-t1">
          {filled}
          <span className="font-normal text-t3">/{fields.length}</span>
        </span>
        <span className="text-[12px] text-t3">表头已填</span>
        <span className="num ml-auto text-[12px] text-t3">{secs.length} 节</span>
        <InfoTip content="条宽是本节字段数占比，不是填充进度——规格表各节由上游流程写入，实际填充要等 writeFile_rust 把模板写出来才可知。" />
      </div>
      <div
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent 100%)',
        }}
      >
        {secs.map((s) => (
          <Tooltip
            key={s.section}
            className="block w-full"
            content={
              <span className="block space-y-1">
                <span className="block font-medium">{s.section}</span>
                <span className="num block opacity-75">
                  {s.rows} · {s.from_flow}
                </span>
                <span className="block opacity-75">{s.fields.join(' · ')}</span>
              </span>
            }
          >
            <span className="flex w-full cursor-help items-center gap-2 py-[5px]">
              <span
                className={cn(
                  'shrink-0 truncate text-[12.5px] text-t1',
                  full ? 'w-[210px]' : 'w-[76px]',
                )}
              >
                {full ? simp(s.section) : sectionShort(s.section)}
              </span>
              <span className="min-w-0 flex-1">
                <StackBar
                  seg={[
                    { n: s.fields.length, cls: 'bg-p600', title: '字段' },
                    { n: max - s.fields.length, cls: 'bg-p100', title: '余' },
                  ]}
                />
              </span>
              <span className="num w-[26px] shrink-0 text-right text-[12px] text-t3">
                {s.fields.length}
              </span>
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

export const reportCards = {
  'report-preview': ReportPreview,
  artifacts: Artifacts,
  verdict: VerdictSummary,
  history: ReportHistory,
  'template-fields': TemplateFields,
}
