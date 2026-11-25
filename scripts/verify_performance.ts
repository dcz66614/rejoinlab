/**
 * P031 RejoinLab — T012: 性能验证（scripts/verify_performance.ts）。
 *
 * 验收命令：npm run test:performance（本脚本为该命令的 T012 新增部分；
 * 命令同时保留 T007 的 vitest 性能套件，见 package.json）。
 *
 * 两部分，均为真实测量：
 * A. 进程内（与 Worker 内 buildWorkerResult 调用的同一批生产函数
 *    evaluateFixture / analyzeFixture）：最大 40 事件轨迹完整路径+
 *    恢复路径分析各 10 次，逐次记录耗时；24 条 Golden 逐条计时与
 *    BFS 节点数；41 事件超限 10 次；BFS 节点预算探针。
 * B. 真实浏览器 Worker：对生产构建的 Worker chunk（dist/assets/
 *    rejoin.worker-*.js）在 Chromium 内建真实 Worker 线程，投递同一
 *    40 事件轨迹 5 次，记录 Worker 内 durationMs 与往返耗时。
 *
 * 门槛：单轨迹耗时每次 < 1,000 ms；搜索节点 ≤ 5,000；41 事件 10/10
 * 返回 INCONCLUSIVE_LIMIT。任一失败即 exit 1。
 * 日志：artifacts/logs/T012_PERFORMANCE.log。
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { evaluateFixture, type ReplayFixture } from "../src/replay/planner.js";
import { analyzeFixture, searchShortest } from "../src/replay/search.js";
import { ev, norm, runFinish, runStart } from "../tests/core/helpers.js";
import { GOLDEN_IDS, loadFixture } from "../tests/replay/golden-helpers.js";

const ROOT = `${process.cwd().replace(/\/$/, "")}/`;
if (!existsSync(`${ROOT}package.json`)) {
  throw new Error(`verify script must run from the project root (cwd=${process.cwd()})`);
}
const LOG_PATH = `${ROOT}artifacts/logs/T012_PERFORMANCE.log`;
const PREVIEW_URL = "http://127.0.0.1:4173";

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

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * Exactly 40 events (与 tests/s0/performance.test.ts 同构）：
 * RUN_STARTED + TEXT_MESSAGE_START + 33 CONTENT + TEXT_MESSAGE_END +
 * MESSAGES_SNAPSHOT + STATE_SNAPSHOT + STATE_DELTA + RUN_FINISHED。
 * 断线在 index 10，恢复走 RESUME_FROM_CHECKPOINT。
 */
function fortyEventFixture(): ReplayFixture {
  const deltas = Array.from({ length: 33 }, (_, i) => `x${i}`);
  const content = deltas.join("");
  return {
    scenarioId: "T-40",
    events: norm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ...deltas.map((delta) =>
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta }),
      ),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [{ id: "m1", role: "assistant", content }],
      }),
      ev("STATE_SNAPSHOT", { snapshot: { count: 1 } }),
      ev("STATE_DELTA", {
        delta: [{ op: "replace", path: "/count", value: 2 }],
      }),
      runFinish("t1", "r1"),
    ]),
    recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 10 },
  };
}

const TARGETS: Record<string, string | null> = {
  G01: "DUPLICATE_TOOL_CALL",
  G02: "MESSAGE_REORDER",
  G03: "MESSAGE_REORDER",
  G04: "LOST_EVENT",
  G05: "OUT_OF_ORDER",
  G06: "SNAPSHOT_MISMATCH",
  G07: "SUSPECTED_DUPLICATE",
  G08: "TRUNCATED_RUN",
};

const startedAt = new Date().toISOString();
const head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
log("T012 PERFORMANCE — RejoinLab 性能验证");
log(`startedAt(UTC): ${startedAt}`);
log(`HEAD: ${head}`);
log(`node: ${process.version} (${process.platform}/${process.arch})`);
log("");

/* ---------------- A. 进程内：40 事件轨迹 ---------------- */
log("A. 40-event max trace (in-process, production evaluateFixture/analyzeFixture):");
const forty = fortyEventFixture();
log(`  events: ${forty.events.length} (limit 40)`);
const evalTimes: number[] = [];
const analyzeTimes: number[] = [];
for (let i = 0; i < 10; i += 1) {
  let verdict = "";
  let visitedStates = 0;
  evalTimes.push(
    timeMs(() => {
      const r = evaluateFixture(forty);
      verdict = r.verdict;
      visitedStates = r.metrics.visitedStates;
    }),
  );
  let bfsVisited = 0;
  let bfsLimit = false;
  analyzeTimes.push(
    timeMs(() => {
      const a = analyzeFixture(forty, null);
      verdict = a.evaluation.verdict;
      bfsVisited = a.bfsVisited;
      bfsLimit = a.bfsLimitExceeded;
    }),
  );
  log(
    `  run ${i + 1}: evaluate ${evalTimes[i].toFixed(2)} ms, analyze ${analyzeTimes[i].toFixed(2)} ms, ` +
      `verdict=${verdict}, visitedStates=${visitedStates}, bfsVisited=${bfsVisited}, bfsLimitExceeded=${bfsLimit}`,
  );
}
const maxEval = Math.max(...evalTimes);
const maxAnalyze = Math.max(...analyzeTimes);
log(`  evaluate: max ${maxEval.toFixed(2)} ms, mean ${(evalTimes.reduce((a, b) => a + b, 0) / evalTimes.length).toFixed(2)} ms`);
log(`  analyze:  max ${maxAnalyze.toFixed(2)} ms, mean ${(analyzeTimes.reduce((a, b) => a + b, 0) / analyzeTimes.length).toFixed(2)} ms`);
check("40 事件 evaluate 每次 < 1,000 ms", evalTimes.every((t) => t < 1000), `max=${maxEval.toFixed(2)} ms over 10 runs`);
check("40 事件 analyze 每次 < 1,000 ms", analyzeTimes.every((t) => t < 1000), `max=${maxAnalyze.toFixed(2)} ms over 10 runs`);

/* ---------------- A2. 24 Golden 计时 + 节点 ---------------- */
log("");
log("B. All 24 Goldens (in-process analyzeFixture, per-golden time + BFS nodes):");
let worstMs = 0;
let worstId = "";
let maxNodes = 0;
let maxNodesId = "";
for (const id of GOLDEN_IDS) {
  const target = TARGETS[id] ?? null;
  let visited = 0;
  let limit = false;
  const ms = timeMs(() => {
    const a = analyzeFixture(loadFixture(id), target);
    visited = a.bfsVisited;
    limit = a.bfsLimitExceeded;
  });
  if (ms > worstMs) {
    worstMs = ms;
    worstId = id;
  }
  if (visited > maxNodes) {
    maxNodes = visited;
    maxNodesId = id;
  }
  log(`  ${id}: ${ms.toFixed(2)} ms, bfsVisited=${visited}, bfsLimitExceeded=${limit}`);
  check(`${id} analyze < 1,000 ms`, ms < 1000, `${ms.toFixed(2)} ms`);
  check(`${id} BFS 节点 ≤ 5,000`, visited <= 5000 && !limit, `visited=${visited}`);
}
log(`  worst: ${worstId} ${worstMs.toFixed(2)} ms; max BFS nodes: ${maxNodes} (${maxNodesId})`);

/* ---------------- A3. 41 事件超限 ---------------- */
log("");
log("C. 41-event over-limit (10 repeats):");
const over: ReplayFixture = {
  ...forty,
  events: [
    ...forty.events,
    {
      sourceIndex: 40,
      sourceEventKey: null,
      transportEventId: null,
      event: ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "y" }),
    },
  ],
};
log(`  events: ${over.events.length}`);
let limitHits = 0;
for (let i = 0; i < 10; i += 1) {
  const r = evaluateFixture(over);
  const ok =
    r.verdict === "INCONCLUSIVE_LIMIT" &&
    r.diagnostics.map((d) => d.code).join(",") === "LIMIT_EXCEEDED";
  if (ok) limitHits += 1;
  log(`  run ${i + 1}: verdict=${r.verdict}, diagnostics=[${r.diagnostics.map((d) => d.code).join(",")}]`);
}
check("41 事件 10/10 返回 INCONCLUSIVE_LIMIT", limitHits === 10, `${limitHits}/10`);

/* ---------------- A4. BFS 预算探针 ---------------- */
log("");
log("D. BFS node-budget probe (G01, maxDepth 3, maxNodes 1):");
const probe = searchShortest(loadFixture("G01"), "DUPLICATE_TOOL_CALL", 3, 1);
log(`  limitExceeded=${probe.limitExceeded}, sequence=${JSON.stringify(probe.sequence)}, visited=${probe.visited}`);
check("节点预算耗尽 → limitExceeded 且 sequence 为 null", probe.limitExceeded === true && probe.sequence === null, `visited=${probe.visited}`);

/* ---------------- E. 真实浏览器 Worker ---------------- */
log("");
log("E. Real Chromium Worker (production dist chunk, 40-event trace, 5 runs):");
const workerFile = readdirSync(`${ROOT}dist/assets`).find((f) => f.startsWith("rejoin.worker-") && f.endsWith(".js"));
if (workerFile === undefined) {
  check("dist 存在 Worker chunk", false, "dist/assets/rejoin.worker-*.js not found — run npm run build first");
} else {
  const workerUrl = `${PREVIEW_URL}/assets/${workerFile}`;
  log(`  worker chunk: ${workerFile}`);
  let preview: ChildProcess | null = null;
  try {
    // 注意：必须直接用 node 跑 vite/bin/vite.js，不要经 npx。
    // 经 npx 时 kill() 只能杀掉 npx 包装进程，真正的 vite preview
    // 服务器（node node_modules/.bin/vite）会变成孤儿继续占着 4173
    // （T012 曾因此残留 PID 7714，导致后续 test:e2e 报端口占用）。
    preview = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "preview", "--port", "4173", "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: ROOT,
        stdio: "ignore",
      },
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
    log(`  chromium: ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto(PREVIEW_URL);
    const fixtureJson = JSON.parse(JSON.stringify(forty)) as ReplayFixture;
    const workerTimes: number[] = [];
    const roundTrips: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await page.evaluate(
        async ({ url, input, jobId }) => {
          const worker = new Worker(url, { type: "module" });
          try {
            const t0 = performance.now();
            const response = await new Promise<{ durationMs: number; verdict: string; visitedStates: number }>(
              (resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("worker response timeout 30s")), 30_000);
                worker.onmessage = (event: MessageEvent) => {
                  const data = event.data as {
                    type: string;
                    jobId: string;
                    result?: { durationMs: number; evaluation: { verdict: string; metrics: { visitedStates: number } } };
                    error?: { message: string };
                  };
                  if (data.jobId !== jobId) return;
                  clearTimeout(timer);
                  if (data.type === "RESULT" && data.result !== undefined) {
                    resolve({
                      durationMs: data.result.durationMs,
                      verdict: data.result.evaluation.verdict,
                      visitedStates: data.result.evaluation.metrics.visitedStates,
                    });
                  } else {
                    reject(new Error(`worker error: ${data.error?.message ?? data.type}`));
                  }
                };
                worker.onerror = (e) => {
                  clearTimeout(timer);
                  reject(new Error(`worker onerror: ${String((e as ErrorEvent).message ?? e)}`));
                };
                worker.postMessage({ type: "ANALYZE", jobId, input });
              },
            );
            const roundTrip = performance.now() - t0;
            return { ...response, roundTripMs: roundTrip };
          } finally {
            worker.terminate();
          }
        },
        { url: workerUrl, input: fixtureJson, jobId: `t012-perf-${i + 1}` },
      );
      workerTimes.push(result.durationMs);
      roundTrips.push(result.roundTripMs);
      log(
        `  run ${i + 1}: worker durationMs=${result.durationMs.toFixed(2)} ms, round-trip=${result.roundTripMs.toFixed(2)} ms, ` +
          `verdict=${result.verdict}, visitedStates=${result.visitedStates}`,
      );
    }
    await browser.close();
    const maxWorker = Math.max(...workerTimes);
    const maxRoundTrip = Math.max(...roundTrips);
    log(`  worker durationMs: max ${maxWorker.toFixed(2)} ms`);
    log(`  round-trip: max ${maxRoundTrip.toFixed(2)} ms`);
    check("真实 Worker 计算时间每次 < 1,000 ms", workerTimes.every((t) => t < 1000), `max=${maxWorker.toFixed(2)} ms over 5 runs`);
    check("真实 Worker 往返每次 < 1,000 ms", roundTrips.every((t) => t < 1000), `max=${maxRoundTrip.toFixed(2)} ms over 5 runs`);
  } catch (error) {
    check("真实浏览器 Worker 测量完成", false, error instanceof Error ? error.message : String(error));
  } finally {
    // SIGTERM 后等端口真正释放；若 5 秒内未释放则 SIGKILL，
    // 绝不把占着 4173 的服务器留给下一条命令。
    if (preview !== null) {
      preview.kill();
      const freeDeadline = Date.now() + 5_000;
      for (;;) {
        try {
          await fetch(PREVIEW_URL);
        } catch {
          break;
        }
        if (Date.now() > freeDeadline) {
          preview.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
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
