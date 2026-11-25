/**
 * P031 RejoinLab — T008: 双轨状态对照。
 *
 * 原样展示 T004 的比较结果与 T005 的双轨终态：裁决、终态哈希、
 * 消息 / 工具调用 / pending 摘要、共享状态、首个分歧及 JSON Pointer
 * 差异。StateDiff 的 kind 字段与 FirstDivergence 的多余字段按
 * T008 任务说明原样展示（T010 才处理），不剥离、不新增字段。
 */
import type { DualTrackEvaluation, PathResult } from "../replay/planner.js";
import { VERDICT_LABELS, VERDICT_DESCRIPTIONS, type AnalysisResult } from "./analyze.js";

export interface StateDiffProps {
  readonly result: AnalysisResult | null;
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 20)}…` : hash;
}

function sharedStateText(sharedState: unknown): string {
  if (sharedState === undefined) return "（尚无基线）";
  const text = JSON.stringify(sharedState);
  if (text === undefined) return "（无法序列化）";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function PathSummary(props: { readonly title: string; readonly path: PathResult | null }) {
  const { title, path } = props;
  if (path === null) {
    return (
      <div className="path-summary">
        <h3>{title}</h3>
        <p>（无终态：分析未完成或输入无效）</p>
      </div>
    );
  }
  return (
    <div className="path-summary">
      <h3>{title}</h3>
      <dl className="meta-list">
        <div>
          <dt>终态哈希</dt>
          <dd>
            <code title={path.finalStateHash}>{shortHash(path.finalStateHash)}</code>
          </dd>
        </div>
        <div>
          <dt>消息数</dt>
          <dd>{path.messages.length}</dd>
        </div>
        <div>
          <dt>工具调用数</dt>
          <dd>{path.toolCalls.length}</dd>
        </div>
        <div>
          <dt>待处理工具调用</dt>
          <dd>{path.pendingToolCallIds.length === 0 ? "无" : path.pendingToolCallIds.join(", ")}</dd>
        </div>
        <div>
          <dt>运行状态</dt>
          <dd>{path.runStatus}</dd>
        </div>
        <div>
          <dt>共享状态</dt>
          <dd>
            <code>{sharedStateText(path.sharedState)}</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function StateDiff(props: StateDiffProps) {
  const { result } = props;
  if (result === null) {
    return (
      <section className="panel state-diff" aria-label="双轨状态对照">
        <h2>双轨状态对照</h2>
        <p className="hint">导入事件文件并点击“开始”后，这里展示完整路径与恢复路径的终态对照。</p>
      </section>
    );
  }
  const { evaluation, durationMs } = result;
  const divergence = evaluation.firstDivergence;
  return (
    <section className="panel state-diff" aria-label="双轨状态对照">
      <h2>双轨状态对照</h2>

      <p className="verdict-line">
        裁决：
        <strong className={`verdict verdict-${evaluation.verdict.toLowerCase()}`}>
          {VERDICT_LABELS[evaluation.verdict]}（{evaluation.verdict}）
        </strong>
        <span className="hint"> — {VERDICT_DESCRIPTIONS[evaluation.verdict]}</span>
      </p>
      <p className="meta-line">
        场景 {evaluation.scenarioId} · 检查点 sourceIndex {evaluation.checkpointIndex} ·
        访问状态 {evaluation.metrics.visitedStates} · 分析耗时 {durationMs} 毫秒
        {evaluation.droppedSourceIndices.length > 0 && (
          <span> · 注入丢弃的事件 sourceIndex：{evaluation.droppedSourceIndices.join(", ")}</span>
        )}
      </p>

      <div className="paths">
        <PathSummary title="完整路径终态" path={evaluation.fullPath} />
        <PathSummary title="恢复路径终态" path={evaluation.resumePath} />
      </div>

      {divergence !== null ? (
        <div className="divergence">
          <h3>首个分歧</h3>
          <dl className="meta-list">
            <div>
              <dt>sourceIndex</dt>
              <dd data-testid="first-divergence-source-index">{divergence.sourceIndex}</dd>
            </div>
            {divergence.eventType !== undefined && (
              <div>
                <dt>事件类型</dt>
                <dd>
                  <code>{divergence.eventType}</code>
                </dd>
              </div>
            )}
            {divergence.messageId !== undefined && (
              <div>
                <dt>messageId</dt>
                <dd>{divergence.messageId}</dd>
              </div>
            )}
            {divergence.toolCallId !== undefined && (
              <div>
                <dt>toolCallId</dt>
                <dd>{divergence.toolCallId}</dd>
              </div>
            )}
            {divergence.runId !== undefined && (
              <div>
                <dt>runId</dt>
                <dd>{divergence.runId}</dd>
              </div>
            )}
            <div>
              <dt>完整路径状态哈希</dt>
              <dd>
                <code title={divergence.fullStateHash}>{shortHash(divergence.fullStateHash)}</code>
              </dd>
            </div>
            <div>
              <dt>恢复路径状态哈希</dt>
              <dd>
                <code title={divergence.resumeStateHash}>{shortHash(divergence.resumeStateHash)}</code>
              </dd>
            </div>
            {divergence.note !== undefined && (
              <div>
                <dt>对齐说明</dt>
                <dd>{divergence.note}</dd>
              </div>
            )}
          </dl>
          {divergence.differences.length > 0 && (
            <>
              <h4>字段差异（JSON Pointer，expected = 完整路径，actual = 恢复路径）</h4>
              <table>
                <thead>
                  <tr>
                    <th scope="col">JSON Pointer</th>
                    <th scope="col">类型（kind）</th>
                    <th scope="col">expected</th>
                    <th scope="col">actual</th>
                  </tr>
                </thead>
                <tbody>
                  {divergence.differences.map((diff, index) => (
                    <tr key={`${diff.jsonPointer}-${index}`}>
                      <td>
                        <code>{diff.jsonPointer}</code>
                      </td>
                      <td>{diff.kind}</td>
                      <td>
                        <code>{JSON.stringify(diff.expected) ?? "（缺失）"}</code>
                      </td>
                      <td>
                        <code>{JSON.stringify(diff.actual) ?? "（缺失）"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : (
        <p className="hint">未定位到首个分歧（双轨各步状态一致，或未达到分歧判定条件）。</p>
      )}
    </section>
  );
}
