/**
 * P031 RejoinLab — T011: 浏览器 E2E 与交互回归（真实 Chromium）。
 *
 * 覆盖计划 §6 T011 的 12 条交互路径（每条一个用例，顺序与任务卡
 * 一致）。跑生产构建（playwright.config.ts：build + vite preview），
 * 真实 Worker 线程（page.on("worker") 捕获，URL 含 rejoin.worker；
 * in-process 回退会出现 worker-mode-note，本套件断言它不存在）。
 *
 * 夹具（tests/e2e/fixtures/）：
 * - normal.jsonl / normal.sse：T002 解析夹具的副本（13 / 10 条事件）。
 * - g01.jsonl：Golden G01 的 9 条事件转 JSONL（Golden 显式检查点
 *   UI 无法提供，故 G01 用其无检查点的 FULL_REPLAY 形态复现）。
 * - two-snapshot.jsonl：双 STATE_SNAPSHOT 合成轨迹（9 条），供
 *   STALE_SNAPSHOT 注入复现快照不一致。
 *
 * 故障路径的预期裁决/诊断均先经 vitest 探针（同一 evaluateFixture）
 * 核对，E2E 断言与探针一致；E2E 不为通过而放宽断言。
 * 取消用例（路径 10）用路由把首个 Worker chunk 延迟 3 秒，制造
 * 可观测的“运行中”窗口——取消路径（CANCEL + terminate + 重建
 * Worker + WorkerCancelledError → 已暂停）本身是真实走的，延迟
 * 只决定时序，不替代取消逻辑。
 *
 * 下载断言校验文件内容：JSON 按 rejoinlab.report/v1 做结构校验
 * （字段集、哈希格式、sourceSha256 与源文件字节的 SHA-256 对照），
 * HTML 校验自包含（无任何外部引用）且内嵌同一份报告 JSON。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Worker } from "@playwright/test";

const SCREENSHOTS = "artifacts/screenshots";
const FIXTURES = "tests/e2e/fixtures";

const INJECTION_OPERATORS = new Set([
  "CURSOR_SKIP",
  "DROP_EVENT",
  "DUPLICATE_EVENT",
  "MESSAGE_ID_REMAP",
  "REPLAY_PREFIX",
  "STALE_SNAPSHOT",
  "SWAP_ADJACENT",
  "TRUNCATE_STREAM",
]);
const VERDICTS = new Set([
  "CONSISTENT",
  "INCONSISTENT",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
  "INCOMPLETE_TRACE",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface Track {
  pageErrors: string[];
  workers: Worker[];
  externalRequests: string[];
  failedResponses: string[];
  failedRequests: string[];
}

// 串行运行（workers: 1），用例间用 beforeEach 重置同一份追踪。
let track: Track;

test.beforeEach(async ({ page }) => {
  track = {
    pageErrors: [],
    workers: [],
    externalRequests: [],
    failedResponses: [],
    failedRequests: [],
  };
  page.on("pageerror", (error) => track.pageErrors.push(String(error)));
  page.on("worker", (worker) => track.workers.push(worker));
  page.on("request", (request) => {
    const url = request.url();
    if (
      !url.startsWith("http://127.0.0.1:4173") &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:") &&
      !url.startsWith("about:")
    ) {
      track.externalRequests.push(url);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      track.failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) =>
    track.failedRequests.push(request.url()),
  );
  await page.goto("/");
});

test.afterEach(async () => {
  expect(track.pageErrors, "浏览器未处理异常必须为 0").toEqual([]);
  expect(track.externalRequests, "离线产品不得发外部请求").toEqual([]);
  expect(track.failedResponses, "不得有失败的本地响应").toEqual([]);
  expect(track.failedRequests, "不得有失败的请求").toEqual([]);
});

async function importFile(page: Page, fileName: string, count: number) {
  await page
    .locator('input[aria-label="选择事件文件"]')
    .setInputFiles(path.join(FIXTURES, fileName));
  await expect(page.getByTestId("event-count")).toHaveText(`${count} 条`);
}

async function runAndWaitDone(page: Page) {
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已完成", {
    timeout: 15_000,
  });
}

/** 真实 Worker 线程已创建，且未出现 in-process 回退提示。 */
async function expectRealWorker(page: Page) {
  expect(
    track.workers.length,
    "真实 Chromium 中至少创建一个 Worker 线程",
  ).toBeGreaterThanOrEqual(1);
  expect(
    track.workers.some((w) => w.url().includes("rejoin.worker")),
    `Worker URL 应含 rejoin.worker，实得：${track.workers.map((w) => w.url()).join(", ")}`,
  ).toBe(true);
  await expect(page.getByTestId("worker-mode-note")).toHaveCount(0);
}

async function expectVerdict(page: Page, verdict: string) {
  await expect(page.locator(".verdict-line")).toContainText(
    `（${verdict}）`,
  );
}

async function expectDiagnostic(page: Page, code: string) {
  await expect(page.locator('section[aria-label="诊断"]')).toContainText(code);
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: `${SCREENSHOTS}/${name}`,
    fullPage: true,
  });
}

/**
 * 按 rejoinlab.report/v1（src/report/schema.ts 的校验规则）做结构
 * 校验，并对照源文件字节核对 sourceSha256。只做结构校验，不做
 * 跨字段业务一致性判断——与生产校验器分工一致。
 */
function validateReportJson(
  value: unknown,
  expected: { scenarioId: string; verdict: string; eventCount: number; sourceSha256: string },
): void {
  const fail = (msg: string): never => {
    throw new Error(`下载的 JSON 报告校验失败：${msg}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("报告必须是对象");
  }
  const report = value as Record<string, unknown>;
  const topKeys = new Set(Object.keys(report));
  const allowedTop = new Set([
    "schema", "specVersion", "protocolVersion", "scenarioId", "verdict",
    "input", "recovery", "fullPath", "resumePath", "firstDivergence",
    "diagnostics", "shortestInjectionSequence", "metrics",
    "assumptions", "limitations",
  ]);
  for (const key of topKeys) if (!allowedTop.has(key)) fail(`多余顶层字段 ${key}`);
  for (const key of allowedTop) {
    if (key !== "firstDivergence" && !(key in report)) fail(`缺失顶层字段 ${key}`);
  }
  if (report["schema"] !== "rejoinlab.report/v1") fail("schema 必须是 rejoinlab.report/v1");
  if (report["specVersion"] !== "1.0.2") fail("specVersion 必须是 1.0.2");
  if (report["protocolVersion"] !== "1.0") fail("protocolVersion 必须是 1.0");
  if (report["scenarioId"] !== expected.scenarioId) fail(`scenarioId 应为 ${expected.scenarioId}`);
  if (report["verdict"] !== expected.verdict) fail(`verdict 应为 ${expected.verdict}`);
  if (typeof report["verdict"] !== "string" || !VERDICTS.has(report["verdict"])) {
    fail("verdict 不在五种裁决内");
  }
  const input = report["input"] as Record<string, unknown>;
  if (input?.["sourceFormat"] !== "JSONL") fail("input.sourceFormat 应为 JSONL");
  if (input?.["eventCount"] !== expected.eventCount) {
    fail(`input.eventCount 应为 ${expected.eventCount}`);
  }
  if (
    typeof input?.["sourceSha256"] !== "string" ||
    !SHA256_HEX.test(input["sourceSha256"] as string)
  ) {
    fail("input.sourceSha256 必须是 64 位小写十六进制");
  }
  if (input["sourceSha256"] !== expected.sourceSha256) {
    fail("input.sourceSha256 与源文件字节的 SHA-256 不符");
  }
  const checkPath = (key: string) => {
    const p = report[key];
    if (p === null) return;
    const obj = p as Record<string, unknown>;
    if (
      typeof obj["finalStateHash"] !== "string" ||
      !SHA256_HEX.test(obj["finalStateHash"] as string)
    ) {
      fail(`${key}.finalStateHash 必须是 64 位小写十六进制`);
    }
    if (!Array.isArray(obj["messages"]) || !Array.isArray(obj["toolCalls"])) {
      fail(`${key}.messages/toolCalls 必须是数组`);
    }
    if (
      !Array.isArray(obj["pendingToolCallIds"]) ||
      !(obj["pendingToolCallIds"] as unknown[]).every((x) => typeof x === "string")
    ) {
      fail(`${key}.pendingToolCallIds 必须是字符串数组`);
    }
  };
  checkPath("fullPath");
  checkPath("resumePath");
  if (!Array.isArray(report["diagnostics"])) fail("diagnostics 必须是数组");
  for (const d of report["diagnostics"] as Record<string, unknown>[]) {
    if (typeof d["code"] !== "string" || d["code"] === "") fail("诊断 code 不能为空");
    if (d["severity"] !== "CRITICAL" && d["severity"] !== "WARNING") {
      fail("诊断 severity 必须是 CRITICAL 或 WARNING");
    }
  }
  if (!Array.isArray(report["shortestInjectionSequence"])) {
    fail("shortestInjectionSequence 必须是数组");
  }
  for (const op of report["shortestInjectionSequence"] as unknown[]) {
    if (typeof op !== "string" || !INJECTION_OPERATORS.has(op)) {
      fail(`shortestInjectionSequence 元素 ${String(op)} 不是冻结算子`);
    }
  }
  const metrics = report["metrics"] as Record<string, unknown>;
  if (
    typeof metrics?.["durationMs"] !== "number" ||
    (metrics["durationMs"] as number) < 0 ||
    !Number.isInteger(metrics?.["visitedStates"]) ||
    (metrics["visitedStates"] as number) < 0
  ) {
    fail("metrics.durationMs/visitedStates 不合法");
  }
  for (const key of ["assumptions", "limitations"] as const) {
    const list = report[key] as unknown;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((x) => typeof x === "string" && x !== "")
    ) {
      fail(`${key} 必须是非空字符串数组`);
    }
  }
}

test("01 首页正常加载", async ({ page }) => {
  await expect(page.locator("h1")).toContainText("RejoinLab");
  await expect(page.getByTestId("run-status")).toHaveText("未运行");
  await expect(page.getByTestId("event-count")).toHaveText("0 条");
  await expect(page.getByText("未导入")).toBeVisible();
  expect(await page.evaluate(() => typeof Worker)).toBe("function");
  await expect(page.getByTestId("worker-mode-note")).toHaveCount(0);
  await screenshot(page, "T011_HOME.png");
});

test("02 JSONL 文件导入", async ({ page }) => {
  await importFile(page, "normal.jsonl", 13);
  await expect(page.getByText("normal.jsonl")).toBeVisible();
  await expect(page.getByText("JSONL", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RUN_STARTED")).toBeVisible();
  await screenshot(page, "T011_JSONL_IMPORT.png");
});

test("03 SSE 文件导入", async ({ page }) => {
  await importFile(page, "normal.sse", 10);
  await expect(page.getByText("normal.sse")).toBeVisible();
  await expect(page.getByText("SSE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/SSE id=evt-0/)).toBeVisible();
  await screenshot(page, "T011_SSE_IMPORT.png");
});

test("04 正常轨迹运行", async ({ page }) => {
  await importFile(page, "normal.jsonl", 13);
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await expect(
    page.locator('section[aria-label="诊断"]'),
  ).toContainText("无诊断");
  await expect(page.getByTestId("timeline-track-full")).toBeVisible();
  await expect(page.getByTestId("timeline-track-resume")).toBeVisible();
  await expectRealWorker(page);
  await screenshot(page, "T011_NORMAL_RUN.png");
});

test("05 重复工具调用诊断（G01，FULL_REPLAY，断线 4）", async ({ page }) => {
  await importFile(page, "g01.jsonl", 9);
  await page
    .locator('input[name="recovery-strategy"][value="FULL_REPLAY_FROM_START"]')
    .check();
  await page.getByLabel("断线位置").selectOption("4");
  await runAndWaitDone(page);
  await expectVerdict(page, "INCONSISTENT");
  await expectDiagnostic(page, "DUPLICATE_TOOL_CALL");
  await expect(page.getByTestId("first-divergence-source-index")).toBeVisible();
  await expectRealWorker(page);
  await screenshot(page, "T011_FAULT_DUPLICATE.png");
});

test("06 消息重排诊断（normal，断线 11，MESSAGE_ID_REMAP 留空默认）", async ({
  page,
}) => {
  await importFile(page, "normal.jsonl", 13);
  await page.getByLabel("断线位置").selectOption("11");
  await page
    .getByRole("checkbox", { name: /消息 ID 重映射/ })
    .check();
  // 留空 = 首条 assistant 消息 → 加 -remapped 后缀（界面承诺的默认）。
  await expect(page.getByLabel("重映射原消息 ID")).toHaveValue("");
  await expect(page.getByLabel("重映射新消息 ID")).toHaveValue("");
  await runAndWaitDone(page);
  await expectVerdict(page, "INCONSISTENT");
  await expectDiagnostic(page, "MESSAGE_REORDER");
  await expect(
    page.locator('section[aria-label="实验配置回显"]'),
  ).toContainText("消息 ID 重映射");
  await expectRealWorker(page);
  await screenshot(page, "T011_FAULT_REORDER.png");
});

test("07 状态快照不一致诊断（双快照轨迹，断线 4，STALE_SNAPSHOT）", async ({
  page,
}) => {
  await importFile(page, "two-snapshot.jsonl", 9);
  await page.getByLabel("断线位置").selectOption("4");
  await page.getByRole("checkbox", { name: /陈旧快照/ }).check();
  await runAndWaitDone(page);
  await expectVerdict(page, "INCONSISTENT");
  await expectDiagnostic(page, "SNAPSHOT_MISMATCH");
  await expectRealWorker(page);
  await screenshot(page, "T011_FAULT_SNAPSHOT.png");
});

test("08 断线位置修改生效", async ({ page }) => {
  await importFile(page, "normal.jsonl", 13);
  await page.getByLabel("断线位置").selectOption("2");
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await expect(page.locator(".state-diff .meta-line")).toContainText(
    "检查点 sourceIndex 2",
  );
  await expect(
    page.locator('section[aria-label="实验配置回显"]'),
  ).toContainText("在 sourceIndex 2 处断线");
  await expectRealWorker(page);
});

test("09 故障注入修改生效（断线 2，先无注入一致，再加 DROP_EVENT@4）", async ({
  page,
}) => {
  await importFile(page, "normal.jsonl", 13);
  await page.getByLabel("断线位置").selectOption("2");
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await page.getByRole("checkbox", { name: /丢失事件/ }).check();
  await page.getByLabel("丢失事件 目标 sourceIndex").fill("4");
  await runAndWaitDone(page);
  await expectVerdict(page, "INCONSISTENT");
  await expectDiagnostic(page, "LOST_EVENT");
  await expect(
    page.locator('section[aria-label="实验配置回显"]'),
  ).toContainText("丢失事件（sourceIndex 4）");
  await expectRealWorker(page);
});

test("10 分析取消和重新运行", async ({ page }) => {
  // 只延迟首个 Worker chunk 3 秒，制造可观测的“运行中”窗口。
  // Playwright 的 page.on("worker") 在 worker 线程实际创建时触发，
  // 即浏览器取回 Worker 脚本并启动线程之后，不是 new Worker() 构造
  // 时。实测：脚本延迟 3 秒时，构造后 500ms 内 worker 事件 0 次，
  // 脚本加载完后才触发 1 次。
  // 取消发生在延迟窗口内：原 Worker 的脚本尚未加载完就被 terminate，
  // 从未产生 worker 事件；track.workers 里只有取消时重建的那一个
  // （client.ts cancel() → respawn() 立即 new Worker()，其脚本请求
  // 是第 2 次、不延迟，故事件正常触发）。重建的真实性由“取消后重新
  // 运行能完成”证明（若未重建，客户端手里只剩已死线程，重跑必然
  // 挂起/失败）。
  let workerChunkRequests = 0;
  await page.route("**/rejoin.worker-*.js", async (route) => {
    workerChunkRequests += 1;
    if (workerChunkRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue();
  });
  await importFile(page, "normal.jsonl", 13);
  const startedAt = Date.now();
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("运行中");
  expect(workerChunkRequests, "开始后应正在加载 Worker chunk").toBe(1);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已暂停");
  const pausedMs = Date.now() - startedAt;
  expect(
    pausedMs,
    `取消必须发生在 3 秒延迟窗口内（原 Worker 脚本尚未加载），实测 ${pausedMs}ms`,
  ).toBeLessThan(3000);
  // 取消后无结果：双轨对照区回到“未运行”提示，导出区提示运行后可导出。
  await expect(
    page.locator('section[aria-label="双轨状态对照"]'),
  ).toContainText("导入事件文件并点击“开始”后");
  await expect(
    page.locator('section[aria-label="导出报告"]'),
  ).toContainText("运行分析后可导出");
  await screenshot(page, "T011_CANCEL.png");
  // 取消后重新运行应完成：这要求取消时已重建 Worker（见本用例头注）。
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await expectRealWorker(page);
});

test("11 JSON 与 HTML 下载（内容校验）", async ({ page }, testInfo) => {
  const fixtureBytes = readFileSync(path.join(FIXTURES, "normal.jsonl"));
  const sourceSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  await importFile(page, "normal.jsonl", 13);
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await screenshot(page, "T011_EXPORT.png");

  const jsonDownload = page.waitForEvent("download");
  await page.getByTestId("download-json").click();
  const jsonFile = await jsonDownload;
  expect(jsonFile.suggestedFilename()).toBe("rejoinlab-normal.report.json");
  const jsonPath = path.join(testInfo.outputDir, "rejoinlab-normal.report.json");
  await jsonFile.saveAs(jsonPath);
  const report = JSON.parse(readFileSync(jsonPath, "utf-8")) as unknown;
  validateReportJson(report, {
    scenarioId: "normal",
    verdict: "CONSISTENT",
    eventCount: 13,
    sourceSha256,
  });

  const htmlDownload = page.waitForEvent("download");
  await page.getByTestId("download-html").click();
  const htmlFile = await htmlDownload;
  expect(htmlFile.suggestedFilename()).toBe("rejoinlab-normal.report.html");
  const htmlPath = path.join(testInfo.outputDir, "rejoinlab-normal.report.html");
  await htmlFile.saveAs(htmlPath);
  const html = readFileSync(htmlPath, "utf-8");
  expect(html.toLowerCase()).toContain("<!doctype html>");
  expect(html).toContain("rejoinlab.report/v1");
  expect(html).toContain("CONSISTENT");
  expect(html).toContain("normal");
  expect(html).toContain('<pre id="report-json">');
  // 自包含：无任何外部引用（脚本/样式/链接/远程图片）。
  for (const marker of [
    'src="http',
    "src='http",
    'href="http',
    "href='http",
    "url(http",
    "<link",
    "<script src",
  ]) {
    expect(html, `HTML 报告不得含外部引用标记 ${marker}`).not.toContain(marker);
  }
  // 内嵌 JSON 与下载的 JSON 是同一份报告（同一裁决 + 同一哈希）。
  // 报告 HTML 对内嵌 JSON 做了 HTML 转义（escapeHtml：& < > " '），
  // 解析前须先解码实体——这是 HTML 报告的既定格式，不是产品缺陷。
  const embeddedRaw = html
    .split('<pre id="report-json">')[1]!
    .split("</pre>")[0]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const embedded = JSON.parse(embeddedRaw) as Record<string, unknown>;
  expect(embedded["verdict"]).toBe("CONSISTENT");
  expect(embedded["scenarioId"]).toBe("normal");
  expect(embedded["input"]).toEqual(
    (report as Record<string, unknown>)["input"],
  );
});

test("12 清空内存及窄屏检查", async ({ page }) => {
  await importFile(page, "normal.jsonl", 13);
  await runAndWaitDone(page);
  await expectVerdict(page, "CONSISTENT");
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(page.getByTestId("event-count")).toHaveText("0 条");
  await expect(page.getByText("未导入")).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("未运行");
  await expect(
    page.locator('section[aria-label="双轨状态对照"]'),
  ).toContainText("导入事件文件并点击“开始”后");
  await expect(
    page.locator('section[aria-label="导出报告"]'),
  ).toContainText("运行分析后可导出");
  expect(
    await page.evaluate(() => localStorage.length),
    "清空后 localStorage 必须仍为空（产品不写持久化）",
  ).toBe(0);
  // 窄屏：390px 下无横向溢出，关键控件仍可见。
  // 先截图再断言：截图是缺陷的直接证据，断言只做判定，不决定取证。
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "T011_NARROW.png");
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `窄屏不得横向溢出：scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.innerWidth + 1);
  await expect(page.locator("h1")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "清空", exact: true }),
  ).toBeVisible();
  // D-T011-01 防回归（第二轮）：只断言 scrollWidth 会放过“修指标、
  // 坏界面”的修复——第一轮把 label span 压成 0 宽逐字断行后 scrollWidth
  // 也通过了，但页高 2834→15170、标签不可读。故追加标签可读性与页高
  // 断言：radio/checkbox input 须恢复固有宽度（实测 13px，504px 即
  // 修复前的根因值），每个 label span 须有正宽度且在视口内，
  // scrollHeight 须在合理上限内（修复后实测 390px 约 2834、
  // 1280px 约 1724，阈值 6000 留有裕量；第一轮坏界面时 390px 为 15170）。
  // D-T011-01 是全视口横向溢出（390px 575、500px 685、1280px 1403），
  // 不仅是 390px 窄屏问题，故 500px 与 1280px 同样复核。
  for (const width of [390, 500, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll(".radio-row > span, .checkbox-row > span"),
      ].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, right: r.right, left: r.left };
      });
      const inputs = [
        ...document.querySelectorAll(".radio-row input, .checkbox-row input"),
      ].map((el) => el.getBoundingClientRect().width);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        spans,
        inputs,
      };
    });
    expect(
      layout.scrollWidth,
      `${width}px 下不得横向溢出：scrollWidth ${layout.scrollWidth} > innerWidth ${layout.innerWidth}`,
    ).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(
      layout.scrollHeight,
      `${width}px 下页高须合理（修复后实测 390px 约 2834 / 1280px 约 1724）：${layout.scrollHeight}`,
    ).toBeLessThan(6000);
    expect(layout.inputs.length, "应有 3 个 radio + 8 个 checkbox 输入框").toBe(11);
    for (const w of layout.inputs) {
      expect(
        w,
        `${width}px 下 radio/checkbox input 宽度须为固有宽度（实测 13px），实得 ${w}`,
      ).toBeLessThanOrEqual(32);
    }
    expect(layout.spans.length, "应有 3 个策略标签 + 8 个注入标签").toBe(11);
    for (const s of layout.spans) {
      expect(
        s.w,
        `${width}px 下 label span 宽度须 > 0（0 宽竖条即第一轮坏界面），实得 ${s.w}`,
      ).toBeGreaterThan(0);
      expect(
        s.left,
        `${width}px 下 label span 左缘不得出视口，实得 ${s.left}`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        s.right,
        `${width}px 下 label span 右缘不得出视口（innerWidth ${layout.innerWidth}），实得 ${s.right}`,
      ).toBeLessThanOrEqual(layout.innerWidth + 1);
    }
  }
});
