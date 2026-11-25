/**
 * P031 RejoinLab — T008: 导入面板。
 *
 * 文件选择 / 拖放导入 JSONL 或 SSE 文本，委托 T002 解析。
 * 只展示解析结果与诊断，不做任何分析。用户输入一律经 React 文本
 * 节点渲染，绝不使用 innerHTML / dangerouslySetInnerHTML。
 */
import { useRef, useState } from "react";
import type { NormalizedEvent } from "../protocol/types.js";
import type { ParseDiagnostic } from "../parser/index.js";
import { PROTOCOL_VERSION, type SourceFormat } from "./analyze.js";

export type FormatMode = "auto" | SourceFormat;

export interface ImportPanelProps {
  readonly fileName: string | null;
  readonly formatMode: FormatMode;
  readonly format: SourceFormat | null;
  readonly events: readonly NormalizedEvent[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly onFileText: (text: string, fileName: string) => void;
  readonly onFormatModeChange: (mode: FormatMode) => void;
  readonly disabled: boolean;
}

function eventIdentity(event: NormalizedEvent): string {
  const raw = event.event as unknown as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof raw["messageId"] === "string") parts.push(`messageId=${raw["messageId"]}`);
  if (typeof raw["toolCallId"] === "string") parts.push(`toolCallId=${raw["toolCallId"]}`);
  if (typeof raw["runId"] === "string") parts.push(`runId=${raw["runId"]}`);
  if (typeof raw["delta"] === "string") {
    const delta = raw["delta"] as string;
    parts.push(`delta=${delta.length > 24 ? `${delta.slice(0, 24)}…` : delta}`);
  }
  if (event.transportEventId !== null) parts.push(`SSE id=${event.transportEventId}`);
  return parts.join(" · ");
}

export function ImportPanel(props: ImportPanelProps) {
  const { fileName, formatMode, format, events, diagnostics, onFileText, onFormatModeChange, disabled } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const readFile = (file: File): void => {
    setReadError(null);
    file
      .text()
      .then((text) => onFileText(text, file.name))
      .catch((error: unknown) => {
        setReadError(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file !== undefined) readFile(file);
  };

  return (
    <section className="panel import-panel" aria-label="导入事件文件">
      <h2>导入事件文件</h2>

      <div
        className={dragOver ? "drop-zone drag-over" : "drop-zone"}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        role="region"
        aria-label="拖放导入区"
      >
        <p>把 .jsonl 或 .sse 文件拖到这里，或</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          选择文件
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl,.sse,.txt,application/json,text/plain"
          className="visually-hidden"
          aria-label="选择事件文件"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 允许同一文件重复选择：读完即清空 input 值。
            event.target.value = "";
            if (file !== undefined) readFile(file);
          }}
        />
        <p className="hint">仅本地解析，不上传；文件内容只保留在当前浏览器内存中。</p>
      </div>

      <label className="field">
        <span>文件格式</span>
        <select
          value={formatMode}
          disabled={disabled}
          onChange={(event) => onFormatModeChange(event.target.value as FormatMode)}
          aria-label="文件格式"
        >
          <option value="auto">自动识别（按后缀 / 内容）</option>
          <option value="jsonl">JSONL（一行一个事件）</option>
          <option value="sse">SSE（Server-Sent Events 文本）</option>
        </select>
      </label>

      <dl className="meta-list">
        <div>
          <dt>协议版本</dt>
          <dd>AG-UI {PROTOCOL_VERSION}</dd>
        </div>
        <div>
          <dt>已导入文件</dt>
          <dd>{fileName ?? "未导入"}</dd>
        </div>
        <div>
          <dt>识别格式</dt>
          <dd>{format === null ? "—" : format === "jsonl" ? "JSONL" : "SSE"}</dd>
        </div>
        <div>
          <dt>事件数量</dt>
          <dd data-testid="event-count">{events.length} 条</dd>
        </div>
      </dl>

      {readError !== null && (
        <p className="error" role="alert">
          {readError}
        </p>
      )}

      {diagnostics.length > 0 && (
        <div className="parse-errors" role="alert">
          <h3>解析错误（{diagnostics.length} 条）</h3>
          <ul>
            {diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <strong>{diagnostic.code}</strong>
                {diagnostic.sourceIndex !== undefined && (
                  <span> · sourceIndex {diagnostic.sourceIndex}</span>
                )}
                {diagnostic.line !== undefined && <span> · 第 {diagnostic.line} 行</span>}
                {diagnostic.eventType !== undefined && <span> · {diagnostic.eventType}</span>}
                {diagnostic.field !== undefined && <span> · 字段 {diagnostic.field}</span>}
                <div>{diagnostic.message}</div>
              </li>
            ))}
          </ul>
          <p className="hint">解析失败时不返回部分事件序列，事件不会进入 Reducer。</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="event-list">
          <h3>源事件流（按 sourceIndex 顺序）</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">事件类型</th>
                <th scope="col">业务标识 / 内容</th>
              </tr>
            </thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.sourceIndex}>
                  <td>{item.sourceIndex}</td>
                  <td>
                    <code>{item.event.type}</code>
                  </td>
                  <td>{eventIdentity(item) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
