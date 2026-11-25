/**
 * P031 RejoinLab — T012: 安全验证（scripts/verify_security.ts）。
 *
 * 验收命令：npm run test:security（T012 新建）。
 *
 * 8 组真实用例，全部调用生产代码并断言其行为（不是静态期望）：
 * 1. HTML 注入：含 <script>/<img onerror>/<svg onload> 的消息内容与
 *    场景名 → 渲染 HTML 报告；断言输出中不存在注入标签/事件属性，
 *    且载荷只以转义文本出现；两次渲染字节相同。
 * 2. escapeHtml 单元：& < > " ' 五字符全转义。
 * 3. JSON 超大输入：>1 MiB 全文与 >64 KiB 单事件 → ParseError
 *    INCONCLUSIVE_LIMIT（T002 冻结编码：尺寸超限属计算边界，
 *    见 normalize.ts checkInputSize/checkEventSize；输入被拒绝，
 *    永不静默截断）。
 * 4. 深层嵌套：10,000 层 JSON 文本 → ParseError（进程存活）；500 层
 *    对象进 RUN_STARTED input.state → 归约完成并计时。
 * 5. 非法 JSON Patch：未知 op 被丢弃且文档不变；缺失路径/非法指针
 *    → 失败且原文档不变；STATE_DELTA 端到端：未知 op 记
 *    UNKNOWN_PATCH_OP、失败 op 记 SNAPSHOT_MISMATCH，共享状态不变。
 * 6. 超过事件上限：41 事件 → INCONCLUSIVE_LIMIT。
 * 7. Worker 取消：host 层 ANALYZE 后立即 CANCEL → 只收到 CANCELLED、
 *    无 RESULT；client 层 cancel() → WorkerCancelledError。
 * 8. 未知事件：未知 type → ParseError INVALID_INPUT；已知但 MVP 不
 *    支持的 type（STEP_STARTED）→ ParseError INCONCLUSIVE_LIMIT。
 * 9. 静态扫描：src/ + index.html + vite.config.ts（去注释后）不得含
 *    innerHTML / dangerouslySetInnerHTML / eval( / new Function /
 *    document.write / localStorage / sessionStorage / indexedDB /
 *    fetch( / XMLHttpRequest / WebSocket。
 *
 * 任一失败即 exit 1。日志：artifacts/logs/T012_SECURITY.log。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { applyJsonPatch } from "../src/core/snapshot.js";
import { reduceEvent } from "../src/core/reducer.js";
import { initialState } from "../src/core/state.js";
import { parseJsonl } from "../src/parser/jsonl.js";
import { ParseError } from "../src/parser/normalize.js";
import { evaluateFixture, type ReplayFixture } from "../src/replay/planner.js";
import { escapeHtml, renderReportHtml } from "../src/report/html.js";
import { buildReport } from "../src/report/json.js";
import { analyzeFixture } from "../src/replay/search.js";
import { RejoinWorkerClient, WorkerCancelledError } from "../src/worker/client.js";
import { createWorkerHost } from "../src/worker/rejoin.worker.js";
import type { ScenarioConfig } from "../src/ui/analyze.js";
import { ev, norm, runStart } from "../tests/core/helpers.js";

const ROOT = `${process.cwd().replace(/\/$/, "")}/`;
if (!existsSync(`${ROOT}package.json`)) {
  throw new Error(`verify script must run from the project root (cwd=${process.cwd()})`);
}
const LOG_PATH = `${ROOT}artifacts/logs/T012_SECURITY.log`;

const lines: string[] = [];
const failures: string[] = [];

function log(line = ""): void {
  lines.push(line);
  console.log(line);
}

function check(name: string, ok: boolean, detail: string): void {
  log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

const startedAt = new Date().toISOString();
const head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
log("T012 SECURITY — RejoinLab 安全验证");
log(`startedAt(UTC): ${startedAt}`);
log(`HEAD: ${head}`);
log(`node: ${process.version} (${process.platform}/${process.arch})`);
log("");

/* ---------------- 1. HTML 注入 ---------------- */
log("1. HTML injection (payload in message content + scenarioId):");
const PAYLOAD = `<script>alert("xss")</script><img src=x onerror=alert(2)>`;
const SCENARIO_PAYLOAD = `"><svg onload=alert(3)>`;
const injectionFixture: ReplayFixture = {
  scenarioId: SCENARIO_PAYLOAD,
  events: norm([
    runStart("t1", "r1"),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: PAYLOAD }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    ev("RUN_FINISHED", { threadId: "t1", runId: "r1" }),
  ]),
  recovery: { strategy: "FULL_REPLAY_FROM_START" },
};
const injectionAnalysis = analyzeFixture(injectionFixture, null);
const injectionReport = buildReport({
  evaluation: injectionAnalysis.evaluation,
  shortestInjectionSequence: injectionAnalysis.shortestInjectionSequence,
  durationMs: 0,
  source: {
    scenarioId: SCENARIO_PAYLOAD,
    sourceFormat: "JSONL",
    sourceText: JSON.stringify(injectionFixture.events),
    eventCount: injectionFixture.events.length,
  },
  recovery: { strategy: "FULL_REPLAY_FROM_START" },
});
const htmlA = renderReportHtml(injectionReport);
const htmlB = renderReportHtml(injectionReport);
const tagNames = new Set([...htmlA.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "h1", "h2", "h3", "h4",
  "p", "span", "table", "thead", "tbody", "tr", "th", "td", "pre", "code",
  "ol", "li", "ul", "details", "summary", "footer",
]);
const unexpectedTags = [...tagNames].filter((t) => !ALLOWED_TAGS.has(t));
log(`  rendered bytes: ${Buffer.byteLength(htmlA, "utf8")}`);
log(`  tags present: ${[...tagNames].sort().join(", ")}`);
log(`  escaped payload present: ${htmlA.includes("&lt;script&gt;")} / ${htmlA.includes("&lt;img")}`);
check("注入后 HTML 无 script/img/svg 等注入标签", unexpectedTags.length === 0, unexpectedTags.length === 0 ? "tags ⊆ template allowlist" : `unexpected: ${unexpectedTags.join(", ")}`);
check("注入后 HTML 无事件处理属性", !/<[^>]*\son\w+\s*=/.test(htmlA), "no on*= attribute in any tag");
check("注入后 HTML 无 href=/src= 属性（标签内）", !/<[^>]*\s(?:href|src)\s*=/.test(htmlA), "no href/src attribute in any tag (escaped payload text may still contain the substring)");
check("注入后 HTML 无 javascript: 伪协议", !htmlA.toLowerCase().includes("javascript:"), "no javascript: substring");
check("载荷以转义文本出现（&lt;script&gt; / &lt;img）", htmlA.includes("&lt;script&gt;") && htmlA.includes("&lt;img"), "escaped payload visible as text");
check("场景名载荷已转义（无 <svg onload）", !htmlA.includes("<svg") && htmlA.includes("&lt;svg"), "scenarioId escaped in <title>/<h1>");
check("同一报告两次渲染字节相同", htmlA === htmlB, `${Buffer.byteLength(htmlA, "utf8")} bytes both runs`);

/* ---------------- 2. escapeHtml 单元 ---------------- */
log("");
log("2. escapeHtml unit:");
const escaped = escapeHtml(`<>&"'`);
log(`  escapeHtml("<>&\\" '") = ${escaped}`);
check("五字符全转义", escaped === "&lt;&gt;&amp;&quot;&#39;", escaped);

/* ---------------- 3. 超大输入 ---------------- */
log("");
log("3. Oversized JSON input (§8.1: 1 MiB total, 64 KiB/event):");
const bigLine = `{"type":"RUN_STARTED","threadId":"t","runId":"r"}${" ".repeat(1024 * 1024)}`;
try {
  parseJsonl(bigLine);
  check(">1 MiB 输入被拒绝", false, "parseJsonl did not throw");
} catch (error) {
  const ok = error instanceof ParseError && error.code === "INCONCLUSIVE_LIMIT";
  log(`  >1 MiB: threw ${error instanceof Error ? error.name : typeof error} code=${error instanceof ParseError ? error.code : "?"}`);
  check(">1 MiB 输入 → ParseError INCONCLUSIVE_LIMIT（拒绝，不截断）", ok, error instanceof Error ? error.message.slice(0, 120) : "?");
}
const bigEvent = `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"${"x".repeat(70 * 1024)}"}`;
try {
  parseJsonl(bigEvent);
  check(">64 KiB 单事件被拒绝", false, "parseJsonl did not throw");
} catch (error) {
  const ok = error instanceof ParseError && error.code === "INCONCLUSIVE_LIMIT";
  log(`  >64 KiB event: threw ${error instanceof Error ? error.name : typeof error} code=${error instanceof ParseError ? error.code : "?"}`);
  check(">64 KiB 单事件 → ParseError INCONCLUSIVE_LIMIT（拒绝，不截断）", ok, error instanceof Error ? error.message.slice(0, 120) : "?");
}

/* ---------------- 4. 深层嵌套 ---------------- */
log("");
log("4. Deep nesting:");
const deepText = "[".repeat(10_000) + "]".repeat(10_000);
try {
  parseJsonl(deepText);
  check("10,000 层 JSON 文本被拒绝", false, "parseJsonl did not throw");
} catch (error) {
  const ok = error instanceof ParseError && error.code === "INVALID_INPUT";
  log(`  10,000-deep text: threw ${error instanceof Error ? error.name : typeof error} code=${error instanceof ParseError ? error.code : "?"}`);
  check("10,000 层 JSON 文本 → ParseError（进程存活）", ok, "no crash, no hang");
}
function nestedObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i += 1) obj = { nested: obj };
  return obj;
}
const deepState = nestedObject(500);
const t0 = performance.now();
let deepStateOk = false;
try {
  let state = initialState();
  state = reduceEvent(
    state,
    runStart("t1", "r1", { input: { threadId: "t1", runId: "r1", messages: [], state: deepState } }),
  );
  deepStateOk = JSON.stringify(state.sharedState) === JSON.stringify(deepState);
} catch (error) {
  log(`  500-deep state: threw ${error instanceof Error ? error.message : String(error)}`);
}
const deepMs = performance.now() - t0;
log(`  500-deep object in RUN_STARTED input.state: ${deepMs.toFixed(2)} ms, preserved=${deepStateOk}`);
check("500 层嵌套共享状态归约完成且值不变", deepStateOk, `${deepMs.toFixed(2)} ms`);
check("500 层嵌套归约 < 1,000 ms", deepMs < 1000, `${deepMs.toFixed(2)} ms`);

/* ---------------- 5. 非法 JSON Patch ---------------- */
log("");
log("5. Illegal JSON Patch:");
const doc = { count: 1, nested: { a: "x" } };
const docBefore = JSON.stringify(doc);
const unknownOp = applyJsonPatch(doc, [{ op: "explode", path: "/count", value: 2 }] as never);
log(`  unknown op "explode": ok=${unknownOp.ok}, discarded=${JSON.stringify(unknownOp.discardedUnknownOps)}, doc unchanged=${JSON.stringify(doc) === docBefore}`);
check("未知 op 被丢弃且文档不变", unknownOp.discardedUnknownOps.length === 1 && unknownOp.discardedUnknownOps[0]?.op === "explode" && JSON.stringify(doc) === docBefore, `discarded=${unknownOp.discardedUnknownOps.length}`);
const missingPath = applyJsonPatch(doc, [{ op: "remove", path: "/nope" }]);
log(`  remove missing path: ok=${missingPath.ok}, reason=${missingPath.reason}, value is original=${missingPath.value === doc}`);
check("删除不存在路径 → 失败且返回原文档", missingPath.ok === false && missingPath.value === doc, `reason=${missingPath.reason}`);
const badPointer = applyJsonPatch(doc, [{ op: "replace", path: "count", value: 9 }]);
log(`  invalid pointer "count": ok=${badPointer.ok}, reason=${badPointer.reason}`);
check("非法指针 → 失败且原文档不变", badPointer.ok === false && JSON.stringify(doc) === docBefore, `reason=${badPointer.reason}`);
// 端到端：STATE_DELTA 经 Reducer
let state = initialState();
state = reduceEvent(state, runStart("t1", "r1", { input: { threadId: "t1", runId: "r1", messages: [], state: { count: 1 } } }));
const sharedBefore = JSON.stringify(state.sharedState);
state = reduceEvent(state, ev("STATE_DELTA", { delta: [{ op: "explode", path: "/count", value: 2 }] }));
const unknownDiag = state.diagnostics?.filter((d) => d.code === "UNKNOWN_PATCH_OP") ?? [];
log(`  STATE_DELTA unknown op: UNKNOWN_PATCH_OP diagnostics=${unknownDiag.length}, sharedState unchanged=${JSON.stringify(state.sharedState) === sharedBefore}`);
check("STATE_DELTA 未知 op → UNKNOWN_PATCH_OP 且共享状态不变", unknownDiag.length === 1 && JSON.stringify(state.sharedState) === sharedBefore, `diagnostics=${unknownDiag.length}`);
state = reduceEvent(state, ev("STATE_DELTA", { delta: [{ op: "remove", path: "/nope" }] }));
const failDiag = state.diagnostics?.filter((d) => d.code === "SNAPSHOT_MISMATCH") ?? [];
log(`  STATE_DELTA failing op: SNAPSHOT_MISMATCH diagnostics=${failDiag.length}, sharedState unchanged=${JSON.stringify(state.sharedState) === sharedBefore}`);
check("STATE_DELTA 失败 op → SNAPSHOT_MISMATCH 且共享状态不变", failDiag.length === 1 && JSON.stringify(state.sharedState) === sharedBefore, `diagnostics=${failDiag.length}`);

/* ---------------- 6. 超过事件上限 ---------------- */
log("");
log("6. Over event limit (41 events):");
const manyEvents = Array.from({ length: 41 }, (_, i) => ({
  sourceIndex: i,
  sourceEventKey: null,
  transportEventId: null,
  event: ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: `x${i}` }),
}));
const overFixture: ReplayFixture = {
  scenarioId: "T-41",
  events: [
    { sourceIndex: 0, sourceEventKey: null, transportEventId: null, event: runStart("t1", "r1") },
    ...manyEvents.slice(1),
  ],
  recovery: { strategy: "FULL_REPLAY_FROM_START" },
};
log(`  events: ${overFixture.events.length}`);
const overResult = evaluateFixture(overFixture);
log(`  verdict=${overResult.verdict}, diagnostics=[${overResult.diagnostics.map((d) => d.code).join(",")}]`);
check("41 事件 → INCONCLUSIVE_LIMIT", overResult.verdict === "INCONCLUSIVE_LIMIT", `verdict=${overResult.verdict}`);

/* ---------------- 7. Worker 取消 ---------------- */
log("");
log("7. Worker cancel:");
const hostResponses: string[] = [];
const host = createWorkerHost((response) => {
  hostResponses.push(`${response.type}:${response.jobId}`);
});
host.handleMessage({ type: "ANALYZE", jobId: "t012-cancel-1", input: injectionFixture });
host.handleMessage({ type: "CANCEL", jobId: "t012-cancel-1" });
await new Promise((r) => setTimeout(r, 500));
log(`  host responses after ANALYZE+CANCEL: [${hostResponses.join(", ")}]`);
check("host 层取消 → 只收到 CANCELLED、无 RESULT", hostResponses.length === 1 && hostResponses[0] === "CANCELLED:t012-cancel-1", `[${hostResponses.join(", ")}]`);
const client = new RejoinWorkerClient();
const scenario: ScenarioConfig = { strategy: "FULL_REPLAY_FROM_START", injections: [] };
const pending = client.analyze(injectionFixture.events, scenario, "T-CANCEL");
client.cancel();
let clientCancelled = false;
try {
  await pending;
} catch (error) {
  clientCancelled = error instanceof WorkerCancelledError;
}
log(`  client cancel() → WorkerCancelledError: ${clientCancelled}`);
check("client 层 cancel() → WorkerCancelledError", clientCancelled, "promise rejected with WorkerCancelledError");
client.dispose();

/* ---------------- 8. 未知事件 ---------------- */
log("");
log("8. Unknown / unsupported events:");
try {
  parseJsonl(`{"type":"FOO_UNKNOWN","threadId":"t"}\n`);
  check("未知 type 被拒绝", false, "parseJsonl did not throw");
} catch (error) {
  const ok = error instanceof ParseError && error.code === "INVALID_INPUT";
  log(`  FOO_UNKNOWN: threw code=${error instanceof ParseError ? error.code : "?"}`);
  check("未知 type → ParseError INVALID_INPUT", ok, error instanceof Error ? error.message.slice(0, 120) : "?");
}
try {
  parseJsonl(`{"type":"STEP_STARTED","threadId":"t","runId":"r"}\n`);
  check("不支持 type 被拒绝", false, "parseJsonl did not throw");
} catch (error) {
  const ok = error instanceof ParseError && error.code === "INCONCLUSIVE_LIMIT";
  log(`  STEP_STARTED: threw code=${error instanceof ParseError ? error.code : "?"}`);
  check("已知但 MVP 不支持的 type → ParseError INCONCLUSIVE_LIMIT", ok, error instanceof Error ? error.message.slice(0, 120) : "?");
}

/* ---------------- 9. 静态扫描 ---------------- */
log("");
log("9. Static source scan (comments stripped):");
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}
function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      listFiles(path, out);
    } else if (/\.(ts|tsx|js|html)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["innerHTML", /innerHTML/],
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /new Function/],
  ["document.write", /document\.write/],
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/],
];
const scanned = [
  ...listFiles(`${ROOT}src`),
  `${ROOT}index.html`,
  `${ROOT}vite.config.ts`,
];
let hits = 0;
for (const [name, pattern] of FORBIDDEN) {
  const found: string[] = [];
  for (const file of scanned) {
    const content = stripComments(readFileSync(file, "utf8"));
    if (pattern.test(content)) found.push(file.replace(ROOT, ""));
  }
  if (found.length > 0) hits += found.length;
  log(`  ${name}: ${found.length === 0 ? "0 hits" : `FOUND in ${found.join(", ")}`}`);
  check(`源码无 ${name}`, found.length === 0, found.length === 0 ? "0 hits" : found.join(", "));
}
log(`  scanned ${scanned.length} files`);

log("");
log(`RESULT: ${failures.length === 0 ? "PASS" : "FAIL"} (${failures.length} failure(s))`);
if (failures.length > 0) {
  for (const f of failures) log(`  FAILED: ${f}`);
}
log(`finishedAt(UTC): ${new Date().toISOString()}`);
mkdirSync(`${ROOT}artifacts/logs`, { recursive: true });
writeFileSync(LOG_PATH, lines.join("\n") + "\n", "utf8");
console.log(`log written: ${LOG_PATH}`);
process.exitCode = failures.length === 0 ? 0 : 1;
