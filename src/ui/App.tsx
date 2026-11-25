/**
 * P031 RejoinLab — T008: React 主界面。
 *
 * 布局：顶部控制区（导入 / 实验参数 / 运行控制）+ 结果区
 * （双轨状态对照 / 诊断）。分析全部委托给 src/ui/analyze.ts
 *（T002 解析 + T005 双轨评估）；界面不重新实现 Reducer。
 *
 * 运行控制语义（T008 阶段，分析在主线程同步完成，T009 才移入
 * Web Worker）：
 * - 开始：把分析发往 Web Worker（src/worker/client.ts），状态置为
 *   “运行中”，Worker 回传结果后展示。无 Worker API 的环境
 *   （如 jsdom 测试环境）用同一份 Worker 协议 host 在当前线程内
 *   执行，界面会注明；真实浏览器中永远使用独立 Worker 线程。
 * - 暂停：仅在“运行中”可用，取消 Worker 任务（CANCEL 消息 +
 *   terminate 线程），状态置为“已暂停”，不产生结果。
 * - 重置：清除分析结果与运行状态，保留已导入事件与实验配置。
 * - 清空：清除全部界面数据（文件、事件、诊断、配置、结果），
 *   恢复默认配置；不触碰任何持久化存储（本应用不写入
 *   localStorage / IndexedDB）。
 */
import { useRef, useState } from "react";
import type { NormalizedEvent } from "../protocol/types.js";
import type { ParseDiagnostic } from "../parser/index.js";
import {
  DEFAULT_SCENARIO,
  PROTOCOL_VERSION,
  SPEC_VERSION,
  describeInjection,
  detectFormat,
  importEvents,
  type AnalysisResult,
  type ScenarioConfig,
  type SourceFormat,
} from "./analyze.js";
import { ImportPanel, type FormatMode } from "./ImportPanel.js";
import { ScenarioPanel } from "./ScenarioPanel.js";
import { StateDiff } from "./StateDiff.js";
import { Diagnostics } from "./Diagnostics.js";
import { Timeline } from "./Timeline.js";
import { ExportPanel } from "./ExportPanel.js";
import {
  buildReportFromWorkerResult,
  downloadReportJson,
  reportHash,
} from "../report/json.js";
import { downloadReportHtml } from "../report/html.js";
import {
  RejoinWorkerClient,
  WorkerCancelledError,
  type WorkerMode,
} from "../worker/client.js";
import type { WorkerAnalysisResult } from "../worker/protocol.js";

export type RunStatus = "idle" | "running" | "paused" | "done" | "error";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  idle: "未运行",
  running: "运行中",
  paused: "已暂停",
  done: "已完成",
  error: "运行出错",
};

function scenarioIdFor(fileName: string | null): string {
  if (fileName === null) return "UI-IMPORT";
  const base = fileName.replace(/\.[^.]*$/, "");
  return base === "" ? "UI-IMPORT" : base;
}

export function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [formatMode, setFormatMode] = useState<FormatMode>("auto");
  const [format, setFormat] = useState<SourceFormat | null>(null);
  const [events, setEvents] = useState<readonly NormalizedEvent[]>([]);
  // T010：导入文件的原文（仅内存）。报告的 input.sourceSha256 对
  // 其 UTF-8 字节计算；清空时一并清除（§15.1）。
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [parseDiagnostics, setParseDiagnostics] = useState<readonly ParseDiagnostic[]>([]);
  const [scenario, setScenario] = useState<ScenarioConfig>(DEFAULT_SCENARIO);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [workerResult, setWorkerResult] = useState<WorkerAnalysisResult | null>(null);
  const [workerMode, setWorkerMode] = useState<WorkerMode | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [runError, setRunError] = useState<string | null>(null);

  // 暂停信号：开始后、计算前被置位即取消本次分析。
  const pauseRequestedRef = useRef(false);
  // 防止一次已取消的运行覆盖更新的运行结果。
  const runIdRef = useRef(0);
  // T009：Worker 客户端（懒创建；同一客户端复用于多次运行）。
  const workerClientRef = useRef<RejoinWorkerClient | null>(null);

  const getWorkerClient = (): RejoinWorkerClient => {
    if (workerClientRef.current === null) {
      const client = new RejoinWorkerClient();
      workerClientRef.current = client;
      setWorkerMode(client.mode);
    }
    return workerClientRef.current;
  };

  const handleFileText = (text: string, name: string): void => {
    const resolvedFormat =
      formatMode === "auto" ? detectFormat(name, text) : formatMode;
    const imported = importEvents(text, resolvedFormat);
    setFileName(name);
    setFormat(imported.format);
    setSourceText(text);
    setResult(null);
    setWorkerResult(null);
    setRunStatus("idle");
    setRunError(null);
    if (imported.ok) {
      setEvents(imported.events);
      setParseDiagnostics([]);
      // 新导入默认不断线；保留用户已选的恢复策略与注入配置。
      setScenario((current) => ({ ...current, disconnectAfter: undefined }));
    } else {
      setEvents([]);
      setParseDiagnostics(imported.diagnostics);
    }
  };

  const handleRun = (): void => {
    if (events.length === 0) return;
    const runId = ++runIdRef.current;
    pauseRequestedRef.current = false;
    setRunStatus("running");
    setRunError(null);
    // T009：分析在 Worker 中执行（主线程不跑 evaluateFixture）。
    // Worker 回传的结果与 T008 主线程 runAnalysis 的结果一致
    // （同一 evaluateFixture，见 tests/worker/parity）。
    const client = getWorkerClient();
    void client.analyze(events, scenario, scenarioIdFor(fileName)).then(
      (analysis) => {
        if (runId !== runIdRef.current) return;
        if (pauseRequestedRef.current) {
          setRunStatus("paused");
          return;
        }
        setWorkerResult(analysis);
        // AnalysisResult 仍按 T008 的形状组装，供 StateDiff /
        // Diagnostics 使用；scenario 取 Worker 回显的生效配置
        // （F3：运行时刻快照）。
        setResult({
          evaluation: analysis.evaluation,
          durationMs: analysis.durationMs,
          scenario: analysis.scenario,
        });
        setRunStatus("done");
      },
      (error: unknown) => {
        if (runId !== runIdRef.current) return;
        if (error instanceof WorkerCancelledError) {
          setRunStatus("paused");
          return;
        }
        setRunError(error instanceof Error ? error.message : String(error));
        setRunStatus("error");
      },
    );
  };

  const handlePause = (): void => {
    pauseRequestedRef.current = true;
    // T009：真正取消 Worker 任务（CANCEL + terminate 线程）。
    workerClientRef.current?.cancel();
    setRunStatus("paused");
  };

  const handleReset = (): void => {
    runIdRef.current += 1;
    pauseRequestedRef.current = false;
    workerClientRef.current?.cancel();
    setResult(null);
    setWorkerResult(null);
    setRunStatus("idle");
    setRunError(null);
  };

  const handleClear = (): void => {
    runIdRef.current += 1;
    pauseRequestedRef.current = false;
    workerClientRef.current?.cancel();
    setFileName(null);
    setFormat(null);
    setEvents([]);
    setSourceText(null);
    setParseDiagnostics([]);
    setScenario(DEFAULT_SCENARIO);
    setResult(null);
    setWorkerResult(null);
    setRunStatus("idle");
    setRunError(null);
  };

  const canRun = events.length > 0 && runStatus !== "running";

  // T010：导出在点击时才组装报告（Worker 评估 + T005 BFS 最短
  // 序列），不在分析完成时预跑 BFS。
  const buildCurrentReport = (): {
    report: ReturnType<typeof buildReportFromWorkerResult>["report"];
    bfsVisited: number;
  } | null => {
    if (workerResult === null || sourceText === null || format === null) {
      return null;
    }
    return buildReportFromWorkerResult(workerResult, events, {
      scenarioId: scenarioIdFor(fileName),
      sourceFormat: format === "jsonl" ? "JSONL" : "SSE",
      sourceText,
    });
  };

  const handleDownloadJson = (): void => {
    const built = buildCurrentReport();
    if (built === null) return;
    downloadReportJson(built.report);
  };

  const handleDownloadHtml = (): void => {
    const built = buildCurrentReport();
    if (built === null || workerResult === null) return;
    downloadReportHtml(built.report, {
      reportHash: reportHash(built.report),
      bfsVisited: built.bfsVisited,
      fullRunStatus: workerResult.evaluation.fullPath?.runStatus,
      resumeRunStatus: workerResult.evaluation.resumePath?.runStatus,
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>RejoinLab — 续流证</h1>
        <p>
          AG-UI {PROTOCOL_VERSION} 事件流续接与对话状态一致性实验室 · 规格 v{SPEC_VERSION} ·
          本地离线运行，数据只保留在当前浏览器内存中
        </p>
      </header>

      <div className="run-bar" aria-label="运行控制">
        <span>
          运行状态：<strong data-testid="run-status">{RUN_STATUS_LABELS[runStatus]}</strong>
        </span>
        <span className="run-buttons">
          <button type="button" onClick={handleRun} disabled={!canRun}>
            开始
          </button>
          <button type="button" onClick={handlePause} disabled={runStatus !== "running"}>
            暂停
          </button>
          <button type="button" onClick={handleReset} disabled={result === null && runStatus === "idle"}>
            重置
          </button>
          <button type="button" onClick={handleClear}>
            清空
          </button>
        </span>
      </div>

      {runError !== null && (
        <p className="error" role="alert">
          运行出错：{runError}
        </p>
      )}

      {workerMode === "in-process" && (
        <p className="hint" data-testid="worker-mode-note">
          当前环境不支持 Web Worker，分析在当前线程内按 Worker 协议执行；真实浏览器中使用独立 Worker 线程。
        </p>
      )}

      <main className="layout">
        <ImportPanel
          fileName={fileName}
          formatMode={formatMode}
          format={format}
          events={events}
          diagnostics={parseDiagnostics}
          onFileText={handleFileText}
          onFormatModeChange={setFormatMode}
          disabled={runStatus === "running"}
        />
        <ScenarioPanel
          eventCount={events.length}
          config={scenario}
          onChange={setScenario}
          disabled={runStatus === "running"}
        />
      </main>

      {result !== null && (
        <section className="result-meta" aria-label="实验配置回显">
          <h2>本次实验配置</h2>
          <p>
            恢复策略：{result.scenario.strategy}；断线位置：
            {result.scenario.disconnectAfter === undefined
              ? "不断线"
              : `在 sourceIndex ${result.scenario.disconnectAfter} 处断线（已交付 ${result.scenario.disconnectAfter + 1} 条）`}
            ；故障注入：
            {result.scenario.injections.length === 0
              ? "无"
              : result.scenario.injections.map(describeInjection).join("；")}
          </p>
        </section>
      )}

      <div className="results">
        <StateDiff result={result} />
        <Diagnostics diagnostics={result === null ? [] : result.evaluation.diagnostics} />
      </div>

      <Timeline result={workerResult} />

      <ExportPanel
        result={workerResult}
        onDownloadJson={handleDownloadJson}
        onDownloadHtml={handleDownloadHtml}
      />

      <footer className="app-footer">
        <p>
          边界说明：本界面只比较给定事件轨迹在两条恢复路径下的规范化状态；CONSISTENT
          不等于真实 Agent 后端正确，也不证明 exactly-once。AG-UI 1.0 HTTP+SSE
          本身不支持流恢复，这里的游标只是本地实验路径。
        </p>
      </footer>
    </div>
  );
}
