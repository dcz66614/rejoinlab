/**
 * P031-T013 verify:docs — documentation assertions for RejoinLab.
 *
 * Checks (all must pass; any failure exits 1):
 *  1. README title is exactly the frozen title (PROJECT_BOOK §0).
 *  2. README names the 5 verdicts, the 3 recovery strategies, the 40-event
 *     bound, the 1,000 ms bound, 0-human participation, the exactly-once
 *     boundary, and the SSE-vs-cursor distinction.
 *  3. All required docs exist (README, LICENSE, THIRD_PARTY_NOTICES,
 *     SECURITY, USER_GUIDE, LIMITATIONS, ALGORITHM, MODEL_CONTRACT,
 *     AGUI_SCOPE, EVENT_SCHEMA).
 *  4. Performance numbers cited in README match the disk logs by parsing
 *     on every run (no hardcoded values — the logs move with cold-start
 *     variance, see L-T012-01): S0_GATE.json (slowest single trace,
 *     slowest Golden, 24/24, 13/13 — parsed from the current file on
 *     every run) and the CURRENT T012_PERFORMANCE.log
 *     (evaluate / analyze / worst-Golden / Worker / round-trip maxima plus
 *     the run's startedAt timestamp). Reviewer re-run numbers (20.38 /
 *     60.71 / 71.00 / 321.00) live only in subagent reports, not in a
 *     parseable disk log, so README must NOT cite them; neither may it cite
 *     the overwritten T012 run (29.94 / 76.17 / 26.60 / 49.00 / 101.30),
 *     the stale early-run "12.91", or P030's "10.8" / "10.0 ms".
 *  5. docs/LIMITATIONS.md carries all 32 limitation ids.
 *  6. README makes no remote-API / upload / cloud promise, and states the
 *     offline, no-upload behaviour.
 *  7. USER_GUIDE / ALGORITHM / MODEL_CONTRACT contain their key vocabulary.
 *
 * This script is a deterministic text/parse check. It does NOT re-run the
 * product, re-measure performance, or re-execute the Oracle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate project root (package.json)");
}

const ROOT = findRoot();

const failures: string[] = [];
const passes: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

function mustContain(haystack: string, needle: string, where: string): void {
  check(
    `${where} contains "${needle}"`,
    haystack.includes(needle),
    `missing "${needle}" in ${where}`,
  );
}

function mustNotContain(haystack: string, needle: string, where: string): void {
  check(
    `${where} does not contain "${needle}"`,
    !haystack.includes(needle),
    `forbidden "${needle}" found in ${where}`,
  );
}

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const limitations = fs.readFileSync(
  path.join(ROOT, "docs", "LIMITATIONS.md"),
  "utf8",
);
const userGuide = fs.readFileSync(
  path.join(ROOT, "docs", "USER_GUIDE.md"),
  "utf8",
);
const algorithm = fs.readFileSync(
  path.join(ROOT, "docs", "ALGORITHM.md"),
  "utf8",
);
const modelContract = fs.readFileSync(
  path.join(ROOT, "docs", "MODEL_CONTRACT.md"),
  "utf8",
);

// 1. Exact frozen title.
check(
  'README title is the frozen title',
  readme.startsWith(
    "# RejoinLab — Your AI agent reconnected. Did your conversation survive correctly?",
  ),
  "README first line is not the frozen title",
);

// 2. README vocabulary.
for (const v of [
  "CONSISTENT",
  "INCONSISTENT",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
  "INCOMPLETE_TRACE",
]) {
  mustContain(readme, v, "README.md");
}
for (const s of [
  "FULL_REPLAY_FROM_START",
  "RESUME_FROM_CHECKPOINT",
  "REPLAY_AFTER_SOURCE_CURSOR",
]) {
  mustContain(readme, s, "README.md");
}
mustContain(readme, "40 条事件", "README.md");
mustContain(readme, "1,000 ms", "README.md");
mustContain(readme, "真人参与 0 人", "README.md");
mustContain(readme, "exactly-once 不在保证范围内", "README.md");
mustContain(readme, "Last-Event-ID", "README.md");
mustContain(readme, "AG-UI 1.0", "README.md");
mustContain(readme, "24/24", "README.md");
mustContain(readme, "13/13", "README.md");

// 3. Required docs exist.
for (const f of [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "docs/USER_GUIDE.md",
  "docs/LIMITATIONS.md",
  "docs/ALGORITHM.md",
  "docs/MODEL_CONTRACT.md",
  "docs/AGUI_SCOPE.md",
  "docs/EVENT_SCHEMA.md",
]) {
  check(`required doc exists: ${f}`, fs.existsSync(path.join(ROOT, f)), `missing ${f}`);
}

// 4. Cited performance numbers match disk logs.
const s0Gate = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "artifacts", "reports", "S0_GATE.json"),
    "utf8",
  ),
) as {
  verdict: string;
  performance: {
    t40AnalyzeMs: number;
    worstGoldenId: string;
    worstGoldenMs: number;
  };
  matrix: Array<{ id: string; measured: string | number; pass: boolean }>;
};
check("S0_GATE.json verdict is PASS", s0Gate.verdict === "PASS", `verdict=${s0Gate.verdict}`);
// S0 timings move with cold-start variance exactly like the T012 log: a
// fresh S0 run measured 41.5 ms / G05 10.7 ms where an earlier run
// measured 43.9 ms / G05 11.9 ms. The T013 version of this script had
// those earlier values hardcoded as literals, so ANY S0 re-run failed
// it. Parse the CURRENT S0_GATE.json on every run and require README
// to cite those current values — never a hardcoded literal.
const s0T40 = String(s0Gate.performance.t40AnalyzeMs);
const s0Worst = String(s0Gate.performance.worstGoldenMs);
check(
  "S0 slowest single trace matches current S0_GATE.json and README cites it",
  readme.includes(s0T40),
  `t40AnalyzeMs=${s0Gate.performance.t40AnalyzeMs}`,
);
check(
  "S0 slowest Golden matches current S0_GATE.json and README cites it",
  readme.includes(s0Gate.performance.worstGoldenId) && readme.includes(s0Worst),
  `worst=${s0Gate.performance.worstGoldenId} ${s0Gate.performance.worstGoldenMs}`,
);
check(
  "S0 matrix is 13/13 and README cites it",
  s0Gate.matrix.length === 13 &&
    s0Gate.matrix.every((m) => m.pass === true) &&
    readme.includes("13/13"),
  `matrix rows=${s0Gate.matrix.length}`,
);

const perfLog = fs.readFileSync(
  path.join(ROOT, "artifacts", "logs", "T012_PERFORMANCE.log"),
  "utf8",
);
function parseMax(re: RegExp, label: string): number {
  const m = perfLog.match(re);
  if (!m) throw new Error(`could not parse ${label} from T012_PERFORMANCE.log`);
  return Number(m[1]);
}
// NOTE: T012_PERFORMANCE.log is regenerated on every `npm run test:performance`
// run, and the maxima move with cold-start variance (see L-T012-01). This
// script therefore parses the CURRENT log on every run and requires README
// to cite exactly those values with the run's timestamp. If the log was
// regenerated since the docs were written, this check fails on purpose —
// update README + docs/ALGORITHM.md to the new run, do not relax the check.
const logStartedAt = perfLog.match(/startedAt\(UTC\): (\S+)/)?.[1] ?? "";
check(
  "T012_PERFORMANCE.log has a startedAt timestamp and README cites it",
  logStartedAt !== "" && readme.includes(logStartedAt),
  `startedAt=${logStartedAt}`,
);
const worstGolden = perfLog.match(/worst: (\w+) ([\d.]+) ms/);
if (!worstGolden) throw new Error("could not parse worst golden from T012_PERFORMANCE.log");
const cited: Array<[string, string]> = [
  ["T012 evaluate max ms", parseMax(/evaluate: max ([\d.]+) ms/, "evaluate max").toFixed(2)],
  ["T012 analyze max ms", parseMax(/analyze:\s+max ([\d.]+) ms/, "analyze max").toFixed(2)],
  ["T012 worst Golden ms", Number(worstGolden[2]).toFixed(2)],
  ["T012 Worker max ms", parseMax(/worker durationMs: max ([\d.]+) ms/, "worker max").toFixed(2)],
  ["T012 round-trip max ms", parseMax(/round-trip: max ([\d.]+) ms/, "round-trip max").toFixed(2)],
];
for (const [label, expected] of cited) {
  check(
    `${label}: current log value ${expected} is cited in README.md`,
    readme.includes(expected),
    `current log value "${expected}" is not cited in README.md`,
  );
}
check(
  "T012 worst Golden id is cited in README.md",
  readme.includes(`最慢 ${worstGolden[1]}`),
  `worst golden id=${worstGolden[1]}`,
);
check(
  "T012 BFS max is 8 and README cites BFS 最多 8",
  perfLog.includes("max BFS nodes: 8 (G05)") && readme.includes("BFS 最多 8"),
  "T012 log or README missing BFS max 8",
);
check(
  "T012 41-event over-limit is 10/10 and README cites it",
  perfLog.includes("[PASS] 41 事件 10/10 返回 INCONCLUSIVE_LIMIT") &&
    readme.includes("41 条 → INCONCLUSIVE_LIMIT"),
  "T012 log or README missing 41-event 10/10",
);

// Stale / unparseable numbers must NOT be cited anywhere in README or ALGORITHM:
// overwritten T012 run (29.94 / 76.17 / 26.60 / 49.00 / 101.30), reviewer
// re-run numbers that live only in subagent reports (20.38 / 60.71 / 71.00 /
// 321.00), the stale early-run "12.91", and P030's "10.8" / "10.0 ms".
for (const stale of ["29.94", "76.17", "26.60", "49.00", "101.30", "20.38", "60.71", "71.00", "321.00", "12.91", "10.8", "10.0 ms"]) {
  mustNotContain(readme, stale, "README.md");
  mustNotContain(algorithm, stale, "docs/ALGORITHM.md");
}

// 5. LIMITATIONS.md carries all 32 ids.
const requiredIds: string[] = [
  "L-T003-01", "L-T003-02", "L-T003-03",
  "L-T007-01", "L-T007-02", "L-T007-03", "L-T007-04",
  "L-T007-05", "L-T007-06", "L-T007-07", "L-T007-08",
  "L-T007-09",
  "L-T009-01", "L-T009-02", "L-T009-03",
  "L-T010-01", "L-T010-02", "L-T010-03", "L-T010-04",
  "L-T011-01", "L-T011-02",
  "L-T012-01", "L-T012-02",
  "L-T013-01", "L-T013-02", "L-T013-03",
  "L-SPEC-01", "L-SPEC-02", "L-SPEC-03",
  "L-SPEC-04", "L-SPEC-05", "L-SPEC-06",
];
const missingIds = requiredIds.filter((id) => !limitations.includes(id));
check(
  `LIMITATIONS.md carries all ${requiredIds.length} limitation ids`,
  missingIds.length === 0,
  `missing ids: ${missingIds.join(", ")}`,
);

// 6. No remote-API / upload / cloud promise; offline behaviour stated.
for (const forbidden of ["上传到云", "云端运行", "联网运行", "在线分析", "会上传"]) {
  mustNotContain(readme, forbidden, "README.md");
}
mustContain(readme, "不上传文件", "README.md");
mustContain(readme, "离线运行", "README.md");

// 7. Key vocabulary in the other docs.
for (const s of ["RUN_STARTED", "TOOL_CALL_START", "FULL_REPLAY_FROM_START", "INCONCLUSIVE_LIMIT", "清空"]) {
  mustContain(userGuide, s, "docs/USER_GUIDE.md");
}
for (const s of ["canon", "BFS", "RFC 8785", "SHA-256", "双轨"]) {
  mustContain(algorithm, s, "docs/ALGORITHM.md");
}
for (const s of ["rejoinlab.report/v1", "AG-UI 1.0", "A-01", "A-08", "SUSPECTED_DUPLICATE"]) {
  mustContain(modelContract, s, "docs/MODEL_CONTRACT.md");
}

console.log(`verify:docs: ${passes.length} checks passed, ${failures.length} failed`);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:docs: RESULT=PASS");
