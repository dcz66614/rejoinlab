/**
 * @vitest-environment jsdom
 *
 * T010 tests — 导出面板与下载流程（src/ui/ExportPanel.tsx、
 * src/report/json.ts 与 html.ts 的下载函数）。
 *
 * 注意：jsdom 环境下 import.meta.url 解析不到夹具文件（T002–T009
 * 的 jsdom 测试同样只用内联数据），本文件一律手工构造最小
 * Worker 结果与报告，不读 fixtures/golden；Golden 实测对照由
 * node 环境的 tests/report/json.test.ts 与 html.test.ts 覆盖。
 *
 * - 无结果时只提示，不提供下载按钮；有结果时展示裁决并可点击；
 * - 点击回调恰好触发一次；disabled 时按钮不可点；
 * - 下载走 Blob + URL.createObjectURL：Blob 内容与序列化报告 /
 *   渲染 HTML 逐字节一致，文件名取 scenarioId 安全化形式；
 * - 不写任何持久化存储（另有 tests/ui/security.test.ts 对 src/ui
 *   做静态扫描）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  buildReport,
  downloadReportJson,
  reportFileName,
  serializeReport,
} from "../../src/report/json.js";
import { downloadReportHtml, renderReportHtml } from "../../src/report/html.js";
import { ExportPanel } from "../../src/ui/ExportPanel.js";
import { App } from "../../src/ui/App.js";
import type { WorkerAnalysisResult } from "../../src/worker/protocol.js";
import type { RejoinReport } from "../../src/report/schema.js";
import { validateReport } from "../../src/report/schema.js";
import { createHash } from "node:crypto";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 面板只读 verdict / diagnostics.length / durationMs：最小形状即可。 */
function fakeWorkerResult(): WorkerAnalysisResult {
  return {
    evaluation: {
      scenarioId: "G01",
      verdict: "INCONSISTENT",
      diagnostics: [
        {
          code: "DUPLICATE_TOOL_CALL",
          severity: "CRITICAL",
          sourceIndex: 2,
          message: "dup",
          evidence: { toolCallId: "call-1" },
        },
      ],
      firstDivergence: null,
      fullState: null,
      resumeState: null,
      fullPath: null,
      resumePath: null,
      droppedSourceIndices: [],
      checkpointIndex: 4,
      metrics: { visitedStates: 8 },
    },
    durationMs: 7,
    scenario: { strategy: "FULL_REPLAY_FROM_START", injections: [] },
    importedEventCount: 6,
    expandedEventCount: 9,
    fullTrack: [],
    resumeTrack: [],
    fullHistory: [],
    resumeHistory: [],
    fullBaseState: null as never,
    resumeBaseState: null as never,
    resumeAfterSourceIndex: 0,
    checkpointIndex: 4,
    checkpointOrigin: "foldPrefix",
    notes: [],
  };
}

function fakeReport(scenarioId = "G01"): RejoinReport {
  const path = {
    finalStateHash: "b".repeat(64),
    messages: [],
    toolCalls: [],
    sharedState: {},
    pendingToolCallIds: [],
    runStatus: "FINISHED",
  };
  return buildReport({
    evaluation: {
      scenarioId,
      verdict: "INCONSISTENT",
      diagnostics: [
        {
          code: "DUPLICATE_TOOL_CALL",
          severity: "CRITICAL",
          sourceIndex: 2,
          message: "dup",
          evidence: { toolCallId: "call-1" },
        },
      ],
      firstDivergence: null,
      fullState: null,
      resumeState: null,
      fullPath: path,
      resumePath: path,
      droppedSourceIndices: [],
      checkpointIndex: 4,
      metrics: { visitedStates: 8 },
    },
    shortestInjectionSequence: ["REPLAY_PREFIX"],
    durationMs: 7,
    source: {
      scenarioId,
      sourceFormat: "JSONL",
      sourceText: "{}",
      eventCount: 6,
    },
    recovery: {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      resumeAfterSourceIndex: 0,
    },
  });
}

function minimalReport(scenarioId: string): RejoinReport {
  return {
    schema: "rejoinlab.report/v1",
    specVersion: "1.0.2",
    protocolVersion: "1.0",
    scenarioId,
    verdict: "CONSISTENT",
    input: {
      sourceFormat: "JSONL",
      eventCount: 1,
      sourceSha256: "a".repeat(64),
    },
    recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    fullPath: null,
    resumePath: null,
    diagnostics: [],
    shortestInjectionSequence: [],
    metrics: { durationMs: 0, visitedStates: 0 },
    assumptions: ["x"],
    limitations: ["y"],
  };
}

describe("ExportPanel 展示", () => {
  it("无结果时提示运行后可导出，无下载按钮", () => {
    render(
      <ExportPanel
        result={null}
        onDownloadJson={vi.fn()}
        onDownloadHtml={vi.fn()}
      />,
    );
    expect(screen.getByText(/运行分析后可导出/)).toBeDefined();
    expect(screen.queryByTestId("download-json")).toBeNull();
    expect(screen.queryByTestId("download-html")).toBeNull();
  });

  it("有结果时展示裁决与诊断数，点击各回调恰好一次", () => {
    const onDownloadJson = vi.fn();
    const onDownloadHtml = vi.fn();
    render(
      <ExportPanel
        result={fakeWorkerResult()}
        onDownloadJson={onDownloadJson}
        onDownloadHtml={onDownloadHtml}
      />,
    );
    expect(screen.getByText(/INCONSISTENT/)).toBeDefined();
    expect(screen.getByText(/rejoinlab\.report\/v1/)).toBeDefined();
    fireEvent.click(screen.getByTestId("download-json"));
    fireEvent.click(screen.getByTestId("download-html"));
    expect(onDownloadJson).toHaveBeenCalledTimes(1);
    expect(onDownloadHtml).toHaveBeenCalledTimes(1);
  });

  it("disabled 时按钮不可点", () => {
    const onDownloadJson = vi.fn();
    render(
      <ExportPanel
        result={fakeWorkerResult()}
        onDownloadJson={onDownloadJson}
        onDownloadHtml={vi.fn()}
        disabled
      />,
    );
    const button = screen.getByTestId("download-json");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onDownloadJson).not.toHaveBeenCalled();
  });
});

describe("reportFileName", () => {
  it("scenarioId 安全化：斜杠、空格、尖括号全部替换，无路径穿越", () => {
    // "../../etc/passwd"：每个 / 换成 -，结果为 ..-..-etc-passwd。
    expect(reportFileName(minimalReport("../../etc/passwd"), "json")).toBe(
      "rejoinlab-..-..-etc-passwd.report.json",
    );
    expect(reportFileName(minimalReport("../../etc/passwd"), "html")).toBe(
      "rejoinlab-..-..-etc-passwd.report.html",
    );
    expect(reportFileName(minimalReport("G01"), "json")).toBe(
      "rejoinlab-G01.report.json",
    );
    expect(reportFileName(minimalReport(`"><script>`), "json")).not.toContain(
      "<",
    );
    expect(reportFileName(minimalReport(""), "json")).toBe(
      "rejoinlab-report.report.json",
    );
  });
});

describe("下载流程（Blob + URL.createObjectURL）", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:mock-url");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    clickedAnchors = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      },
    );
  });

  it("downloadReportJson：Blob 内容与序列化报告一致，文件名正确，URL 被回收", async () => {
    const report = fakeReport("G01");
    downloadReportJson(report);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe(serializeReport(report));
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0]?.download).toBe("rejoinlab-G01.report.json");
    expect(clickedAnchors[0]?.href).toBe("blob:mock-url");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("downloadReportHtml：Blob 内容与渲染 HTML 一致，MIME 为 text/html", async () => {
    const report = fakeReport("N01");
    downloadReportHtml(report);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/html");
    expect(await blob.text()).toBe(renderReportHtml(report));
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0]?.download).toBe("rejoinlab-N01.report.html");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});

describe("App 接线：导入→运行→导出（真实 App 渲染）", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:mock-url");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    clickedAnchors = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      },
    );
  });

  // 与 G01 同构的故障轨迹：检查点后 FULL_REPLAY 重放已关闭的 call-1。
  const FAULTY_JSONL = [
    '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
    '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
    '{"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"search","parentMessageId":"msg-1"}',
    '{"type":"TOOL_CALL_ARGS","toolCallId":"call-1","delta":"{\\"q\\":\\"x\\"}"}',
    '{"type":"TOOL_CALL_END","toolCallId":"call-1"}',
    '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
  ].join("\n");

  async function importAndRun(): Promise<void> {
    render(<App />);
    const input = screen.getByLabelText("选择事件文件") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([FAULTY_JSONL], "faulty.jsonl")] },
    });
    await screen.findByText("6 条");
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    fireEvent.change(screen.getByLabelText("断线位置"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByLabelText(/重放已处理前缀/));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("不一致（INCONSISTENT）");
  }

  it("下载 JSON：Blob 内容是通过 Schema 校验的报告，最短序列与 SHA-256 逐值一致", async () => {
    await importAndRun();
    fireEvent.click(screen.getByTestId("download-json"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const report = JSON.parse(await blob.text()) as RejoinReport;
    expect(validateReport(report)).toEqual({ ok: true, errors: [] });
    expect(report.scenarioId).toBe("faulty");
    expect(report.verdict).toBe("INCONSISTENT");
    expect(report.shortestInjectionSequence).toEqual(["REPLAY_PREFIX"]);
    expect(report.input.sourceFormat).toBe("JSONL");
    expect(report.input.eventCount).toBe(6);
    expect(report.input.sourceSha256).toBe(
      createHash("sha256").update(Buffer.from(FAULTY_JSONL, "utf8")).digest("hex"),
    );
    expect(report.firstDivergence?.sourceIndex).toBe(4);
    expect(clickedAnchors[0]?.download).toBe("rejoinlab-faulty.report.json");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("下载 HTML：Blob 为自包含报告，无脚本标签", async () => {
    await importAndRun();
    fireEvent.click(screen.getByTestId("download-html"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const html = await blob.text();
    expect(html).toContain("INCONSISTENT");
    expect(html).toContain("REPLAY_PREFIX");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("href=");
    expect(clickedAnchors[0]?.download).toBe("rejoinlab-faulty.report.html");
  });
});
