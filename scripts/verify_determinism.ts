/**
 * P031 RejoinLab — T012: 确定性验证（scripts/verify_determinism.ts）。
 *
 * 验收命令：npm run test:determinism（本脚本为该命令的 T012 新增部分；
 * 命令同时保留 T004/T007 的 vitest 确定性套件，见 package.json）。
 *
 * 方法：对同一输入（Golden 故障轨迹 G01/G03 与正常轨迹 N09）连续
 * 运行完整产品路径 analyzeFixture → buildReport → reportHash 各 100 次，
 * 比较剔除 durationMs 后的规范化报告 SHA-256、最短故障注入序列、
 * 首个分歧位置与诊断代码顺序。四者 100 次必须完全相同。
 * 运行的是 T003–T005/T010 的生产代码（与 Worker 内 buildWorkerResult
 * 调用的同一批函数），不是测试替身。
 *
 * 日志：artifacts/logs/T012_DETERMINISM.log（真实运行输出，含实际
 * SHA-256 值、重复次数与环境信息）。任一断言失败即 exit 1。
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildReport, reportHash } from "../src/report/json.js";
import { analyzeFixture } from "../src/replay/search.js";
import { loadFixture } from "../tests/replay/golden-helpers.js";

const REPEATS = 100;
const ROOT = `${process.cwd().replace(/\/$/, "")}/`;
if (!existsSync(`${ROOT}package.json`)) {
  throw new Error(`verify script must run from the project root (cwd=${process.cwd()})`);
}
const LOG_PATH = `${ROOT}artifacts/logs/T012_DETERMINISM.log`;

interface FixtureCase {
  readonly id: string;
  readonly targetCode: string | null;
}

const CASES: readonly FixtureCase[] = [
  { id: "G01", targetCode: "DUPLICATE_TOOL_CALL" },
  { id: "G03", targetCode: "MESSAGE_REORDER" },
  { id: "N09", targetCode: null },
];

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
log("T012 DETERMINISM — RejoinLab 确定性验证");
log(`startedAt(UTC): ${startedAt}`);
log(`HEAD: ${head}`);
log(`node: ${process.version} (${process.platform}/${process.arch})`);
log(`repeats per fixture: ${REPEATS}`);
log("");

for (const { id, targetCode } of CASES) {
  const fixture = loadFixture(id);
  const sourceText = readFileSync(`${ROOT}fixtures/golden/${id}.json`, "utf8");
  const sourceSha = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const hashes = new Set<string>();
  const sequences = new Set<string>();
  const divergences = new Set<string>();
  const diagOrders = new Set<string>();
  const verdicts = new Set<string>();
  let totalMs = 0;
  let firstReportHash = "";
  let firstSequence = "";
  let firstDivergence = "";
  let firstDiagOrder = "";
  for (let i = 0; i < REPEATS; i += 1) {
    const t0 = performance.now();
    const analysis = analyzeFixture(fixture, targetCode);
    const report = buildReport({
      evaluation: analysis.evaluation,
      shortestInjectionSequence: analysis.shortestInjectionSequence,
      durationMs: 0,
      source: {
        scenarioId: fixture.scenarioId,
        sourceFormat: "JSONL",
        sourceText,
        eventCount: fixture.events.length,
      },
      recovery: {
        strategy: fixture.recovery.strategy,
        ...(fixture.recovery.disconnectAfter !== undefined
          ? { disconnectAfter: fixture.recovery.disconnectAfter }
          : {}),
        ...(fixture.recovery.resumeAfterSourceIndex !== undefined
          ? { resumeAfterSourceIndex: fixture.recovery.resumeAfterSourceIndex }
          : {}),
      },
    });
    totalMs += performance.now() - t0;
    const hash = reportHash(report);
    if (i === 0) {
      firstReportHash = hash;
      firstSequence = JSON.stringify(report.shortestInjectionSequence);
      firstDivergence = JSON.stringify(report.firstDivergence ?? null);
      firstDiagOrder = JSON.stringify(report.diagnostics.map((d) => d.code));
    }
    hashes.add(hash);
    sequences.add(JSON.stringify(report.shortestInjectionSequence));
    divergences.add(JSON.stringify(report.firstDivergence ?? null));
    diagOrders.add(JSON.stringify(report.diagnostics.map((d) => d.code)));
    verdicts.add(report.verdict);
  }
  log(`${id} (events=${fixture.events.length}, target=${targetCode ?? "null"}):`);
  log(`  report SHA-256 (durationMs excluded): ${firstReportHash}`);
  log(`  source SHA-256: ${sourceSha}`);
  log(`  shortestInjectionSequence: ${firstSequence}`);
  log(`  firstDivergence: ${firstDivergence}`);
  log(`  diagnostics order: ${firstDiagOrder}`);
  log(`  verdicts seen: ${[...verdicts].join(", ")}`);
  log(`  100-run total: ${totalMs.toFixed(1)} ms (mean ${(totalMs / REPEATS).toFixed(2)} ms/run)`);
  check(`${id} 报告 SHA-256 100 次完全相同`, hashes.size === 1, `distinct=${hashes.size}`);
  check(`${id} 最短故障序列 100 次完全相同`, sequences.size === 1, `distinct=${sequences.size}`);
  check(`${id} 首个分歧位置 100 次完全相同`, divergences.size === 1, `distinct=${divergences.size}`);
  check(`${id} 诊断代码顺序 100 次完全相同`, diagOrders.size === 1, `distinct=${diagOrders.size}`);
  log("");
}

log(`RESULT: ${failures.length === 0 ? "PASS" : "FAIL"} (${failures.length} failure(s), ${CASES.length * REPEATS} total runs)`);
if (failures.length > 0) {
  for (const f of failures) log(`  FAILED: ${f}`);
}
log(`finishedAt(UTC): ${new Date().toISOString()}`);
mkdirSync(`${ROOT}artifacts/logs`, { recursive: true });
writeFileSync(LOG_PATH, lines.join("\n") + "\n", "utf8");
console.log(`log written: ${LOG_PATH}`);
process.exitCode = failures.length === 0 ? 0 : 1;
