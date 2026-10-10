/**
 * 前端工具执行器装配（2026-10-10，权限切换修复）。
 *
 * 在 `features/index.tsx` 里以**副作用导入**方式加载（与 knowledge/register 同手法），
 * 把写类工具的真实执行逻辑注册进 agent-chat 的注册表。这样 agent-chat 保持通用、
 * 不认识报告业务；业务侧只负责「确认放行后怎么真正写」。
 *
 * 本批只实现 WriteReportHeader（方案 A 的最小闭环）：
 *   ① 写 store.reportHeader（报告页左栏即时可见）；
 *   ② 落库 report-instance（复用 persistReportInstance；无轮次时如实报失败）。
 * 成功/失败都以 {ok, summary} 如实返回——绝不谎报「已完成」。
 */
import { registerToolExecutor } from '../agent-chat/toolExec'
import { useAppStore } from '../../state/useAppStore'
import { getPack } from '../scene/pack'
import { persistReportInstance } from '../flow-report/reportApi'
import type { RawHeaderField } from '../scene/pack'

/**
 * 把模型给的字段标识解析成场景包里的表头字段定义。
 * 优先按 key（customer_name）精确匹配，其次按中文名（客戶名稱）匹配，
 * 再退一步做「去掉空白后包含」的模糊匹配。解析不出返回 null（如实报错）。
 */
function resolveHeaderField(field: string): RawHeaderField | null {
  const fields = getPack()?.report.header_fields ?? []
  const raw = (field ?? '').trim()
  if (!raw) return null
  const byKey = fields.find((f) => f.key === raw)
  if (byKey) return byKey
  const byName = fields.find((f) => f.name === raw)
  if (byName) return byName
  return fields.find((f) => f.name.includes(raw) || raw.includes(f.name)) ?? null
}

registerToolExecutor('WriteReportHeader', async (args) => {
  const fieldRaw = String(args.field ?? '').trim()
  const value = String(args.value ?? '')
  if (!fieldRaw) {
    return { ok: false, summary: '未提供要填写的字段名，未执行写入。' }
  }
  if (!value) {
    return { ok: false, summary: `字段「${fieldRaw}」的值为空，未执行写入。` }
  }

  const def = resolveHeaderField(fieldRaw)
  if (!def) {
    const fields = getPack()?.report.header_fields ?? []
    const names = fields.map((f) => f.name).join('、') || '（场景包未加载）'
    return {
      ok: false,
      summary: `找不到报告表头字段「${fieldRaw}」。可用字段：${names}。未执行写入。`,
    }
  }

  const st = useAppStore.getState()
  // ① 写 store（报告页左栏 FieldRow 立即反映）
  st.setReportHeader(def.key, value)

  // ② 落库 report-instance：把当前全部有值表头 + 完整字段定义落一份
  const header = { ...useAppStore.getState().reportHeader, [def.key]: value }
  const fields = (getPack()?.report.header_fields ?? []).map((f) => ({
    key: f.key,
    name: f.name,
    from_flow: f.from_flow,
    value_slot: f.value_slot,
  }))
  try {
    const { runId } = await persistReportInstance({
      sceneId: st.sceneId,
      runId: st.runId,
      header,
      fields,
      operator: st.operator,
    })
    return {
      ok: true,
      summary: `已将报告表头「${def.name}」填写为「${value}」，并落库到轮次 ${runId}。`,
      data: { key: def.key, value, runId },
    }
  } catch (e) {
    // 界面已写（store 生效），但落库失败——如实说清「界面已改、未落库」，别谎报全成功
    return {
      ok: false,
      summary:
        `已把报告表头「${def.name}」填为「${value}」（界面已更新），` +
        `但落库未成功：${e instanceof Error ? e.message : String(e)}。`,
      data: { key: def.key, value },
    }
  }
})
