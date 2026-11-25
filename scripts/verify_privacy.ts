/**
 * P031 RejoinLab — T012: 隐私验证（scripts/verify_privacy.ts）。
 *
 * 验收命令：npm run test:privacy（T012 新建）。
 *
 * 真实 Chromium（生产构建 + vite preview）全流程实测，非静态推断：
 * - 注入计数器（addInitScript，页面脚本运行前安装）：localStorage /
 *   sessionStorage 的 setItem/removeItem/clear 调用次数、IndexedDB
 *   open/deleteDatabase 调用次数。
 * - 导入样本 → 运行分析 → 导出 JSON/HTML，全程记录全部网络请求；
 *   导出前等待 1.5s，确认无用户手势时不发生任何下载（导出必须由
 *   用户主动触发）。
 * - 导出后断言：localStorage/sessionStorage 长度 0、写入计数 0、
 *   IndexedDB 打开 0、数据库列表空、外部请求 0。
 * - 点击「清空」后断言：事件数 0、运行状态未运行、导出区回到
 *   “运行分析后可导出”、导入内容（消息文本/工具结果）不再出现在
 *   页面上、localStorage 仍为 0。
 * - 静态补充：src/（去注释后）不得含 localStorage / sessionStorage /
 *   indexedDB 字样。
 *
 * 任一失败即 exit 1。日志：artifacts/logs/T012_PRIVACY.log。
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page, type Worker } from "playwright";

const ROOT = `${process.cwd().replace(/\/$/, "")}/`;
if (!existsSync(`${ROOT}package.json`)) {
  throw new Error(`verify script must run from the project root (cwd=${process.cwd()})`);
}
const LOG_PATH = `${ROOT}artifacts/logs/T012_PRIVACY.log`;
const PREVIEW_URL = "http://127.0.0.1:4173";
const FIXTURES = `${ROOT}tests/e2e/fixtures`;

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
log("T012 PRIVACY — RejoinLab 隐私验证");
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
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const counters = { lsWrites: 0, ssWrites: 0, idbOpens: 0, idbDeletes: 0 };
    (window as unknown as { __t012: typeof counters }).__t012 = counters;
    const rawSet = Storage.prototype.setItem;
    const rawRemove = Storage.prototype.removeItem;
    const rawClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage) counters.lsWrites += 1;
      else counters.ssWrites += 1;
      return rawSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key: string) {
      if (this === window.localStorage) counters.lsWrites += 1;
      else counters.ssWrites += 1;
      return rawRemove.call(this, key);
    };
    Storage.prototype.clear = function () {
      if (this === window.localStorage) counters.lsWrites += 1;
      else counters.ssWrites += 1;
      return rawClear.call(this);
    };
    const rawOpen = IDBFactory.prototype.open;
    const rawDelete = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
      counters.idbOpens += 1;
      return rawOpen.apply(this, args);
    };
    IDBFactory.prototype.deleteDatabase = function (...args: Parameters<IDBFactory["deleteDatabase"]>) {
      counters.idbDeletes += 1;
      return rawDelete.apply(this, args);
    };
  });

  const requests: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const workers: Worker[] = [];
  let expectingDownload = false;
  let spontaneousDownloads = 0;
  let downloadCount = 0;

  const page: Page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("worker", (worker) => workers.push(worker));
  page.on("request", (request) => {
    const url = request.url();
    requests.push(url);
    if (!url.startsWith("http://127.0.0.1:4173") && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:")) {
      externalRequests.push(url);
    }
  });
  page.on("download", () => {
    downloadCount += 1;
    if (!expectingDownload) spontaneousDownloads += 1;
  });

  await page.goto(PREVIEW_URL);
  await page.getByTestId("event-count").waitFor();
  log("1. App loaded (production build, vite preview):");
  log(`  workers seen at load: ${workers.length} (Worker is created on demand at first analysis, checked again after run)`);
  const modeNote = await page.getByTestId("worker-mode-note").count();
  check("无 in-process 回退提示", modeNote === 0, `worker-mode-note count=${modeNote}`);

  log("2. Import + analyze (normal.jsonl, 13 events):");
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
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await page.getByTestId("run-status").waitFor();
  // 等待运行完成（轮询 run-status 文本，最长 15s）
  const runDone = await page
    .waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.textContent === "已完成", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  log(`  run-status 已完成: ${runDone}`);
  check("分析运行完成", runDone, "run-status reached 已完成");
  const realWorker = workers.some((w) => w.url().includes("rejoin.worker"));
  log(`  workers seen after run: ${workers.length} (${workers.map((w) => w.url()).join(", ") || "none"})`);
  check("真实 Worker 线程已创建（rejoin.worker）", workers.length >= 1 && realWorker, `${workers.length} worker(s)`);

  log("3. No spontaneous export (user gesture required):");
  await new Promise((r) => setTimeout(r, 1500));
  log(`  downloads without any click: ${spontaneousDownloads} (total downloads so far: ${downloadCount})`);
  check("无点击时不发生下载（导出须用户主动触发）", spontaneousDownloads === 0, `${spontaneousDownloads} spontaneous download(s)`);

  log("4. Export JSON + HTML (click-triggered downloads):");
  const tmpDir = `${tmpdir()}/rejoinlab-t012-privacy`;
  mkdirSync(tmpDir, { recursive: true });
  expectingDownload = true;
  const jsonDownload = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByTestId("download-json").click();
  const jsonFile = await jsonDownload;
  const jsonPath = path.join(tmpDir, "report.json");
  await jsonFile.saveAs(jsonPath);
  expectingDownload = false;
  const jsonText = readFileSync(jsonPath, "utf8");
  const jsonParsed = JSON.parse(jsonText) as { schema?: string; verdict?: string };
  const jsonSha = createHash("sha256").update(jsonText, "utf8").digest("hex");
  log(`  JSON: ${Buffer.byteLength(jsonText, "utf8")} bytes, sha256=${jsonSha.slice(0, 16)}…, schema=${jsonParsed.schema}, verdict=${jsonParsed.verdict}`);
  check("JSON 导出内容为 rejoinlab.report/v1", jsonParsed.schema === "rejoinlab.report/v1", `schema=${jsonParsed.schema}`);

  expectingDownload = true;
  const htmlDownload = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByTestId("download-html").click();
  const htmlFile = await htmlDownload;
  const htmlPath = path.join(tmpDir, "report.html");
  await htmlFile.saveAs(htmlPath);
  expectingDownload = false;
  const htmlText = readFileSync(htmlPath, "utf8");
  log(`  HTML: ${Buffer.byteLength(htmlText, "utf8")} bytes, has <script: ${htmlText.includes("<script")}, has http(s)://: ${/https?:\/\//.test(htmlText)}`);
  check("HTML 导出无 <script 且无 http(s):// 远程引用", !htmlText.includes("<script") && !/https?:\/\//.test(htmlText), "self-contained");

  log("5. Storage / network counters after import + analyze + export:");
  const counters = await page.evaluate(() => {
    const c = (window as unknown as { __t012: { lsWrites: number; ssWrites: number; idbOpens: number; idbDeletes: number } }).__t012;
    return {
      lsWrites: c.lsWrites,
      ssWrites: c.ssWrites,
      idbOpens: c.idbOpens,
      idbDeletes: c.idbDeletes,
      lsLength: window.localStorage.length,
      ssLength: window.sessionStorage.length,
    };
  });
  const dbs = await page.evaluate(() => indexedDB.databases().then((list) => list.map((d) => d.name)));
  log(`  localStorage writes=${counters.lsWrites}, length=${counters.lsLength}`);
  log(`  sessionStorage writes=${counters.ssWrites}, length=${counters.ssLength}`);
  log(`  IndexedDB opens=${counters.idbOpens}, deletes=${counters.idbDeletes}, databases=[${dbs.join(", ")}]`);
  log(`  total requests=${requests.length}, external=${externalRequests.length} (${externalRequests.join(", ") || "none"})`);
  log(`  page errors=${pageErrors.length} (${pageErrors.join("; ") || "none"})`);
  check("localStorage 写入 0", counters.lsWrites === 0, `${counters.lsWrites}`);
  check("localStorage 长度 0", counters.lsLength === 0, `${counters.lsLength}`);
  check("sessionStorage 写入 0", counters.ssWrites === 0, `${counters.ssWrites}`);
  check("sessionStorage 长度 0", counters.ssLength === 0, `${counters.ssLength}`);
  check("IndexedDB 打开 0", counters.idbOpens === 0, `${counters.idbOpens}`);
  check("IndexedDB 数据库 0", dbs.length === 0, `[${dbs.join(", ")}]`);
  check("外部网络请求 0", externalRequests.length === 0, externalRequests.join(", ") || "none");
  check("浏览器未处理异常 0", pageErrors.length === 0, pageErrors.join("; ") || "none");

  log("6. Clear (清空） removes originals + derived state:");
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByTestId("event-count").waitFor();
  const countAfter = await page.getByTestId("event-count").innerText();
  const statusAfter = await page.getByTestId("run-status").innerText();
  const exportText = await page.locator('section[aria-label="导出报告"]').innerText();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lsAfter = await page.evaluate(() => window.localStorage.length);
  const countersAfter = await page.evaluate(() => (window as unknown as { __t012: { lsWrites: number; ssWrites: number; idbOpens: number } }).__t012);
  log(`  event-count after clear: ${countAfter}; run-status: ${statusAfter}; localStorage length: ${lsAfter}`);
  log(`  export section: ${exportText.replace(/\s+/g, " ").slice(0, 120)}`);
  log(`  body still contains imported content "sunny, 21C": ${bodyText.includes("sunny, 21C")}; contains "Hello, ": ${bodyText.includes("Hello, ")}`);
  log(`  storage writes after clear: ls=${countersAfter.lsWrites}, ss=${countersAfter.ssWrites}, idb=${countersAfter.idbOpens}`);
  check("清空后事件数 0", countAfter === "0 条", countAfter);
  check("清空后运行状态回到未运行", statusAfter === "未运行", statusAfter);
  check("清空后导出区回到“运行分析后可导出”", exportText.includes("运行分析后可导出"), "export section reset");
  check("清空后原始事件内容无残留（工具结果文本消失）", !bodyText.includes("sunny, 21C"), "derived content removed");
  check("清空后消息文本无残留", !bodyText.includes("Hello, "), "message content removed");
  check("清空后 localStorage 仍为 0", lsAfter === 0, `${lsAfter}`);
  check("清空未产生存储写入", countersAfter.lsWrites === 0 && countersAfter.ssWrites === 0 && countersAfter.idbOpens === 0, `ls=${countersAfter.lsWrites} ss=${countersAfter.ssWrites} idb=${countersAfter.idbOpens}`);

  log("7. Static source scan (comments stripped, src/):");
  function stripComments(content: string): string {
    return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  }
  function listFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) listFiles(p, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
    return out;
  }
  for (const token of ["localStorage", "sessionStorage", "indexedDB"]) {
    const found: string[] = [];
    for (const file of listFiles(`${ROOT}src`)) {
      if (stripComments(readFileSync(file, "utf8")).includes(token)) found.push(file.replace(ROOT, ""));
    }
    log(`  ${token}: ${found.length === 0 ? "0 hits" : `FOUND in ${found.join(", ")}`}`);
    check(`源码无 ${token}`, found.length === 0, found.join(", ") || "0 hits");
  }

  await browser.close();
} catch (error) {
  check("隐私浏览器流程完成", false, error instanceof Error ? error.message : String(error));
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
