/**
 * P031 RejoinLab — T012: 离线验证（scripts/verify_offline.ts）。
 *
 * 验收命令：npm run test:offline（T012 新建）。
 *
 * 真实 Chromium + 网络层阻断（context.route：一切非 127.0.0.1:4173
 * 请求一律 abort，并计数）下跑通完整产品流程：
 * 1. 阻断外部网络后加载本地应用（生产构建 + vite preview）。
 * 2. 导入样本（normal.jsonl，13 事件）。
 * 3. 运行分析（真实 Worker 线程），得 CONSISTENT。
 * 4. 导出 JSON + HTML 报告（保存到 artifacts/logs/T012_OFFLINE_EXPORT.*
 *    作为证据）。
 * 5. 独立打开 HTML：新上下文阻断除 file:// 文档本身外的一切请求，
 *    file:// 打开导出的 HTML，断言渲染出报告且 0 次子资源请求。
 * 6. 静态核对：dist/index.html 无远程 src/href；导出的 HTML 无
 *    http(s)://、无 <script>/<link>/<img>。
 *
 * 任一失败即 exit 1。日志：artifacts/logs/T012_OFFLINE.log。
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page, type Worker } from "playwright";

const ROOT = `${process.cwd().replace(/\/$/, "")}/`;
if (!existsSync(`${ROOT}package.json`)) {
  throw new Error(`verify script must run from the project root (cwd=${process.cwd()})`);
}
const LOG_PATH = `${ROOT}artifacts/logs/T012_OFFLINE.log`;
const PREVIEW_URL = "http://127.0.0.1:4173";
const FIXTURES = `${ROOT}tests/e2e/fixtures`;
const EXPORT_JSON = `${ROOT}artifacts/logs/T012_OFFLINE_EXPORT.json`;
const EXPORT_HTML = `${ROOT}artifacts/logs/T012_OFFLINE_EXPORT.html`;

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
log("T012 OFFLINE — RejoinLab 离线验证");
log(`startedAt(UTC): ${startedAt}`);
log(`HEAD: ${head}`);
log(`node: ${process.version} (${process.platform}/${process.arch})`);
log("");

let preview: ChildProcess | null = null;
try {
  preview = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "preview", "--port", "4173", "--strictPort", "--host", "127.0.0.1"],
    { cwd: ROOT, stdio: "ignore" },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(PREVIEW_URL);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("vite preview did not become ready in 60s");
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch();
  log(`chromium: ${browser.version()}`);

  /* ---- 主流程：阻断一切外部请求 ---- */
  const context = await browser.newContext();
  const blocked: string[] = [];
  const requests: string[] = [];
  const pageErrors: string[] = [];
  const workers: Worker[] = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1:4173")) {
      blocked.push(url);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const page: Page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("worker", (worker) => workers.push(worker));
  page.on("request", (request) => requests.push(request.url()));
  page.on("requestfailed", (request) => {
    // 本地请求失败即记入 blocked 视角外：单独记录以便排查
    if (request.url().startsWith("http://127.0.0.1:4173")) {
      pageErrors.push(`local request failed: ${request.url()} (${request.failure()?.errorText ?? "?"})`);
    }
  });

  log("1. Load app with external network blocked:");
  await page.goto(PREVIEW_URL);
  await page.getByTestId("event-count").waitFor();
  const h1 = await page.locator("h1").innerText();
  log(`  h1: ${h1}`);
  log(`  requests so far: ${requests.length} (all local: ${requests.every((u) => u.startsWith("http://127.0.0.1:4173"))})`);
  check("阻断外部网络后本地应用可加载", h1.length > 0, `h1="${h1}"`);
  check("加载阶段外部请求 0（阻断计数）", blocked.length === 0, `blocked=${blocked.length}`);

  log("2. Import sample (normal.jsonl, 13 events):");
  await page.locator('input[aria-label="选择事件文件"]').setInputFiles(path.join(FIXTURES, "normal.jsonl"));
  // FileReader 解析是异步的：等到计数变为 13 条再读（与 T011 的
  // toHaveText 等价的显式等待；只等元素出现会读到旧值 0 条）。
  await page.waitForFunction(
    () => document.querySelector('[data-testid="event-count"]')?.textContent === "13 条",
    { timeout: 10_000 },
  );
  const countText = await page.getByTestId("event-count").innerText();
  log(`  event-count: ${countText}`);
  check("导入 13 条事件", countText === "13 条", countText);

  log("3. Run analysis (real Worker thread):");
  await page.getByRole("button", { name: "开始", exact: true }).click();
  const runDone = await page
    .waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.textContent === "已完成", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const realWorker = workers.some((w) => w.url().includes("rejoin.worker"));
  log(`  run-status 已完成: ${runDone}; workers: ${workers.length} (rejoin.worker: ${realWorker})`);
  check("分析运行完成", runDone, "run-status reached 已完成");
  check("真实 Worker 线程已创建", workers.length >= 1 && realWorker, `${workers.length} worker(s)`);

  log("4. Export JSON + HTML reports:");
  const jsonDownload = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByTestId("download-json").click();
  const jsonFile = await jsonDownload;
  await jsonFile.saveAs(EXPORT_JSON);
  const jsonText = readFileSync(EXPORT_JSON, "utf8");
  const jsonParsed = JSON.parse(jsonText) as { schema?: string; verdict?: string };
  const jsonSha = createHash("sha256").update(jsonText, "utf8").digest("hex");
  log(`  JSON: ${Buffer.byteLength(jsonText, "utf8")} bytes, sha256=${jsonSha}, schema=${jsonParsed.schema}, verdict=${jsonParsed.verdict}`);
  check("JSON 导出为 rejoinlab.report/v1 且裁决 CONSISTENT", jsonParsed.schema === "rejoinlab.report/v1" && jsonParsed.verdict === "CONSISTENT", `verdict=${jsonParsed.verdict}`);

  const htmlDownload = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByTestId("download-html").click();
  const htmlFile = await htmlDownload;
  await htmlFile.saveAs(EXPORT_HTML);
  const htmlText = readFileSync(EXPORT_HTML, "utf8");
  log(`  HTML: ${Buffer.byteLength(htmlText, "utf8")} bytes, saved to artifacts/logs/T012_OFFLINE_EXPORT.html`);
  check("HTML 导出无 http(s):// 远程引用", !/https?:\/\//.test(htmlText), "no remote URL substring");
  check("HTML 导出无 <script>/<link>/<img>", !htmlText.includes("<script") && !htmlText.includes("<link") && !htmlText.includes("<img"), "no remote-resource tags");

  log("5. Offline counters for the main flow:");
  log(`  total requests=${requests.length}; blocked external attempts=${blocked.length} (${blocked.join(", ") || "none"})`);
  log(`  page errors=${pageErrors.length} (${pageErrors.join("; ") || "none"})`);
  check("主流程外部网络请求 0", blocked.length === 0 && requests.every((u) => u.startsWith("http://127.0.0.1:4173")), `requests=${requests.length}, blocked=${blocked.length}`);
  check("主流程浏览器未处理异常 0", pageErrors.length === 0, pageErrors.join("; ") || "none");

  /* ---- 独立打开 HTML：只放行 file:// 文档本身 ---- */
  log("6. Open exported HTML standalone (file://, all sub-resources blocked):");
  const standalone = await browser.newContext();
  const standaloneBlocked: string[] = [];
  const standaloneRequests: string[] = [];
  const standaloneErrors: string[] = [];
  await standalone.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("file:") && route.request().resourceType() === "document") {
      await route.continue();
    } else {
      standaloneBlocked.push(url);
      await route.abort();
    }
  });
  const solo = await standalone.newPage();
  solo.on("pageerror", (error) => standaloneErrors.push(String(error)));
  solo.on("request", (request) => standaloneRequests.push(request.url()));
  await solo.goto(`file://${EXPORT_HTML}`);
  await solo.locator("h1").waitFor({ timeout: 10_000 });
  const soloH1 = await solo.locator("h1").innerText();
  const soloBody = await solo.evaluate(() => document.body.innerText);
  log(`  h1: ${soloH1}`);
  log(`  body contains verdict CONSISTENT: ${soloBody.includes("CONSISTENT")}`);
  log(`  requests: ${standaloneRequests.length} (${standaloneRequests.join(", ") || "none"}); blocked: ${standaloneBlocked.length}`);
  log(`  page errors: ${standaloneErrors.length}`);
  check("独立打开 HTML 渲染出报告标题", soloH1.includes("RejoinLab 报告"), `h1="${soloH1}"`);
  check("独立打开 HTML 显示裁决", soloBody.includes("CONSISTENT"), "verdict visible");
  check("独立打开 HTML 子资源请求 0", standaloneRequests.length === 1 && standaloneRequests[0]?.startsWith("file:"), `${standaloneRequests.length} request(s)`);
  check("独立打开 HTML 被阻断请求 0", standaloneBlocked.length === 0, `${standaloneBlocked.length}`);
  check("独立打开 HTML 无页面异常", standaloneErrors.length === 0, standaloneErrors.join("; ") || "none");
  await standalone.close();

  /* ---- 静态核对：dist/index.html ---- */
  log("7. Static check (dist/index.html):");
  const indexHtml = readFileSync(`${ROOT}dist/index.html`, "utf8");
  const remoteRefs = [...indexHtml.matchAll(/(?:src|href)\s*=\s*"https?:[^"]*"/g)].map((m) => m[0]);
  log(`  remote src/href in dist/index.html: ${remoteRefs.length} (${remoteRefs.join(", ") || "none"})`);
  check("dist/index.html 无远程 src/href", remoteRefs.length === 0, remoteRefs.join(", ") || "none");

  await browser.close();
} catch (error) {
  check("离线浏览器流程完成", false, error instanceof Error ? error.message : String(error));
} finally {
  preview?.kill();
}

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
