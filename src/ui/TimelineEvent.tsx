/**
 * P031 RejoinLab — T009: 时间线上一条事件的展示行。
 *
 * 只做展示：从 TrackEventView（Worker 已算好的视图）取字段渲染，
 * 不做任何分析、不重排顺序。所有标记同时用文字与样式表示，
 * 不只依赖颜色（PROJECT_BOOK §12.4）。点击后由父组件展示原始 JSON。
 */
import type { TrackEventView } from "../worker/protocol.js";

export interface TimelineEventProps {
  readonly view: TrackEventView;
  readonly track: "full" | "resume";
  readonly selected: boolean;
  /** 是否为逐步回放当前步的事件。 */
  readonly isCurrentStep: boolean;
  readonly onSelect: (view: TrackEventView) => void;
}

function businessId(view: TrackEventView): string | null {
  const event = view.event as unknown as Record<string, unknown>;
  for (const key of ["messageId", "toolCallId", "runId"]) {
    if (typeof event[key] === "string") {
      return `${key} ${event[key] as string}`;
    }
  }
  if (typeof event["parentMessageId"] === "string") {
    return `parentMessageId ${event["parentMessageId"] as string}`;
  }
  return null;
}

function deltaSnippet(view: TrackEventView): string | null {
  const event = view.event as unknown as Record<string, unknown>;
  if (typeof event["delta"] === "string") {
    const delta = event["delta"] as string;
    if (delta === "") return "（空 delta）";
    return delta.length > 24 ? `${delta.slice(0, 24)}…` : delta;
  }
  if (view.eventType === "STATE_SNAPSHOT") return "替换共享状态";
  if (view.eventType === "MESSAGES_SNAPSHOT") return "消息集合快照";
  return null;
}

export function TimelineEvent(props: TimelineEventProps) {
  const { view, track, selected, isCurrentStep, onSelect } = props;
  const id = businessId(view);
  const snippet = deltaSnippet(view);
  const classes = [
    "timeline-event",
    selected ? "timeline-event-selected" : "",
    isCurrentStep ? "timeline-event-current" : "",
    view.isDropped ? "timeline-event-dropped" : "",
    view.isFirstDivergence ? "timeline-event-divergence" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <li>
      <button
        type="button"
        className={classes}
        onClick={() => onSelect(view)}
        aria-pressed={selected}
        data-testid={`timeline-event-${track}-${view.sourceIndex}-${view.appliedPosition}`}
        data-source-index={view.sourceIndex}
        data-track={track}
        title={
          view.isOutOfOrder
            ? `应用位置 ${view.appliedPosition}，按 sourceIndex 排序后不在此位（乱序）`
            : undefined
        }
      >
        <span className="timeline-event-index">#{view.sourceIndex}</span>
        <code className="timeline-event-type">{view.eventType}</code>
        {id !== null && <span className="timeline-event-id">{id}</span>}
        {snippet !== null && <span className="timeline-event-snippet">{snippet}</span>}
        {view.isSnapshot && (
          <span className="timeline-badge badge-snapshot" title="快照事件">
            快照
          </span>
        )}
        {view.isDisconnectPoint && (
          <span className="timeline-badge badge-disconnect" title="断线点：完整路径在此 sourceIndex 之后中断，恢复基线覆盖至此">
            断线点
          </span>
        )}
        {view.isResumePoint && (
          <span className="timeline-badge badge-resume" title="恢复点：恢复路径从此事件开始应用">
            恢复点
          </span>
        )}
        {view.isReplayedPrefix && (
          <span className="timeline-badge badge-replayed" title="该事件已在检查点覆盖范围内，恢复时又重放了一次">
            重放前缀
          </span>
        )}
        {view.isDuplicate && (
          <span className="timeline-badge badge-duplicate" title="重复事件：同一事件在恢复路径中被应用了多次">
            重复
          </span>
        )}
        {view.isDropped && (
          <span className="timeline-badge badge-dropped" title="丢失事件：该事件未进入恢复路径">
            丢失
          </span>
        )}
        {view.isOutOfOrder && (
          <span className="timeline-badge badge-outoforder" title="乱序事件：应用位置与 sourceIndex 顺序不同">
            乱序
          </span>
        )}
        {view.isFirstDivergence && (
          <span className="timeline-badge badge-divergence" title="首个分歧：双轨状态从此事件开始不一致">
            首个分歧
          </span>
        )}
        {view.diagnostics.map((diagnostic, index) => (
          <span
            key={`${diagnostic.code}-${index}`}
            className={`timeline-badge badge-diagnostic severity-${diagnostic.severity.toLowerCase()}`}
            title={`诊断 ${diagnostic.code}（${diagnostic.severity}）`}
          >
            {diagnostic.code}
          </span>
        ))}
      </button>
    </li>
  );
}
