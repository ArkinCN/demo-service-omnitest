// 智能体对话组件 —— 领域类型定义
// 所有面向后端的事件类型见 ./api.ts

/** 权限档位：约束智能体可以执行的动作范围 */
export type PermissionLevel = 'readonly' | 'params' | 'hardware';

export const PERMISSION_OPTIONS: { value: PermissionLevel; label: string; hint: string }[] = [
  { value: 'readonly', label: '只读', hint: '仅读取工程文件与测量数据，不做任何写入' },
  { value: 'params', label: '可改参数', hint: '允许修改标定参数与配置项，不驱动硬件' },
  { value: 'hardware', label: '可控硬件', hint: '允许启停电机、切换负载、控制仪器' },
];

/**
 * 可选模型。这三个都能在后端的 model_pricing 表里查到（已启用），
 * 且都通过 upstream_model_id 折到同一家上游：本机是单机版，只有一家上游
 * （见 local_admin_service.py 的 _SEEDED_MODELS 及其注释），别名行的存在
 * 只是为了让这些字面量不撞上准入校验。
 *
 * 此前这里列的是 deepseek-v4 / claude-opus-5 / qwen3-max，**后端一个都没配**，
 * 选中就报「模型不可用或未配置」——选项必须与后端实际配置对齐，
 * 否则用户点得到、用了必错。
 */
export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek Flash' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
];

/** 一次工具调用的完整记录（调用 + 结果） */
export interface ToolCall {
  id: string;
  /** 工具名，如 rigol_measure */
  name: string;
  /** 工具中文显示名 */
  title?: string;
  /** 调用参数（原始 JSON） */
  args: Record<string, unknown>;
  /** 参数摘要，一行内讲清这次调了什么 */
  argsSummary: string;
  /** pending_confirm：会改变被测对象状态或落盘的动作，等人点确认 */
  status: 'pending_confirm' | 'running' | 'ok' | 'error';
  /** 是否为改动类动作（写参数、控硬件）。改动类一律需人工确认。 */
  mutating?: boolean;
  /** 确认人，确认后回填 */
  confirmedBy?: string;
  /** 耗时，毫秒 */
  durationMs?: number;
  /** 结果摘要，一行内讲清拿到了什么 */
  resultSummary?: string;
  /** 结果原始 JSON */
  result?: unknown;
}

/** 判定卡片：一条判据的结论 */
export interface Verdict {
  id: string;
  /** 判定项名称，如 启动电流峰值 */
  title: string;
  pass: boolean;
  /** 判据表达式，如 I_peak <= 1.5 * I_rated */
  expression: string;
  /** 实测值列表 */
  measurements: { label: string; value: string; unit?: string }[];
  /** 一句话结论 */
  conclusion: string;
  /** 关联的依据条目 id 列表 */
  evidenceIds: string[];
}

/** 依据条目的三类来[源] */
export type EvidenceKind = 'procedure' | 'case' | 'document';

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  procedure: '规程条目',
  case: '相似案例',
  document: '资料段落',
};

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  /** 正文摘录 */
  excerpt: string;
  /** 来源文件或规程名称（给全名，便于独立定位） */
  source: string;
  /** 页码或条目号 */
  locator: string;
  /** 查看原文的目标地址；本地知识库没有可点的 PDF，缺省时改走 docId 跳知识库页 */
  href?: string;
  /**
   * 知识库资料的 doc_id（如 fu6832-datasheet）。
   * 本地知识库的原文 PDF 未随交付包提供，没有可点的 href，但条目在知识库页里
   * 是有的——据此跳到 /knowledge 并选中该条目，比显示「原文未接入」有用得多
   * （那句文案会被误读成「原文没检索到」，实际摘录就在卡片正文里）。
   */
  docId?: string;
}

/** 消息流里的一项 */
export type ChatItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'verdict'; id: string; verdict: Verdict };

/** 沉淀为经验的表单数据 */
export interface ExperienceDraft {
  title: string;
  phenomenon: string;
  cause: string;
  action: string;
  result: string;
  tags: string[];
}
