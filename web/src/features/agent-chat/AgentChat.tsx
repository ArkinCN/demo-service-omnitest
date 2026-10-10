import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './agent-chat.css';
import { mockAdapter, type AgentAdapter, type AgentEvent } from './api';
import {
  type ChatItem,
  type EvidenceItem,
  type ExperienceDraft,
  type PermissionLevel,
  type Verdict,
} from './types';
import { Composer } from './components/Composer';
import { EvidencePanel } from './components/EvidencePanel';
import { ExperienceModal } from './components/ExperienceModal';
import { Markdown } from './components/Markdown';
import { ToolCallCard } from './components/ToolCallCard';
import { VerdictCard } from './components/VerdictCard';
import { useAppStore } from '../../state/useAppStore';

export interface AgentChatProps {
  /** 后端适配器，缺省用脚本化回放 */
  adapter?: AgentAdapter;
  /** 助手显示名，默认「助手」 */
  assistantName?: string;
  /** 预置消息流（演示或会话恢复用） */
  initialItems?: ChatItem[];
  /** 预置依据池 */
  initialEvidence?: EvidenceItem[];
  /** 挂载后自动以该文本发起一轮 */
  autoStartPrompt?: string;
  /**
   * 「上下文包已就绪」门闩（默认 true = 不等）。
   *
   * ⚠️ 为什么需要它（2026-10-05 修「助手不按真实情况回答」）：
   * autoStartPrompt 原先在挂载时立即发起，但承载上下文包的 `ActionDock` 是经
   * `actionSlot` 渲染的子元素——它的 effect 挂载顺序在前，写入的却是**首次 render
   * 算出的那份 envelope**；真后端适配器此时可能仍取不到内容而**整段不送 context**，
   * 模型于是拿不到现场数据、只能凭通用知识瞎答。
   *
   * 宿主（FlowCopilot）拿到 ActionDock 的「就绪」回调后把本值置 true，
   * 自动开场提问才放行——**第一轮请求必然带上真现场数据**。
   *
   * 缺省 undefined 视为 true：不传的调用方（知识库页等）行为与以前完全一致，
   * 不会因为没接门闩而永远不发起开场提问。
   */
  autoStartReady?: boolean;
  /** 挂载即展开依据抽屉（截图用） */
  evidenceOpenOnMount?: boolean;
  /** 确认人署名，回填到已执行的改动类动作卡片 */
  operator?: string;
  /*
   * 曾有一个 autoConfirm 开关：为真时改动类动作不弹确认、直接 resolve(true)。
   * 2026-09-20 整条删除（07i 独立核验 P2）。两条理由：
   *   一、它与 api.ts 的批准转发串起来就是一条「无人点击即批准设备桥凭据」的通路；
   *   二、它放行出来的留痕与真人批准同名同形，台账因此不能当作「确有人批准」的证据。
   * 演示要省点击就少点几个按钮，不在红线上开自动挡。
   */
  defaultModel?: string;
  defaultPermission?: PermissionLevel;
  /** 「沉淀为经验」提交回调，缺省只在控制台打印 */
  onSaveExperience?: (draft: ExperienceDraft) => void;
  /**
   * 消息流与输入区之间的一行插槽，给宿主挂自己的控件（助手预置动作按钮条走这里）。
   * 第三轮收尾轮补：在此之前宿主只能往 .ac-root 里 portal 一个节点，依赖内部 class 名。
   */
  actionSlot?: ReactNode;
  /**
   * 挂载后把命令式接口交给宿主：宿主据此代发一条消息，
   * 等价于人在输入框里打了这段话——用户气泡里就是这段原文。
   * 在此之前宿主只能往 .ac-textarea 写值再点 .ac-send。
   */
  onReady?: (api: AgentChatApi) => void;
  /** 忙态变化回调。在此之前宿主只能 MutationObserver 盯 .ac-header__state[data-busy]。 */
  onBusyChange?: (busy: boolean) => void;
  /**
   * 会话标识，随每轮请求带给后端，由后端据此维护上下文。
   * 缺省 undefined 时后端按无上下文处理（本阶段后端 history 固定 null，
   * 传与不传都不影响回答；补上是为了契约完整，避免后端日后据此分会话时拿不到）。
   */
  sessionId?: string;
  /**
   * 收起回调。传了就由头部的按钮条多渲染一枚「收起」——放在头部按钮组里，
   * 与「沉淀为经验 / 依据」同排，不遮不压；由宿主决定收起后的表现。
   */
  onCollapse?: () => void;
}

/** 交给宿主的命令式接口 */
export interface AgentChatApi {
  /** 代发一条消息；忙态中调用会被忽略，与人点发送按钮同一套闸门 */
  send: (text: string) => void;
}

let seq = 0;
const uid = (p: string) => `${p}-${(seq += 1)}`;

function draftFromConversation(items: ChatItem[], verdict?: Verdict): ExperienceDraft {
  const firstUser = items.find((i) => i.kind === 'message' && i.role === 'user');
  const tools = items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool');
  const v = verdict ?? items.filter((i) => i.kind === 'verdict').map((i) => i.verdict).at(-1);
  return {
    title: v ? `${v.title}复测${v.pass ? '通过' : '未通过'}` : '一次调试过程记录',
    phenomenon: firstUser && firstUser.kind === 'message' ? firstUser.text : '',
    cause: v ? `按判据 ${v.expression} 核对，${v.conclusion}` : '',
    action: tools.map((t) => `${t.call.name}：${t.call.argsSummary}`).join('\n'),
    result: tools
      .map((t) => t.call.resultSummary)
      .filter(Boolean)
      .join('；'),
    tags: ['启动测试', '电流限幅', v?.pass ? '合格' : '待复测'],
  };
}

export function AgentChat(props: AgentChatProps) {
  const {
    adapter = mockAdapter,
    assistantName = '助手',
    initialItems = [],
    initialEvidence = [],
    autoStartPrompt,
    autoStartReady = true,
    evidenceOpenOnMount = false,
    operator = '当前操作员',
    defaultModel = 'deepseek-v4-pro',
    defaultPermission = 'params',
    onSaveExperience,
    actionSlot,
    onReady,
    onBusyChange,
    sessionId,
    onCollapse,
  } = props;

  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [evidence, setEvidence] = useState<EvidenceItem[]>(initialEvidence);
  const [shownEvidenceIds, setShownEvidenceIds] = useState<string[] | null>(
    evidenceOpenOnMount ? initialEvidence.map((e) => e.id) : null,
  );
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [permission, setPermission] = useState<PermissionLevel>(defaultPermission);
  const [autoRun, setAutoRun] = useState(true);
  const [expDraft, setExpDraft] = useState<ExperienceDraft | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** 等待人工确认的改动类动作：callId → resolve */
  const confirmWaiters = useRef(new Map<string, (ok: boolean) => void>());
  /** 已作出的确认决定：callId → 是否放行 + 确认人。事件与点击的先后顺序都靠它兜住。 */
  const decisions = useRef(new Map<string, { approved: boolean; by: string }>());
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const apply = useCallback((ev: AgentEvent) => {
    setItems((prev) => {
      switch (ev.type) {
        case 'message_delta': {
          const idx = prev.findIndex((i) => i.kind === 'message' && i.id === ev.messageId);
          if (idx === -1) {
            return [
              ...prev,
              { kind: 'message', id: ev.messageId, role: 'assistant', text: ev.delta, streaming: true },
            ];
          }
          const next = [...prev];
          const cur = next[idx];
          if (cur.kind === 'message') next[idx] = { ...cur, text: cur.text + ev.delta, streaming: true };
          return next;
        }
        case 'tool_call':
          return [
            ...prev,
            {
              kind: 'tool',
              id: ev.callId,
              call: {
                id: ev.callId,
                name: ev.name,
                title: ev.title,
                args: ev.args,
                argsSummary: ev.argsSummary,
                mutating: ev.mutating,
                status: !ev.mutating
                  ? 'running'
                  : decisions.current.get(ev.callId)?.approved === true
                    ? 'running'
                    : decisions.current.get(ev.callId)?.approved === false
                      ? 'error'
                      : 'pending_confirm',
                confirmedBy: decisions.current.get(ev.callId)?.approved
                  ? decisions.current.get(ev.callId)?.by
                  : undefined,
              },
            },
          ];
        case 'tool_result': {
          const idx = prev.findIndex((i) => i.kind === 'tool' && i.id === ev.callId);
          if (idx === -1) return prev;
          const next = [...prev];
          const cur = next[idx];
          if (cur.kind === 'tool') {
            next[idx] = {
              ...cur,
              call: {
                ...cur.call,
                status: ev.status,
                confirmedBy:
                  cur.call.confirmedBy ??
                  (decisions.current.get(ev.callId)?.approved
                    ? decisions.current.get(ev.callId)?.by
                    : undefined),
                durationMs: ev.durationMs,
                resultSummary: ev.resultSummary,
                result: ev.result,
              },
            };
          }
          return next;
        }
        case 'verdict':
          return [...prev, { kind: 'verdict', id: ev.verdict.id, verdict: ev.verdict }];
        case 'done': {
          const stopped = prev.map((i) => (i.kind === 'message' ? { ...i, streaming: false } : i));
          // 出错必须以气泡形态让人看见。此前 done{reason:error} 只把 streaming 置 false，
          // 带回来的 message 被丢弃，界面上表现为「发出去一片静默、什么也不回」——
          // 与「模型还在想」无法区分。这里把错误原样落成一条助手消息。
          if (ev.reason === 'error') {
            return [
              ...stopped,
              {
                kind: 'message',
                id: uid('err'),
                role: 'assistant',
                text: `本轮未能完成：${ev.message ?? '后端返回错误，未附原因'}`,
                streaming: false,
              },
            ];
          }
          return stopped;
        }
        default:
          return prev;
      }
    });
    if (ev.type === 'evidence') {
      setEvidence((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...ev.items.filter((e) => !seen.has(e.id))];
      });
    }
  }, []);

  /**
   * 注入给适配器的人工确认闸门。
   * 只有一条出路：把 resolve 挂进 confirmWaiters，等人在气泡的确认卡上点。
   * 没有任何分支能在无人点击的情况下 resolve(true)——自动放行的那条已删。
   */
  const requestConfirm = useCallback(
    (call: { callId: string }) =>
      new Promise<boolean>((resolve) => {
        confirmWaiters.current.set(call.callId, resolve);
      }),
    [],
  );

  const handleConfirm = useCallback(
    (callId: string, approved: boolean) => {
      const resolve = confirmWaiters.current.get(callId);
      confirmWaiters.current.delete(callId);
      decisions.current.set(callId, { approved, by: operator });
      setItems((prev) =>
        prev.map((i) =>
          i.kind === 'tool' && i.id === callId
            ? {
                ...i,
                call: {
                  ...i.call,
                  status: approved ? 'running' : 'error',
                  confirmedBy: approved ? operator : undefined,
                },
              }
            : i,
        ),
      );
      resolve?.(approved);
    },
    [operator],
  );

  const run = useCallback(
    async (text: string) => {
      if (busy) return;
      // 意图识别分支：命中「启动自动化测试流程」直接交给自动化编排器，
      // 不当作普通对话丢给模型（这是用户明说的第二种入口，两种入口同一套流程）。
      if (/启动自动化测试|开始自动化测试|一键自动化/.test(text.trim())) {
        setItems((prev) => [...prev, { kind: 'message', id: uid('u'), role: 'user', text }])
        setItems((prev) => [
          ...prev,
          {
            kind: 'message',
            id: uid('auto'),
            role: 'assistant',
            text: '已启动自动化测试流程：自动确认参数 → 按阶段推进 → 生成并下载报告。进度会在全屏运行浮层与顶部阶段条实时展示。',
            streaming: false,
          },
        ])
        useAppStore.getState().startAutomation()
        // 订阅播报：自动化事件经 store.automationAnnouncement 下发，这里把它追加进对话，
        // 做一次防刷屏（同一条消息不重复追加）。
        const unsub = useAppStore.subscribe((s, prev) => {
          if (s.automationAnnouncement && s.automationAnnouncement !== prev.automationAnnouncement) {
            setItems((items) => {
              const last = items[items.length - 1]
              if (last && last.kind === 'message' && last.text === s.automationAnnouncement) return items
              return [
                ...items,
                {
                  kind: 'message',
                  id: uid('ann'),
                  role: 'assistant',
                  text: s.automationAnnouncement,
                  streaming: false,
                },
              ]
            })
          }
          // 流程结束（runStatus 离开 running）就停止订阅，不留泄漏
          if (s.automationRunStatus !== 'running' && prev.automationRunStatus === 'running') {
            unsub()
          }
        })
        return
      }
      setItems((prev) => [...prev, { kind: 'message', id: uid('u'), role: 'user', text }]);
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const ev of adapter.send({
          text,
          model,
          permission,
          autoRun,
          signal: ac.signal,
          requestConfirm,
          sessionId,
        })) {
          apply(ev);
          if (ev.type === 'done') break;
        }
      } catch (e) {
        // 适配器抛出的任何异常都要落成一条可见的助手消息。
        // 只留 finally 会把异常吞掉：用户看到的是「发了消息、界面毫无反应」，
        // 分不清是模型在思考、还是链路根本没通。
        const aborted = ac.signal.aborted;
        if (!aborted) {
          setItems((prev) => [
            ...prev,
            {
              kind: 'message',
              id: uid('err'),
              role: 'assistant',
              text: `本轮未能完成：${e instanceof Error ? e.message : String(e)}`,
              streaming: false,
            },
          ]);
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [adapter, apply, autoRun, busy, model, permission, requestConfirm, sessionId],
  );

  // 命令式接口：句柄本身一次性给出去，内部始终打到最新那份 run 上，
  // 免得宿主握着一个闭包过期的 send。
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    onReady?.({ send: (text: string) => void runRef.current(text) });
  }, [onReady]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /*
   * 自动开场提问：**等上下文包就绪再发**（2026-10-05 修「助手不按真实情况回答」）。
   *
   * 两道闸门：
   *   ① autoStartReady —— 宿主（FlowCopilot）收到 ActionDock 的 onEnvReady 后置 true，
   *      保证发出去的那一轮 request 里 heldEnv() 已有真现场数据，模型不是瞎答；
   *   ② started —— 只发一次。
   *
   * ⚠️ StrictMode 坑（项目铁律）：以前是「发之前就把 started 置 true」，而本 effect
   * 依赖 `autoStartPrompt`，StrictMode 双调用 + ready 后置两种时序混在一起，
   * 容易出现「第一次置位但那次 run 被丢弃 → 之后再也不发」。现在把记账放在
   * **真正进入发送分支之后**，且以「已记账」为唯一判据：ready 到来时若还没发过，
   * 一定发得出去；已发过则严格幂等。
   */
  const started = useRef(false);
  useEffect(() => {
    if (!autoStartPrompt || !autoStartReady || started.current) return;
    started.current = true;
    void run(autoStartPrompt);
    // run 的依赖会随状态变化，这里只在「ready 且未发过」时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartPrompt, autoStartReady]);

  const shownEvidence =
    shownEvidenceIds === null
      ? []
      : evidence.filter((e) => shownEvidenceIds.includes(e.id));

  return (
    <div className="ac-root" data-drawer={String(shownEvidenceIds !== null)}>
      <header className="ac-header">
        <span className="ac-header__avatar">AI</span>
        <span className="ac-header__title">{assistantName}</span>
        <span className="ac-header__sub">电机调试</span>
        {/*
          后端标识：一眼看出这一轮走的是 dsh（真后端）还是 mock（脚本回放）。
          起因是「发了消息毫无反应」这类现象，光看界面分不清前端挂的是哪个适配器，
          排查时要反复猜。把它显式写出来，以后一眼可辨。
        */}
        <span className="ac-header__sub" title={`后端适配器：${adapter.id}`}>
          {adapter.id}
        </span>
        <span className="ac-header__spacer" />
        <span className="ac-header__state" data-busy={String(busy)}>
          {busy ? '执行中' : '待命'}
        </span>
        <button
          type="button"
          className="ac-iconbtn"
          onClick={() => setExpDraft(draftFromConversation(items))}
          disabled={items.length === 0}
        >
          沉淀为经验
        </button>
        <button
          type="button"
          className="ac-iconbtn"
          onClick={() =>
            setShownEvidenceIds((v) => (v === null ? evidence.map((e) => e.id) : null))
          }
          disabled={evidence.length === 0}
        >
          依据 {evidence.length}
        </button>
        {/* 宿主要求折叠时给一枚收起键；与上面两枚同排，所以不会重叠 */}
        {onCollapse ? (
          <button
            type="button"
            className="ac-iconbtn"
            onClick={onCollapse}
            title="收起助手"
          >
            收起
          </button>
        ) : null}
      </header>

      <div className="ac-stream" ref={streamRef}>
        {items.map((it) => {
          if (it.kind === 'message') {
            return (
              <div className={`ac-row ac-row--${it.role}`} key={it.id}>
                <div className={`ac-bubble ac-bubble--${it.role}`}>
                  {/* 助手回答按 Markdown 渲染：后端给的是 ### / ** / - 这类语法，
                      直接当纯文本显示会让人看到一堆符号（用户反馈过）。
                      用户自己打的字不渲染——人写的就是想原样看到的。 */}
                  {it.role === 'assistant' ? <Markdown text={it.text} /> : it.text}
                  {it.streaming ? <span className="ac-caret" /> : null}
                </div>
              </div>
            );
          }
          if (it.kind === 'tool') {
            return (
              <div className="ac-row ac-row--assistant" key={it.id}>
                <ToolCallCard call={it.call} onConfirm={handleConfirm} />
              </div>
            );
          }
          return (
            <div className="ac-row ac-row--assistant" key={it.id}>
              <VerdictCard
                verdict={it.verdict}
                onOpenEvidence={setShownEvidenceIds}
                onDistill={(v) => setExpDraft(draftFromConversation(items, v))}
              />
            </div>
          );
        })}
      </div>

      {actionSlot ? <div className="ac-slot">{actionSlot}</div> : null}

      <Composer
        busy={busy}
        model={model}
        permission={permission}
        autoRun={autoRun}
        onModel={setModel}
        onPermission={setPermission}
        onAutoRun={setAutoRun}
        onSend={(t) => void run(t)}
        onStop={() => abortRef.current?.abort()}
      />

      {shownEvidenceIds !== null ? (
        <EvidencePanel items={shownEvidence} onClose={() => setShownEvidenceIds(null)} />
      ) : null}

      {expDraft ? (
        <ExperienceModal
          draft={expDraft}
          onCancel={() => setExpDraft(null)}
          onSubmit={(d) => {
            setExpDraft(null);
            if (onSaveExperience) onSaveExperience(d);
            else console.info('[agent-chat] 经验条目', d);
          }}
        />
      ) : null}
    </div>
  );
}

export default AgentChat;
