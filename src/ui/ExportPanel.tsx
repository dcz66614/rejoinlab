/**
 * P031 RejoinLab — T010: 报告导出面板。
 *
 * 只做展示与下载触发，不做任何业务计算：
 * - 报告由 App 在点击时组装（src/report/json.ts 的
 *   buildReportFromWorkerResult：Worker 评估 + T005 BFS 最短序列），
 *   本面板只接收“可下载”的回调；
 * - 摘要取自 Worker 返回的 evaluation（即界面上展示的那一份）；
 * - 下载走 Blob + URL.createObjectURL（src/report 的下载函数），
 *   不写 localStorage / IndexedDB / sessionStorage，不用 innerHTML。
 */
import type { WorkerAnalysisResult } from "../worker/protocol.js";
import { VERDICT_LABELS } from "./analyze.js";

export interface ExportPanelProps {
  /** Worker 分析结果；为 null 时面板只提示“运行后可导出”。 */
  readonly result: WorkerAnalysisResult | null;
  /** 点击“下载 JSON 报告”时由 App 组装并下载报告。 */
  readonly onDownloadJson: () => void;
  /** 点击“下载 HTML 报告”时由 App 组装并下载报告。 */
  readonly onDownloadHtml: () => void;
  readonly disabled?: boolean;
}

export function ExportPanel(props: ExportPanelProps) {
  const { result, onDownloadJson, onDownloadHtml, disabled = false } = props;
  const canExport = result !== null && !disabled;
  return (
    <section className="panel export-panel" aria-label="导出报告">
      <h2>导出报告</h2>
      {result === null ? (
        <p className="hint">运行分析后可导出 JSON 与独立 HTML 报告。</p>
      ) : (
        <>
          <p>
            裁决：{result.evaluation.verdict} ·{" "}
            {VERDICT_LABELS[result.evaluation.verdict]}；诊断{" "}
            {result.evaluation.diagnostics.length} 条；分析耗时{" "}
            {result.durationMs} 毫秒。
          </p>
          <p className="hint">
            JSON 报告遵循 rejoinlab.report/v1；HTML
            报告完全自包含：无远程资源，断开网络也可独立打开。
          </p>
          <div className="export-buttons">
            <button
              type="button"
              onClick={onDownloadJson}
              disabled={!canExport}
              data-testid="download-json"
            >
              下载 JSON 报告
            </button>{" "}
            <button
              type="button"
              onClick={onDownloadHtml}
              disabled={!canExport}
              data-testid="download-html"
            >
              下载 HTML 报告
            </button>
          </div>
        </>
      )}
    </section>
  );
}
