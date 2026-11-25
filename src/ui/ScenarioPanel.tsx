/**
 * P031 RejoinLab — T008: 实验配置面板。
 *
 * 断线位置、恢复策略、故障注入参数。所有选择只组装成
 * ScenarioConfig 交给 T005 的 evaluateFixture，不做任何分析。
 * 8 种注入算子全部可选（PROJECT_BOOK §8.4，顺序为 §8.5 固定字典序）。
 */
import {
  OPERATOR_ORDER,
  STRATEGY_LABELS,
  STRATEGY_DESCRIPTIONS,
  INJECTION_LABELS,
  INJECTION_DESCRIPTIONS,
  defaultInjection,
  injectionNeedsSourceIndex,
  type Injection,
  type InjectionOperator,
  type RecoveryStrategy,
  type ScenarioConfig,
} from "./analyze.js";

export interface ScenarioPanelProps {
  readonly eventCount: number;
  readonly config: ScenarioConfig;
  readonly onChange: (next: ScenarioConfig) => void;
  readonly disabled: boolean;
}

const STRATEGIES: readonly RecoveryStrategy[] = [
  "FULL_REPLAY_FROM_START",
  "RESUME_FROM_CHECKPOINT",
  "REPLAY_AFTER_SOURCE_CURSOR",
];

function clampIndex(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return Math.floor(value);
}

export function ScenarioPanel(props: ScenarioPanelProps) {
  const { eventCount, config, onChange, disabled } = props;
  const maxIndex = Math.max(0, eventCount - 1);
  const enabledOps = new Set(config.injections.map((inj) => inj.op));

  const setInjections = (next: readonly Injection[]): void => {
    onChange({ ...config, injections: next });
  };

  const toggleOperator = (op: InjectionOperator, enabled: boolean): void => {
    if (enabled) {
      setInjections([...config.injections, defaultInjection(op)]);
    } else {
      setInjections(config.injections.filter((inj) => inj.op !== op));
    }
  };

  const updateInjection = (op: InjectionOperator, patch: Partial<Injection>): void => {
    setInjections(
      config.injections.map((inj) => (inj.op === op ? { ...inj, ...patch } : inj)),
    );
  };

  const injectionFor = (op: InjectionOperator): Injection | undefined =>
    config.injections.find((inj) => inj.op === op);

  return (
    <section className="panel scenario-panel" aria-label="实验参数">
      <h2>实验参数</h2>

      <label className="field">
        <span>断线位置（DISCONNECT_AFTER）</span>
        <select
          value={config.disconnectAfter === undefined ? "" : String(config.disconnectAfter)}
          disabled={disabled || eventCount === 0}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...config,
              disconnectAfter: value === "" ? undefined : Number(value),
            });
          }}
          aria-label="断线位置"
        >
          <option value="">不断线（完整轨迹）</option>
          {Array.from({ length: eventCount }, (_, i) => (
            <option key={i} value={String(i)}>
              在 sourceIndex {i} 处断线（已交付 {i + 1} 条）
            </option>
          ))}
        </select>
        <span className="hint">已交付事件保留，未交付事件不进入恢复路径；不虚构 RUN_ERROR / RUN_FINISHED。</span>
      </label>

      <fieldset className="field" disabled={disabled}>
        <legend>恢复策略</legend>
        {STRATEGIES.map((strategy) => (
          <label key={strategy} className="radio-row">
            <input
              type="radio"
              name="recovery-strategy"
              value={strategy}
              checked={config.strategy === strategy}
              onChange={() => onChange({ ...config, strategy })}
            />
            <span>
              <strong>{STRATEGY_LABELS[strategy]}</strong>
              <code> {strategy}</code>
              <span className="hint"> — {STRATEGY_DESCRIPTIONS[strategy]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {config.strategy !== "FULL_REPLAY_FROM_START" && (
        <label className="field">
          <span>恢复游标（resumeAfterSourceIndex，留空 = 跟随断线位置）</span>
          <input
            type="number"
            min={0}
            max={maxIndex}
            value={config.resumeAfterSourceIndex === undefined ? "" : config.resumeAfterSourceIndex}
            disabled={disabled || eventCount === 0}
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                ...config,
                resumeAfterSourceIndex:
                  value === "" ? undefined : clampIndex(Number(value), maxIndex),
              });
            }}
            aria-label="恢复游标"
          />
          <span className="hint">本地 sourceIndex 游标，不是 SSE Last-Event-ID，也不是 AG-UI eventId。</span>
        </label>
      )}

      <fieldset className="field" disabled={disabled}>
        <legend>故障注入（8 种，可多选；按固定字典序应用）</legend>
        {OPERATOR_ORDER.map((op) => {
          const enabled = enabledOps.has(op);
          const current = injectionFor(op);
          return (
            <div key={op} className="injection-row">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => toggleOperator(op, event.target.checked)}
                />
                <span>
                  <strong>{INJECTION_LABELS[op]}</strong>
                  <code> {op}</code>
                  <span className="hint"> — {INJECTION_DESCRIPTIONS[op]}</span>
                </span>
              </label>
              {enabled && current !== undefined && op === "REPLAY_PREFIX" &&
                config.disconnectAfter === undefined && (
                  <span className="hint">
                    提示：未设置断线位置时本次不生效——无断线点则无已处理前缀可重放（T005 行为）。
                  </span>
                )}
              {enabled && current !== undefined && injectionNeedsSourceIndex(op) && (
                <label className="field inline-field">
                  <span>目标 sourceIndex</span>
                  <input
                    type="number"
                    min={0}
                    max={maxIndex}
                    value={current.sourceIndex ?? 0}
                    onChange={(event) =>
                      updateInjection(op, {
                        sourceIndex: clampIndex(Number(event.target.value), maxIndex),
                      })
                    }
                    aria-label={`${INJECTION_LABELS[op]} 目标 sourceIndex`}
                  />
                </label>
              )}
              {enabled && current !== undefined && op === "CURSOR_SKIP" && (
                <span className="inline-params">
                  <label className="field inline-field">
                    <span>从 sourceIndex</span>
                    <input
                      type="number"
                      min={0}
                      max={maxIndex}
                      value={current.from ?? 0}
                      onChange={(event) =>
                        updateInjection(op, {
                          from: clampIndex(Number(event.target.value), maxIndex),
                        })
                      }
                      aria-label="游标跳过起始 sourceIndex"
                    />
                  </label>
                  <label className="field inline-field">
                    <span>到 sourceIndex</span>
                    <input
                      type="number"
                      min={0}
                      max={maxIndex}
                      value={current.to ?? 0}
                      onChange={(event) =>
                        updateInjection(op, {
                          to: clampIndex(Number(event.target.value), maxIndex),
                        })
                      }
                      aria-label="游标跳过结束 sourceIndex"
                    />
                  </label>
                </span>
              )}
              {enabled && current !== undefined && op === "MESSAGE_ID_REMAP" && (
                <span className="inline-params">
                  <label className="field inline-field">
                    <span>原消息 ID（留空 = 首条 assistant 消息）</span>
                    <input
                      type="text"
                      value={current.messageId ?? ""}
                      onChange={(event) =>
                        updateInjection(op, { messageId: event.target.value })
                      }
                      aria-label="重映射原消息 ID"
                    />
                  </label>
                  <label className="field inline-field">
                    <span>新消息 ID（留空 = 加 -remapped 后缀）</span>
                    <input
                      type="text"
                      value={current.newMessageId ?? ""}
                      onChange={(event) =>
                        updateInjection(op, { newMessageId: event.target.value })
                      }
                      aria-label="重映射新消息 ID"
                    />
                  </label>
                </span>
              )}
            </div>
          );
        })}
      </fieldset>
    </section>
  );
}
