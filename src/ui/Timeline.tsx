/**
 * P031 RejoinLab — T009: 双轨时间线。
 *
 * 展示 Worker 返回的双轨时间线视图（src/worker/protocol.ts
 * WorkerAnalysisResult），与 T008 的 StateDiff / Diagnostics 展示
 * 同一份 evaluation，因此首个分歧、诊断、双轨终态哈希必然一致。
 *
 * 展示规则（验收）：
 * - 两条轨道各渲染一条完整轨道；事件按 Worker 返回的数组顺序
 *   原样渲染，即 sourceIndex 升序（同值保持应用流顺序），组件
 *   不做任何重排。
 * - sourceIndex 是展开后事件编号（与诊断 / 首个分歧同一编号
 *   体系）；含 chunk 事件的轨迹会注明编号与导入列表可能不同。
 * - 断线点、恢复点、快照位置、重复 / 丢失 / 乱序事件、首个分歧
 *   均以文字标记展示，不只依赖颜色。
 * - 点击事件展示原始 JSON（真实事件内容，React 转义渲染）。
 * - 逐事件回放：步进单位是 sourceIndex；每一步两侧状态的取法
 *   与 T004/T005 的首个分歧对齐完全相同（align.ts
 *   findFirstDivergenceForReplay）：从检查点起按 sourceIndex 步进，
 *   完整路径取该序号的折叠状态，恢复路径取不大于该序号的最大
 *   序号处的状态（检查点处以恢复基线状态为种子）。因此回放中
 *   第一个出现“两侧状态分歧”的步，其 sourceIndex 与核心结果的
 *   firstDivergence.sourceIndex 一致；此前的步两侧状态一致。
 */
import { useEffect, useMemo, useState } from "react";
import type { RejoinState } from "../core/state.js";
import { stateHash } from "../core/canonical.js";
import type {
  TrackEventView,
  TrackStepState,
  WorkerAnalysisResult,
} from "../worker/protocol.js";
import { TimelineEvent } from "./TimelineEvent.js";
import "./timeline.css";

export interface TimelineProps {
  readonly result: WorkerAnalysisResult | null;
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 20)}…` : hash;
}

/**
 * 按 T004 对齐取“sourceIndex 不大于 s 的最近一步状态”：
 * 同一 sourceIndex 有多条历史时取最后一条（展开 chunk / 重放
 * 前缀都会产生同序号多条）；无任何条目时取 fallback。
 * 恢复路径调用时需先把检查点种子（checkpointIndex → baseState）
 * 拼在 history 前面，与 findFirstDivergenceForReplay 一致。
 */
export function stateAtSourceIndex(
  history: readonly TrackStepState[],
  seed: { readonly sourceIndex: number; readonly state: RejoinState } | null,
  sourceIndex: number,
  fallback: RejoinState,
): RejoinState {
  const byIndex = new Map<number, RejoinState>();
  if (seed !== null) byIndex.set(seed.sourceIndex, seed.state);
  for (const entry of history) {
    byIndex.set(entry.sourceIndex, entry.state);
  }
  let best: number | null = null;
  for (const key of byIndex.keys()) {
    if (key <= sourceIndex && (best === null || key > best)) best = key;
  }
  if (best === null) return fallback;
  return byIndex.get(best) as RejoinState;
}

/**
 * 与 stateAtSourceIndex 相同的取法，只返回规范化状态哈希；
 * 无任何不大于 sourceIndex 的条目（且无种子）时返回 null。
 */
export function hashAtSourceIndex(
  history: readonly TrackStepState[],
  seed: { readonly sourceIndex: number; readonly stateHash: string } | null,
  sourceIndex: number,
): string | null {
  const byIndex = new Map<number, string>();
  if (seed !== null) byIndex.set(seed.sourceIndex, seed.stateHash);
  for (const entry of history) {
    byIndex.set(entry.sourceIndex, entry.stateHash);
  }
  let best: number | null = null;
  for (const key of byIndex.keys()) {
    if (key <= sourceIndex && (best === null || key > best)) best = key;
  }
  if (best === null) return null;
  return byIndex.get(best) as string;
}

/**
 * 可比较的步进序号：完整路径历史中不小于检查点的 sourceIndex
 * 去重升序（与 findFirstDivergenceForReplay 切出的 fullSliced
 * 序号集合相同）。
 */
export function comparableSourceIndices(result: WorkerAnalysisResult): number[] {
  const checkpointIndex = result.evaluation.checkpointIndex;
  const indices = new Set<number>();
  for (const entry of result.fullHistory) {
    if (entry.sourceIndex >= checkpointIndex) indices.add(entry.sourceIndex);
  }
  return [...indices].sort((a, b) => a - b);
}

function stateSummary(state: RejoinState): string {
  return `消息 ${state.messages.length} 条 · 工具调用 ${state.toolCalls.length} 个 · 运行状态 ${state.runStatus}`;
}

type SelectedEvent = { readonly track: "full" | "resume"; readonly view: TrackEventView };

export function Timeline(props: TimelineProps) {
  const { result } = props;
  const [selected, setSelected] = useState<SelectedEvent | null>(null);
  // 步进位置：-1 = 起点（尚未应用任何可比较事件）；否则为
  // comparableSourceIndices 的下标。
  const [stepPosition, setStepPosition] = useState(-1);

  // 新结果到达时回到起点并清除已选事件。
  useEffect(() => {
    setSelected(null);
    setStepPosition(-1);
  }, [result]);

  const steps = useMemo(
    () => (result === null ? [] : comparableSourceIndices(result)),
    [result],
  );
  const currentSourceIndex = stepPosition >= 0 ? (steps[stepPosition] as number) : null;

  const stepStates = useMemo(() => {
    if (result === null || currentSourceIndex === null) return null;
    const checkpointIndex = result.evaluation.checkpointIndex;
    const fullState = stateAtSourceIndex(
      result.fullHistory,
      null,
      currentSourceIndex,
      result.fullBaseState,
    );
    const resumeState = stateAtSourceIndex(
      result.resumeHistory,
      { sourceIndex: checkpointIndex, state: result.resumeBaseState },
      currentSourceIndex,
      result.resumeBaseState,
    );
    const fullHash = hashAtSourceIndex(result.fullHistory, null, currentSourceIndex);
    const resumeHash = hashAtSourceIndex(
      result.resumeHistory,
      { sourceIndex: checkpointIndex, stateHash: stateHash(result.resumeBaseState) },
      currentSourceIndex,
    );
    return { fullState, resumeState, fullHash, resumeHash };
  }, [result, currentSourceIndex]);

  if (result === null) {
    return (
      <section className="panel timeline" aria-label="双轨时间线">
        <h2>双轨时间线</h2>
        <p className="hint">导入事件文件并点击“开始”后，这里展示完整路径与恢复路径的双轨时间线。</p>
      </section>
    );
  }

  const { evaluation } = result;
  const divergence = evaluation.firstDivergence;
  const divergenceStep =
    divergence === null ? -1 : steps.indexOf(divergence.sourceIndex);
  const hasTracks = result.fullTrack.length > 0 || result.resumeTrack.length > 0;

  return (
    <section className="panel timeline" aria-label="双轨时间线">
      <h2>双轨时间线</h2>

      {result.expandedEventCount !== result.importedEventCount && (
        <p className="hint" data-testid="timeline-chunk-note">
          chunk 事件已展开：时间线按展开后事件编号（共 {result.expandedEventCount} 条，导入{" "}
          {result.importedEventCount} 条）；展开事件的编号与导入列表中的 sourceIndex 可能不同。
          诊断与首个分歧使用的也是展开后编号。
        </p>
      )}
      {result.notes.map((note) => (
        <p className="hint" key={note}>
          {note}
        </p>
      ))}

      <p className="meta-line">
        完整路径终态哈希{" "}
        <code title={evaluation.fullPath?.finalStateHash ?? ""}>
          {evaluation.fullPath === null ? "（无）" : shortHash(evaluation.fullPath.finalStateHash)}
        </code>
        {" · "}恢复路径终态哈希{" "}
        <code title={evaluation.resumePath?.finalStateHash ?? ""}>
          {evaluation.resumePath === null ? "（无）" : shortHash(evaluation.resumePath.finalStateHash)}
        </code>
        {" · "}检查点 sourceIndex {evaluation.checkpointIndex}
      </p>

      {!hasTracks && (
        <p className="hint" data-testid="timeline-no-tracks">
          本次分析无双轨终态（裁决 {evaluation.verdict}），无时间线可展示。
        </p>
      )}

      {hasTracks && (
        <>
          <div className="timeline-tracks">
            <div className="timeline-track" aria-label="完整路径时间线">
              <h3>
                完整路径 <span className="hint">（{result.fullTrack.length} 条事件）</span>
              </h3>
              <ol className="timeline-events" data-testid="timeline-track-full">
                {result.fullTrack.map((view) => (
                  <TimelineEvent
                    key={`full-${view.sourceIndex}-${view.appliedPosition}`}
                    view={view}
                    track="full"
                    selected={selected?.track === "full" && selected.view === view}
                    isCurrentStep={currentSourceIndex !== null && view.sourceIndex === currentSourceIndex}
                    onSelect={(selectedView) => setSelected({ track: "full", view: selectedView })}
                  />
                ))}
              </ol>
            </div>

            <div className="timeline-track" aria-label="恢复路径时间线">
              <h3>
                恢复路径 <span className="hint">（{result.resumeTrack.length} 条事件）</span>
              </h3>
              <ol className="timeline-events" data-testid="timeline-track-resume">
                {result.resumeTrack.map((view) => (
                  <TimelineEvent
                    key={`resume-${view.sourceIndex}-${view.appliedPosition}-${view.isDropped ? "dropped" : "applied"}`}
                    view={view}
                    track="resume"
                    selected={selected?.track === "resume" && selected.view === view}
                    isCurrentStep={currentSourceIndex !== null && view.sourceIndex === currentSourceIndex}
                    onSelect={(selectedView) => setSelected({ track: "resume", view: selectedView })}
                  />
                ))}
              </ol>
            </div>
          </div>

          <p className="hint">
            图例：快照 = 快照事件；断线点 = 完整路径中断位置；恢复点 = 恢复路径起始事件；
            重放前缀 = 已在检查点覆盖、恢复时又重放的事件；重复 / 丢失 / 乱序 =
            注入或重放导致的三类异常事件；首个分歧 = 双轨状态首次不一致的事件。
            点击任意事件查看原始 JSON。
          </p>

          <div className="timeline-replay" aria-label="逐事件回放">
            <h3>逐事件回放</h3>
            <p className="meta-line" data-testid="timeline-step-label">
              {currentSourceIndex === null
                ? `起点：尚未应用任何可比较事件（共 ${steps.length} 步，从检查点 sourceIndex ${evaluation.checkpointIndex} 起按 sourceIndex 步进）`
                : `第 ${stepPosition + 1} / ${steps.length} 步 · sourceIndex ${currentSourceIndex}`}
            </p>
            <div className="timeline-replay-buttons">
              <button type="button" onClick={() => setStepPosition(-1)} disabled={stepPosition === -1}>
                回到开头
              </button>
              <button
                type="button"
                onClick={() => setStepPosition((current) => Math.max(-1, current - 1))}
                disabled={stepPosition === -1}
              >
                上一步
              </button>
              <button
                type="button"
                onClick={() => setStepPosition((current) => Math.min(steps.length - 1, current + 1))}
                disabled={stepPosition >= steps.length - 1}
              >
                下一步
              </button>
              <button
                type="button"
                onClick={() => setStepPosition(steps.length - 1)}
                disabled={stepPosition >= steps.length - 1}
              >
                跳到末尾
              </button>
              {divergenceStep >= 0 && (
                <button type="button" onClick={() => setStepPosition(divergenceStep)}>
                  跳到首个分歧
                </button>
              )}
            </div>
            {stepStates !== null && currentSourceIndex !== null && (
              <div className="timeline-step-states" data-testid="timeline-step-states">
                <p>
                  完整路径此步：{stateSummary(stepStates.fullState)} · 状态哈希{" "}
                  <code>
                    {stepStates.fullHash === null ? "（无）" : shortHash(stepStates.fullHash)}
                  </code>
                </p>
                <p>
                  恢复路径此步：{stateSummary(stepStates.resumeState)} · 状态哈希{" "}
                  <code>
                    {stepStates.resumeHash === null ? "（无）" : shortHash(stepStates.resumeHash)}
                  </code>
                </p>
                <p data-testid="timeline-step-comparison">
                  {stepStates.fullHash === null || stepStates.resumeHash === null
                    ? "此步暂无可比较的状态哈希。"
                    : stepStates.fullHash === stepStates.resumeHash
                      ? "两侧状态一致。"
                      : divergence !== null && currentSourceIndex === divergence.sourceIndex
                        ? "两侧状态在此步分歧，与核心结果的首个分歧一致。"
                        : "两侧状态在此步分歧。"}
                </p>
              </div>
            )}
          </div>

          {selected !== null && (
            <div className="timeline-json" data-testid="timeline-selected-json">
              <h3>
                事件原始 JSON（{selected.track === "full" ? "完整路径" : "恢复路径"} · sourceIndex{" "}
                {selected.view.sourceIndex}
                {selected.view.appliedPosition >= 0
                  ? ` · 应用位置 ${selected.view.appliedPosition}`
                  : " · 未应用（丢失占位）"}
                ）
              </h3>
              <pre>{JSON.stringify(selected.view.event, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
