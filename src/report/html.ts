/**
 * P031 RejoinLab — T010: 完全自包含的 HTML 报告导出。
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §13 (报告内容)、§15.2 (HTML 报告中的
 *   所有用户文本必须正确转义；不加载远程脚本/字体；不允许远程
 *   资源请求)、§12.4 (分歧点必须有文字和位置说明；不允许仅依赖
 *   颜色区分结果)、§18 (诚实边界：能力边界与结果解释的文本来源）。
 *
 * 自包含保证：
 * - 输出是单个 HTML 文件：样式全部内联在 <style> 中；无 <link>、
 *   无 <script>、无 <img>、无外链 CSS/JS/字体/图片；不引用任何
 *   远程资源（模板本身不含任何 URL；用户文本中的 URL 只作为转义
 *   后的纯文本出现，永不进入 href/src 等属性）。
 * - 无 JavaScript：纯静态 HTML，断开网络、脱离开发服务器也可
 *   直接打开；不读不写任何存储。
 * - 确定性：渲染不读时间、不读随机数，同一报告两次渲染字节相同。
 *
 * 转义：所有用户文本（场景名、消息内容、诊断消息、证据与状态
 * 的 JSON 原文、嵌入的完整 JSON 报告）一律经 escapeHtml 输出；
 * 模板中没有任何位置用字符串拼接把未转义的用户文本写进 HTML。
 */

import type { RejoinReport } from "./schema.js";
import {
  downloadTextFile,
  reportFileName,
  serializeReport,
} from "./json.js";

/**
 * HTML 转义：& < > " ' 全部转义。覆盖所有用户文本的输出位置；
 * JSON 原文先经 JSON.stringify 再转义，因此其中的 </pre>、
 * </script> 等序列也不可能闭合标签。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 五种裁决的中文说明（PROJECT_BOOK §7，与 ui/analyze.ts 同文）。 */
export const REPORT_VERDICT_LABELS: Record<RejoinReport["verdict"], string> = {
  CONSISTENT: "一致",
  INCONSISTENT: "不一致",
  INCONCLUSIVE_LIMIT: "超出计算边界",
  INVALID_INPUT: "输入无效",
  INCOMPLETE_TRACE: "轨迹不完整",
};

export const REPORT_VERDICT_DESCRIPTIONS: Record<
  RejoinReport["verdict"],
  string
> = {
  CONSISTENT: "双轨规范化状态相等，无 CRITICAL 诊断。",
  INCONSISTENT: "双轨状态不同，或出现可证实的关键故障。",
  INCONCLUSIVE_LIMIT: "超出计算边界（事件数、搜索节点或时间限制），无法得出一致性结论。",
  INVALID_INPUT: "输入无效：格式错误、必需字段缺失或无法解析的协议事件。",
  INCOMPLETE_TRACE: "轨迹不完整：缺少必要终止信息或无法确认恢复完整性。",
};

/** renderReportHtml 的补充展示信息（均不属于 JSON 报告字段）。 */
export interface ReportHtmlExtras {
  /** 报告哈希（A-02：剔除 durationMs 的 JCS 哈希），由调用方算好传入。 */
  readonly reportHash?: string;
  /** BFS 访问节点数（T005 analyzeFixture 的 bfsVisited）。 */
  readonly bfsVisited?: number;
  /** 完整路径终态 runStatus（§13.2 PathResult 无此字段，仅 HTML 展示）。 */
  readonly fullRunStatus?: string;
  /** 恢复路径终态 runStatus（同上）。 */
  readonly resumeRunStatus?: string;
}

const STYLE = [
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;margin:2em auto;max-width:960px;padding:0 1em;color:#1a1a1a;background:#fff}",
  "h1{font-size:1.5em;border-bottom:2px solid #1a1a1a;padding-bottom:.3em}",
  "h2{font-size:1.2em;margin-top:2em;border-bottom:1px solid #ccc;padding-bottom:.2em}",
  "table{border-collapse:collapse;width:100%;margin:.5em 0}",
  "th,td{border:1px solid #ccc;padding:.4em .6em;text-align:left;vertical-align:top}",
  "th{background:#f0f0f0}",
  "pre{background:#f6f6f6;padding:.8em;overflow-x:auto;white-space:pre-wrap;word-break:break-word}",
  "code{word-break:break-all}",
  ".verdict{font-size:1.1em;font-weight:bold;padding:.4em .8em;border:2px solid #1a1a1a;display:inline-block}",
  ".verdict-consistent{border-color:#1a7f37;background:#e6f4ea}",
  ".verdict-inconsistent{border-color:#b3261e;background:#fce8e6}",
  ".verdict-incomplete{border-color:#b06000;background:#fef3e2}",
  ".verdict-invalid{border-color:#b3261e;background:#fce8e6}",
  ".verdict-limit{border-color:#b06000;background:#fef3e2}",
  ".muted{color:#555}",
  "footer{margin-top:3em;border-top:1px solid #ccc;padding-top:1em;color:#555;font-size:.9em}",
  "@media (max-width:480px){body{margin:1em auto}table{font-size:.9em}}",
].join("\n");

function verdictClass(verdict: RejoinReport["verdict"]): string {
  switch (verdict) {
    case "CONSISTENT":
      return "verdict-consistent";
    case "INCONSISTENT":
      return "verdict-inconsistent";
    case "INCOMPLETE_TRACE":
      return "verdict-incomplete";
    case "INVALID_INPUT":
      return "verdict-invalid";
    case "INCONCLUSIVE_LIMIT":
      return "verdict-limit";
  }
}

function jsonPre(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2) ?? "null");
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value) ?? "—";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pathSection(
  title: string,
  path: RejoinReport["fullPath"],
  runStatus: string | undefined,
): string {
  if (path === null) {
    return (
      `<h3>${escapeHtml(title)}</h3>` +
      `<p class="muted">无终态：本次分析未产出该路径的终态（输入无效或超出计算边界）。</p>`
    );
  }
  const rows: string[] = [];
  rows.push(`<h3>${escapeHtml(title)}</h3>`);
  rows.push(
    `<p>终态哈希：<code>${escapeHtml(path.finalStateHash)}</code>` +
      (runStatus !== undefined
        ? ` · 终态 runStatus：${escapeHtml(runStatus)}`
        : "") +
      `</p>`,
  );
  rows.push(
    `<p>消息 ${path.messages.length} 条 · 工具调用 ${path.toolCalls.length} 条 · ` +
      `待处理工具调用：${path.pendingToolCallIds.length === 0 ? "无" : escapeHtml(path.pendingToolCallIds.join("、"))}</p>`,
  );
  if (path.messages.length > 0) {
    rows.push(
      "<table><thead><tr><th>消息 id</th><th>角色</th><th>内容</th></tr></thead><tbody>" +
        path.messages
          .map((entry) => {
            const message = asRecord(entry);
            const id = message === null ? "—" : text(message["id"]);
            const role = message === null ? "—" : text(message["role"]);
            const content =
              message === null ? "—" : text(message["content"]);
            return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(role)}</td><td>${escapeHtml(content)}</td></tr>`;
          })
          .join("") +
        "</tbody></table>",
    );
  }
  if (path.toolCalls.length > 0) {
    rows.push(
      "<table><thead><tr><th>工具调用 id</th><th>名称</th><th>状态</th><th>已有结果</th></tr></thead><tbody>" +
        path.toolCalls
          .map((entry) => {
            const call = asRecord(entry);
            const id = call === null ? "—" : text(call["id"]);
            const name = call === null ? "—" : text(call["name"]);
            const status = call === null ? "—" : text(call["status"]);
            const hasResult =
              call === null
                ? "—"
                : call["hasResult"] === true
                  ? "是"
                  : "否";
            return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(hasResult)}</td></tr>`;
          })
          .join("") +
        "</tbody></table>",
    );
  }
  rows.push(`<h4>共享状态</h4><pre>${jsonPre(path.sharedState)}</pre>`);
  return rows.join("\n");
}

/**
 * 渲染完全自包含的 HTML 报告（单个文件，无远程资源、无脚本）。
 * 纯函数：同一报告 + 同一 extras 得到同一字节。
 */
export function renderReportHtml(
  report: RejoinReport,
  extras: ReportHtmlExtras = {},
): string {
  const verdictLabel = REPORT_VERDICT_LABELS[report.verdict];
  const verdictDescription = REPORT_VERDICT_DESCRIPTIONS[report.verdict];
  const parts: string[] = [];

  parts.push("<!doctype html>");
  parts.push('<html lang="zh-CN">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push(
    `<title>RejoinLab 报告 — ${escapeHtml(report.scenarioId)}</title>`,
  );
  parts.push(`<style>\n${STYLE}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");

  parts.push(`<h1>RejoinLab 报告 — ${escapeHtml(report.scenarioId)}</h1>`);
  parts.push(
    `<p class="muted">Schema ${escapeHtml(report.schema)} · 规格 v${escapeHtml(report.specVersion)} · 协议 v${escapeHtml(report.protocolVersion)}</p>`,
  );

  parts.push("<h2>裁决</h2>");
  parts.push(
    `<p><span class="verdict ${verdictClass(report.verdict)}">${escapeHtml(report.verdict)} · ${escapeHtml(verdictLabel)}</span></p>`,
  );
  parts.push(`<p>${escapeHtml(verdictDescription)}</p>`);

  parts.push("<h2>摘要</h2>");
  parts.push("<table><tbody>");
  const summaryRows: Array<[string, string]> = [
    ["场景", report.scenarioId],
    ["输入格式", report.input.sourceFormat],
    ["事件数", String(report.input.eventCount)],
    ["输入 SHA-256", report.input.sourceSha256],
    ["恢复策略", report.recovery.strategy],
    [
      "断线位置",
      report.recovery.disconnectAfter === undefined
        ? "不断线"
        : `在 sourceIndex ${report.recovery.disconnectAfter} 处断线`,
    ],
    [
      "恢复游标",
      report.recovery.resumeAfterSourceIndex === undefined
        ? "未指定"
        : `sourceIndex ${report.recovery.resumeAfterSourceIndex}`,
    ],
    ["分析耗时", `${report.metrics.durationMs} 毫秒（仅作展示，不进入报告哈希）`],
    ["访问状态数", String(report.metrics.visitedStates)],
  ];
  if (extras.bfsVisited !== undefined) {
    summaryRows.push(["BFS 访问节点数", String(extras.bfsVisited)]);
  }
  if (extras.reportHash !== undefined) {
    summaryRows.push([
      "报告哈希（剔除 durationMs）",
      extras.reportHash,
    ]);
  }
  for (const [key, value] of summaryRows) {
    parts.push(
      `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`,
    );
  }
  parts.push("</tbody></table>");

  parts.push("<h2>双轨终态</h2>");
  parts.push(pathSection("完整路径", report.fullPath, extras.fullRunStatus));
  parts.push(pathSection("恢复路径", report.resumePath, extras.resumeRunStatus));

  parts.push("<h2>首个分歧</h2>");
  if (report.firstDivergence === undefined) {
    parts.push("<p>无首个分歧：逐事件步进比较未发现状态差异。</p>");
  } else {
    const divergence = report.firstDivergence;
    parts.push(
      `<p>首个分歧位置：${divergence.sourceIndex === undefined ? "未定位到具体事件（分支内序号）" : `sourceIndex ${divergence.sourceIndex}`}</p>`,
    );
    parts.push(
      `<p>完整路径状态哈希：<code>${escapeHtml(divergence.fullStateHash)}</code><br>` +
        `恢复路径状态哈希：<code>${escapeHtml(divergence.resumeStateHash)}</code></p>`,
    );
    if (divergence.differences.length === 0) {
      parts.push("<p>字段级差异：无（哈希不同但字段比较未列出差异）。</p>");
    } else {
      parts.push(
        "<table><thead><tr><th>JSON Pointer</th><th>完整路径（expected）</th><th>恢复路径（actual）</th></tr></thead><tbody>" +
          divergence.differences
            .map(
              (difference) =>
                `<tr><td><code>${escapeHtml(difference.jsonPointer)}</code></td>` +
                `<td><pre>${jsonPre(difference.expected)}</pre></td>` +
                `<td><pre>${jsonPre(difference.actual)}</pre></td></tr>`,
            )
            .join("") +
          "</tbody></table>",
      );
    }
  }

  parts.push("<h2>诊断</h2>");
  if (report.diagnostics.length === 0) {
    parts.push(
      "<p>无诊断。注意：无诊断不等于 Agent 后端正确，只说明本次双轨比较未发现可证实的不一致。</p>",
    );
  } else {
    const criticalCount = report.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "CRITICAL",
    ).length;
    parts.push(
      `<p>共 ${report.diagnostics.length} 条：严重（CRITICAL）${criticalCount} 条，警告（WARNING）${report.diagnostics.length - criticalCount} 条。</p>`,
    );
    parts.push(
      "<table><thead><tr><th>代码</th><th>级别</th><th>sourceIndex</th><th>消息</th><th>证据</th></tr></thead><tbody>" +
        report.diagnostics
          .map((diagnostic) => {
            const severityText =
              diagnostic.severity === "CRITICAL" ? "CRITICAL · 严重" : "WARNING · 警告";
            const sourceIndex =
              diagnostic.sourceIndex === undefined
                ? "—"
                : String(diagnostic.sourceIndex);
            return (
              `<tr><td><strong>${escapeHtml(diagnostic.code)}</strong></td>` +
              `<td>${escapeHtml(severityText)}</td>` +
              `<td>${escapeHtml(sourceIndex)}</td>` +
              `<td>${escapeHtml(diagnostic.message)}</td>` +
              `<td><pre>${jsonPre(diagnostic.evidence)}</pre></td></tr>`
            );
          })
          .join("") +
        "</tbody></table>",
    );
  }

  parts.push("<h2>最短故障注入序列</h2>");
  if (report.shortestInjectionSequence === null) {
    parts.push(
      "<p>未计算：本次分析未得出注入序列（未运行 BFS / 无序列可达 / 输入无效或超限）。</p>",
    );
  } else if (report.shortestInjectionSequence.length === 0) {
    parts.push(
      "<p>无注入序列：目标在无注入时已达成。</p>",
    );
  } else {
    parts.push(
      "<ol>" +
        report.shortestInjectionSequence
          .map((operator) => `<li><code>${escapeHtml(operator)}</code></li>`)
          .join("") +
        "</ol>",
    );
  }

  parts.push("<h2>假设</h2>");
  parts.push(
    "<ul>" +
      report.assumptions
        .map((assumption) => `<li>${escapeHtml(assumption)}</li>`)
        .join("") +
      "</ul>",
  );

  parts.push("<h2>能力边界与局限</h2>");
  parts.push(
    "<ul>" +
      report.limitations
        .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
        .join("") +
      "</ul>",
  );
  parts.push(
    "<p>本报告只证明：在给定的 AG-UI 1.0 事件子集、已导入事件序列、初始状态、快照语义、恢复游标、有界事件轨迹与固定故障注入规则范围内，完整事件流与恢复事件流产生的规范化状态是否相等、首个可定位的状态分歧在哪里、以及最短故障注入序列是什么。CONSISTENT 的正确解释是“在本次给定轨迹与规则下两条路径得到相同的规范化状态”，不等于这个 Agent 在所有真实网络故障下都不会丢消息或重复调用工具；INCONCLUSIVE_LIMIT 的正确解释是“搜索边界不足以支持一致性结论”，不是“没有找到错误，所以安全”。</p>",
  );

  parts.push("<h2>完整 JSON 报告</h2>");
  parts.push(
    `<details><summary>展开查看 rejoinlab.report/v1 JSON 原文</summary><pre id="report-json">${escapeHtml(serializeReport(report))}</pre></details>`,
  );

  parts.push(
    "<footer><p>本文件完全自包含：样式内嵌，不引用任何远程资源，不依赖网络、开发服务器、CDN 或远程字体，断开网络也可独立打开。本报告不上传任何数据；输入文件只保留在浏览器内存中。</p></footer>",
  );

  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

/** 下载 HTML 报告（与 downloadReportJson 同一下载机制）。 */
export function downloadReportHtml(
  report: RejoinReport,
  extras: ReportHtmlExtras = {},
): void {
  downloadTextFile(
    reportFileName(report, "html"),
    renderReportHtml(report, extras),
    "text/html",
  );
}
