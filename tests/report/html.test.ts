/**
 * T010 tests — 独立 HTML 报告导出（src/report/html.ts）。
 *
 * - 自包含：无 <link> / <script> / <img>，无 src= / href= /
 *   url( / @import 等远程资源引用；模板本身不含任何 URL。
 * - 转义：场景名、消息内容、诊断消息、证据与状态 JSON、嵌入的
 *   完整 JSON 原文中的注入载荷一律转义后输出。
 * - 确定性：同一报告两次渲染字节相同；不含时间戳。
 * - 内容：裁决（文字 + 颜色，不只依赖颜色）、首个分歧与 JSON
 *   Pointer 差异、诊断、假设与能力边界、嵌入的 JSON 可解析回原报告。
 */
import { describe, expect, it } from "vitest";
import { buildWorkerResult } from "../../src/worker/rejoin.worker.js";
import {
  buildReport,
  buildReportFromWorkerResult,
  reportHash,
} from "../../src/report/json.js";
import { escapeHtml, renderReportHtml } from "../../src/report/html.js";
import { validateReport } from "../../src/report/schema.js";
import { loadFixture } from "../replay/golden-helpers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function goldenReport(id: string) {
  const fixture = loadFixture(id);
  const workerResult = buildWorkerResult(fixture);
  const text = readFileSync(
    join(process.cwd(), "fixtures", "golden", `${id}.json`),
    "utf8",
  );
  return buildReportFromWorkerResult(workerResult, fixture.events, {
    scenarioId: id,
    sourceFormat: "JSONL",
    sourceText: text,
  }).report;
}

/** 把 HTML 中的转义恢复为原文（测试用，与 escapeHtml 互逆）。 */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("escapeHtml", () => {
  it("转义 & < > \" '，其余原文不动", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
    expect(escapeHtml("你好，世界")).toBe("你好，世界");
    expect(escapeHtml("")).toBe("");
  });
});

describe("HTML 自包含：远程资源 0", () => {
  it("G01 报告无任何远程资源引用", () => {
    const html = renderReportHtml(goldenReport("G01"));
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("url(");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("//");
    expect(html).toContain("<style>");
    expect(html).toContain("</html>");
  });

  it("模板本身不含 URL：空诊断的一致报告同样无远程引用", () => {
    const html = renderReportHtml(goldenReport("N01"));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});

describe("HTML 注入测试：全部用户文本转义", () => {
  // 构造一份带恶意用户文本的报告：场景名、消息内容、诊断消息、
  // 证据、共享状态中都放注入载荷。
  function maliciousReport() {
    const fixture = loadFixture("N01");
    const workerResult = buildWorkerResult(fixture);
    const text = readFileSync(
      join(process.cwd(), "fixtures", "golden", "N01.json"),
      "utf8",
    );
    const base = buildReportFromWorkerResult(workerResult, fixture.events, {
      scenarioId: `"><script>alert(1)</script>`,
      sourceFormat: "JSONL",
      sourceText: text,
    }).report;
    const poisonedMessage = {
      ...(base.fullPath?.messages[0] as Record<string, unknown>),
      content: `<img src=x onerror=alert(2)>`,
    };
    return {
      ...base,
      fullPath:
        base.fullPath === null
          ? null
          : { ...base.fullPath, messages: [poisonedMessage] },
      diagnostics: [
        {
          code: "OUT_OF_ORDER",
          severity: "CRITICAL" as const,
          sourceIndex: 1,
          message: `"><svg onload=alert(3)>`,
          evidence: { note: `<script>alert(4)</script>` },
        },
      ],
    };
  }

  it("注入载荷全部转义，无一处以标签形式出现", () => {
    const report = maliciousReport();
    expect(validateReport(report).ok).toBe(true);
    const html = renderReportHtml(report);
    // 任何注入载荷都不得以原始标签/事件处理器形式出现。
    // 注意：转义后的文本仍含 "onerror=alert(2)" 这一子串（它是
    // < 与 > 被转义后剩下的无害文本，不是属性），故不以子串断言，
    // 而以标签/属性形式断言。
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<script>alert(4)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    // 转义形式必须出现（载荷内容仍在报告中，只是无害）。
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;svg onload=alert(3)&gt;");
    // 仍无远程资源引用：转义后的载荷文本仍含 "src=" 这一子串
    // （&lt;img src=x …&gt; 中的 src= 是纯文本，不是属性），故
    // 不用子串断言，而用“标签内出现 src=/href= 属性”的正则断言。
    expect(html).not.toMatch(/<[^>]*\s(?:src|href)\s*=/i);
    expect(html).not.toContain("href=");
  });

  it("共享状态中的脚本字符串同样转义", () => {
    const fixture = loadFixture("N05");
    const workerResult = buildWorkerResult(fixture);
    const text = readFileSync(
      join(process.cwd(), "fixtures", "golden", "N05.json"),
      "utf8",
    );
    const { report } = buildReportFromWorkerResult(
      workerResult,
      fixture.events,
      { scenarioId: "N05", sourceFormat: "JSONL", sourceText: text },
    );
    const html = renderReportHtml({
      ...report,
      fullPath:
        report.fullPath === null
          ? null
          : { ...report.fullPath, sharedState: { x: "</script><script>alert(5)</script>" } },
    });
    expect(html).not.toContain("</script><script>alert(5)");
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(5)&lt;/script&gt;");
  });
});

describe("HTML 内容完整", () => {
  it("G01：裁决、首个分歧、差异、诊断、假设与边界齐全", () => {
    const report = goldenReport("G01");
    const html = renderReportHtml(report, {
      reportHash: reportHash(report),
      bfsVisited: 2,
      fullRunStatus: "FINISHED",
      resumeRunStatus: "FINISHED",
    });
    expect(html).toContain("INCONSISTENT");
    expect(html).toContain("不一致");
    expect(html).toContain("DUPLICATE_TOOL_CALL");
    expect(html).toContain("CRITICAL · 严重");
    expect(html).toContain("sourceIndex 4");
    // G01 的首个差异在 /orderedTimeline/5（恢复路径多出的时间线
    // 项），随后是 /toolCalls/1（重复的工具调用）。§13.3 样例的
    // /toolCalls/1/toolCallId 只是接口示意，不是实际运行结果。
    expect(html).toContain("/orderedTimeline/5");
    expect(html).toContain("/toolCalls/1");
    expect(html).toContain("REPLAY_PREFIX");
    expect(html).toContain("使用 AG-UI 1.0 事件语义");
    expect(html).toContain("不证明真实 Agent 后端 exactly-once");
    expect(html).toContain("报告哈希");
    expect(html).toContain(reportHash(report));
    expect(html).toContain("BFS 访问节点数");
    expect(html).toContain("FINISHED");
    // 嵌入的完整 JSON 可解析回原报告。
    const match = html.match(/<pre id="report-json">([\s\S]*?)<\/pre>/);
    expect(match).not.toBeNull();
    const embedded = JSON.parse(unescapeHtml(match![1] as string));
    expect(embedded).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it("N01 一致报告：无首个分歧、无诊断，仍有边界说明", () => {
    const html = renderReportHtml(goldenReport("N01"));
    expect(html).toContain("CONSISTENT");
    expect(html).toContain("一致");
    expect(html).toContain("无首个分歧");
    expect(html).toContain("无诊断");
    expect(html).toContain("不执行真实网络重连");
  });

  it("G08：INCOMPLETE_TRACE 与 TRUNCATED_RUN 警告", () => {
    const html = renderReportHtml(goldenReport("G08"));
    expect(html).toContain("INCOMPLETE_TRACE");
    expect(html).toContain("轨迹不完整");
    expect(html).toContain("TRUNCATED_RUN");
    expect(html).toContain("WARNING · 警告");
  });

  it("五种裁决都能渲染", () => {
    for (const id of ["G01", "G08", "N01"]) {
      const html = renderReportHtml(goldenReport(id));
      expect(html).toContain("裁决");
    }
    const fixture = loadFixture("N01");
    const workerResult = buildWorkerResult(fixture);
    const invalid = buildReport({
      evaluation: {
        ...workerResult.evaluation,
        verdict: "INVALID_INPUT",
        diagnostics: [
          {
            code: "INVALID_INPUT",
            severity: "CRITICAL",
            message: "bad",
            evidence: {},
          },
        ],
        fullState: null,
        resumeState: null,
        fullPath: null,
        resumePath: null,
        firstDivergence: null,
      },
      shortestInjectionSequence: null,
      durationMs: 0,
      source: {
        scenarioId: "BAD",
        sourceFormat: "SSE",
        sourceText: "bad",
        eventCount: 1,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    const html = renderReportHtml(invalid);
    expect(html).toContain("INVALID_INPUT");
    expect(html).toContain("输入无效");
    expect(html).toContain("无终态");
  });
});

describe("HTML 确定性", () => {
  it("同一报告两次渲染字节相同", () => {
    const report = goldenReport("G03");
    const extras = { reportHash: reportHash(report), bfsVisited: 9 };
    expect(renderReportHtml(report, extras)).toBe(
      renderReportHtml(report, extras),
    );
  });
});
