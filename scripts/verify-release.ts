/**
 * P031-T014 verify:release — release-package assertions for RejoinLab.
 *
 * Checks (all must pass; any failure exits 1). This script is a
 * deterministic structural check. It does NOT re-run any test suite,
 * re-measure performance, or re-execute the Oracle; the suites are
 * re-run separately and their logs are asserted to exist and show PASS
 * (check 11).
 *
 *  1. source.zip exists and passes `unzip -t`.
 *  2. SOURCE_MANIFEST.csv parses (path,sha256,bytes,source); hashes are
 *     64 hex chars; byte counts are non-negative integers.
 *  3. Manifest set == ZIP entry set (no extras, no omissions).
 *  4. Per-file SHA-256 and byte count in the manifest match the ZIP entry.
 *  5. Every manifest row with source=git matches the SHA-256 of the
 *     blob CONTENT at the PINNED freeze commit (`git show
 *     <FREEZE_COMMIT>:<path>` hashed with SHA-256) — the release
 *     corresponds item-by-item to the frozen git version. The freeze
 *     commit is recorded explicitly (FREEZE_COMMIT_DEFAULT, overridable
 *     with the REJOINLAB_FREEZE_COMMIT env var); it is NEVER silently
 *     taken from HEAD, so the check stays valid after later commits
 *     move HEAD. (A git blob id is a SHA-1 over
 *     "blob <size>\0<content>" and can never equal a file SHA-256;
 *     the comparison must hash the blob content, not the blob id.)
 *     NOTE: the freeze-time run MUST set REJOINLAB_FREEZE_COMMIT to the
 *     new freeze hash — a freeze commit's own script cannot name
 *     itself. The default below is updated to the freeze hash in the
 *     handoff commit that follows the freeze (P030 pattern).
 *  6. package.json + package-lock.json are in the ZIP; name/version match
 *     the lockfile.
 *  7. Golden complete: 24 fixtures (G01–G08, N01–N16) +
 *     golden_expected.json in the ZIP.
 *  8. Oracle complete: oracle/*.py, oracle/README.md,
 *     oracle/golden_expected.json, oracle/tests/*.py in the ZIP.
 *  9. No node_modules/, dist/, .git/, .vite/, __pycache__/, .tmp/,
 *     test-results/, scripts/.verify-tmp/ in the ZIP; no .env / .pem /
 *     .key / credentials file names.
 * 10. No secret assignments in ZIP text contents (api_key / access_token
 *     assignments, PRIVATE KEY blocks, password="..." assignments).
 *     `process.env` is NOT flagged — only literal secret values are.
 * 11. Recorded test evidence exists and shows PASS: T014 full-regression
 *     log (vitest 678 passed, oracle pytest, goldens 24/24, e2e 12
 *     passed), T012 determinism/performance/offline/privacy/security
 *     logs (RESULT=PASS), S0_GATE.json (verdict PASS), T006_ORACLE.log
 *     (golden 24/24 PASS), T007_PARITY.log (66 passed), verify:docs +
 *     verify:licenses logs (RESULT=PASS).
 * 12. Delivery evidence exists: README.md, LICENSE,
 *     THIRD_PARTY_NOTICES.md, SECURITY.md, docs/USER_GUIDE.md,
 *     docs/LIMITATIONS.md, docs/ALGORITHM.md, docs/MODEL_CONTRACT.md,
 *     01_project_book/PROJECT_BOOK.md,
 *     02_implementation_plan/IMPLEMENTATION_PLAN.md,
 *     artifacts/review/REVIEW_INDEX.md + REVIEW_PACK_01.md +
 *     REVIEW_PACK_02.md, artifacts/release/RELEASE_MANIFEST.json.
 * 13. SHA256SUMS.txt (standard `sha256sum` format, repo-relative paths)
 *     agrees with the manifest hashes for every file, and
 *     `sha256sum -c` on it exits 0 (run from the repo root).
 * 14. dist.zip exists and passes `unzip -t` and contains index.html;
 *     GitBundle.bundle exists, `git bundle verify` passes, and the
 *     bundle contains the pinned freeze commit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

const ROOT = findRoot(); // p031-rejoinlab
const RELEASE_DIR = path.join(ROOT, "artifacts", "release");
const ZIP_PATH = path.join(RELEASE_DIR, "source.zip");
const DIST_ZIP_PATH = path.join(RELEASE_DIR, "dist.zip");
const MANIFEST_PATH = path.join(RELEASE_DIR, "SOURCE_MANIFEST.csv");
const SUMS_PATH = path.join(RELEASE_DIR, "SHA256SUMS.txt");
const BUNDLE_PATH = path.join(RELEASE_DIR, "GitBundle.bundle");
const ZIP_PREFIX = "rejoinlab-1.0.0/";

const failures: string[] = [];
const passes: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: cwd ?? ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/* ---- 1. ZIP exists and is intact ---- */
check("source.zip exists", fs.existsSync(ZIP_PATH));
let zipOk = false;
if (fs.existsSync(ZIP_PATH)) {
  try {
    run("unzip", ["-t", "-q", ZIP_PATH]);
    zipOk = true;
  } catch {
    zipOk = false;
  }
}
check("source.zip passes unzip -t", zipOk);

/* ---- ZIP inventory via python zipfile (one call) ---- */
interface ZipEntry {
  name: string;
  sha256: string;
  size: number;
}
let zipEntries: ZipEntry[] = [];
if (zipOk) {
  const py =
    "import json, sys, zipfile, hashlib\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "out = []\n" +
    "for i in z.infolist():\n" +
    "    if i.is_dir():\n" +
    "        continue\n" +
    "    data = z.read(i.filename)\n" +
    "    out.append({'name': i.filename, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})\n" +
    "print(json.dumps(out))\n";
  try {
    zipEntries = JSON.parse(
      run("python3", ["-c", py, ZIP_PATH]),
    ) as ZipEntry[];
  } catch (e) {
    failures.push(`zip inventory failed: ${String(e)}`);
  }
}
const zipByName = new Map(zipEntries.map((e) => [e.name, e]));
check("zip inventory read", zipEntries.length > 0, `entries=${zipEntries.length}`);

/* ---- 2. Manifest parses ---- */
interface ManifestRow {
  zipPath: string;
  sha256: string;
  bytes: number;
  source: string;
}
let rows: ManifestRow[] = [];
if (fs.existsSync(MANIFEST_PATH)) {
  const lines = fs
    .readFileSync(MANIFEST_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  check(
    "manifest has header path,sha256,bytes,source",
    lines[0] === "path,sha256,bytes,source",
    `header=${JSON.stringify(lines[0])}`,
  );
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length !== 4) {
      failures.push(`manifest malformed line: ${line}`);
      continue;
    }
    const [zipPath, sha256, bytesStr, source] = parts;
    const bytes = Number(bytesStr);
    rows.push({ zipPath, sha256, bytes, source });
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      failures.push(`manifest bad sha256 for ${zipPath}: ${sha256}`);
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      failures.push(`manifest bad bytes for ${zipPath}: ${bytesStr}`);
    }
  }
} else {
  failures.push("SOURCE_MANIFEST.csv missing");
}
check("manifest rows parsed", rows.length > 0, `rows=${rows.length}`);

/* ---- 3+4. Manifest set == ZIP set; hashes and sizes match ---- */
if (rows.length > 0 && zipEntries.length > 0) {
  const manifestNames = new Set(rows.map((r) => r.zipPath));
  const zipNames = new Set(zipEntries.map((e) => e.name));
  const missingInZip = [...manifestNames].filter((n) => !zipNames.has(n));
  const extraInZip = [...zipNames].filter((n) => !manifestNames.has(n));
  check(
    "manifest set == zip set",
    missingInZip.length === 0 && extraInZip.length === 0,
    `missing in zip: ${missingInZip.join("; ")}; extra in zip: ${extraInZip.join("; ")}`,
  );
  let hashMismatch = 0;
  let sizeMismatch = 0;
  for (const r of rows) {
    const e = zipByName.get(r.zipPath);
    if (!e) continue;
    if (e.sha256 !== r.sha256) hashMismatch++;
    if (e.size !== r.bytes) sizeMismatch++;
  }
  check(
    "manifest sha256 matches zip entries",
    hashMismatch === 0,
    `${hashMismatch} mismatches`,
  );
  check(
    "manifest bytes match zip entries",
    sizeMismatch === 0,
    `${sizeMismatch} mismatches`,
  );
  check(
    "all zip paths under rejoinlab-1.0.0/",
    zipEntries.every((e) => e.name.startsWith(ZIP_PREFIX)),
    "found entry outside prefix",
  );
}

/* ---- 5. Git correspondence at the PINNED freeze commit ---- */
// The freeze commit is pinned explicitly. The default is the pre-freeze
// HEAD; pass REJOINLAB_FREEZE_COMMIT to verify the real freeze
// candidate — a freeze commit's own script cannot name itself, so the
// freeze-time run MUST set the env var to the new freeze hash. There
// is deliberately NO fallback to HEAD: HEAD moves with every handoff
// commit, so resolving the freeze from HEAD would silently verify the
// wrong commit. The handoff commit updates the default to the freeze
// hash (P030 pattern).
const FREEZE_COMMIT_DEFAULT = "fff999da35b97eb776e6239ab197dbd4ae08baf6"; // freeze fff999d (updated at handoff)
const freezeCommit =
  (process.env.REJOINLAB_FREEZE_COMMIT ?? "").trim() || FREEZE_COMMIT_DEFAULT;
let freezeCommitValid = false;
try {
  run("git", ["cat-file", "-e", `${freezeCommit}^{commit}`]);
  freezeCommitValid = true;
} catch {
  freezeCommitValid = false;
}
check("pinned freeze commit exists", freezeCommitValid, freezeCommit);
if (freezeCommitValid && rows.length > 0) {
  let gitMismatch = 0;
  let gitMissing = 0;
  const gitRows = rows.filter((r) => r.source === "git");
  check("manifest has git-sourced rows", gitRows.length > 0, `git rows=${gitRows.length}`);
  // NOTE: a git blob id is a SHA-1 over "blob <size>\0<content>", NOT the
  // file's SHA-256. Comparing manifest hashes against `git rev-parse
  // <freeze>:path` can never match. The correct comparison is: take the blob
  // CONTENT at the pinned freeze commit (`git show <freeze>:path`) and SHA-256 it.
  for (const r of gitRows) {
    const repoPath = r.zipPath.slice(ZIP_PREFIX.length);
    let content: Buffer | null = null;
    try {
      content = execFileSync("git", ["show", `${freezeCommit}:${repoPath}`], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }) as Buffer;
    } catch {
      content = null;
    }
    if (!content) {
      gitMissing++;
    } else if (
      createHash("sha256").update(content).digest("hex") !== r.sha256
    ) {
      gitMismatch++;
    }
  }
  check(
    "manifest sha256 matches pinned freeze blobs",
    gitMismatch === 0 && gitMissing === 0,
    `${gitMismatch} mismatches, ${gitMissing} missing from freeze commit`,
  );
  console.log(`  (pinned freeze commit: ${freezeCommit})`);
}

/* ---- 6. package.json + lockfile in ZIP, name/version match ---- */
const pkgEntry = zipByName.get(`${ZIP_PREFIX}package.json`);
const lockEntry = zipByName.get(`${ZIP_PREFIX}package-lock.json`);
check("package.json in zip", !!pkgEntry);
check("package-lock.json in zip", !!lockEntry);
if (pkgEntry && lockEntry) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
  ) as { name: string; version: string };
  check(
    "package.json name rejoinlab / version 1.0.0",
    pkg.name === "rejoinlab" && pkg.version === "1.0.0",
    `name=${pkg.name} version=${pkg.version}`,
  );
  check(
    "lockfile name/version match package.json",
    lock.name === pkg.name && lock.version === pkg.version,
    `lock name=${lock.name} version=${lock.version}`,
  );
}

/* ---- 7. Golden complete ---- */
const goldenNames: string[] = [];
for (let i = 1; i <= 8; i++) goldenNames.push(`G${String(i).padStart(2, "0")}.json`);
for (let i = 1; i <= 16; i++) goldenNames.push(`N${String(i).padStart(2, "0")}.json`);
const goldenMissing = goldenNames.filter(
  (f) => !zipByName.has(`${ZIP_PREFIX}fixtures/golden/${f}`),
);
check("24 golden fixtures in zip", goldenMissing.length === 0, `missing: ${goldenMissing.join(", ")}`);
check(
  "golden_expected.json in zip",
  zipByName.has(`${ZIP_PREFIX}oracle/golden_expected.json`),
);

/* ---- 8. Oracle complete ---- */
const oracleFiles = [
  "oracle/canonical.py",
  "oracle/reference.py",
  "oracle/replay.py",
  "oracle/run_goldens.py",
  "oracle/generate_goldens.py",
  "oracle/golden_expected.json",
  "oracle/README.md",
  "oracle/__init__.py",
  "oracle/tests/__init__.py",
  "oracle/tests/conftest.py",
  "oracle/tests/test_canonical.py",
  "oracle/tests/test_golden.py",
  "oracle/tests/test_reducer.py",
  "oracle/tests/test_replay.py",
];
const oracleMissing = oracleFiles.filter((f) => !zipByName.has(`${ZIP_PREFIX}${f}`));
check("oracle complete (14 files) in zip", oracleMissing.length === 0, `missing: ${oracleMissing.join(", ")}`);

/* ---- 9. Forbidden entries ---- */
const forbiddenSegments = ["node_modules", "dist", ".git", ".vite", "__pycache__", ".tmp", "test-results", ".verify-tmp"];
const forbiddenFound = zipEntries.filter((e) =>
  e.name.split("/").some((seg) => forbiddenSegments.includes(seg)),
);
check("no node_modules/dist/.git/.vite/__pycache__/.tmp/test-results/.verify-tmp in zip", forbiddenFound.length === 0, forbiddenFound.map((e) => e.name).join("; "));
const badNames = zipEntries.filter((e) => {
  const base = e.name.split("/").pop() ?? "";
  return (
    base.startsWith(".env") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    /credentials/i.test(base)
  );
});
check("no .env/.pem/.key/credentials file names in zip", badNames.length === 0, badNames.map((e) => e.name).join("; "));

/* ---- 10. Secret assignments in ZIP text contents ---- */
if (zipOk) {
  const pyScan =
    "import sys, zipfile, re\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "pats = [re.compile(r'api[_-]?key\\s*[:=]\\s*[\\'\"][^\\'\"]{4,}'), re.compile(r'access[_-]?token\\s*[:=]\\s*[\\'\"][^\\'\"]{4,}'), re.compile(r'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'), re.compile(r'password\\s*=\\s*[\\'\"][^\\'\"]{4,}')]\n" +
    "hits = []\n" +
    "for i in z.infolist():\n" +
    "    if i.is_dir():\n" +
    "        continue\n" +
    "    if not i.filename.endswith(('.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.html', '.css', '.py')):\n" +
    "        continue\n" +
    "    try:\n" +
    "        text = z.read(i.filename).decode('utf-8')\n" +
    "    except Exception:\n" +
    "        continue\n" +
    "    for p in pats:\n" +
    "        if p.search(text):\n" +
    "            hits.append(i.filename)\n" +
    "            break\n" +
    "print('\\n'.join(hits))\n";
  let scanHits = "";
  try {
    scanHits = run("python3", ["-c", pyScan, ZIP_PATH]).trim();
  } catch (e) {
    failures.push(`secret content scan failed: ${String(e)}`);
  }
  check("no secret assignments in zip text contents", scanHits === "", scanHits);
}

/* ---- 11. Recorded test evidence shows PASS ---- */
function mustContainFile(rel: string, needle: string, label: string): void {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    failures.push(`${label} missing: ${rel}`);
    return;
  }
  const text = fs.readFileSync(p, "utf8");
  check(`${label} contains "${needle}"`, text.includes(needle), `${rel} missing "${needle}"`);
}
mustContainFile("artifacts/logs/T014_FULL_REGRESSION.log", "678 passed", "full-regression.log vitest 678");
mustContainFile("artifacts/logs/T014_FULL_REGRESSION.log", "12 passed", "full-regression.log e2e 12");
mustContainFile("artifacts/logs/T014_FULL_REGRESSION.log", "golden: 24/24 PASS", "full-regression.log goldens 24/24");
mustContainFile("artifacts/logs/T012_DETERMINISM.log", "RESULT: PASS", "T012 determinism log");
mustContainFile("artifacts/logs/T012_DETERMINISM.log", "300 total runs", "T012 determinism 300 runs");
mustContainFile("artifacts/logs/T012_PERFORMANCE.log", "RESULT: PASS", "T012 performance log");
mustContainFile("artifacts/logs/T012_OFFLINE.log", "RESULT: PASS", "T012 offline log");
mustContainFile("artifacts/logs/T012_PRIVACY.log", "RESULT: PASS", "T012 privacy log");
mustContainFile("artifacts/logs/T012_SECURITY.log", "RESULT: PASS", "T012 security log");
mustContainFile("artifacts/logs/T006_ORACLE.log", "golden: 24/24 PASS", "T006 oracle log");
mustContainFile("artifacts/logs/T007_PARITY.log", "66 passed", "T007 parity log");
mustContainFile("artifacts/logs/T014_VERIFY_DOCS.log", "RESULT=PASS", "T014 verify:docs log");
mustContainFile("artifacts/logs/T014_VERIFY_LICENSES.log", "RESULT=PASS", "T014 verify:licenses log");
const s0Path = path.join(ROOT, "artifacts", "reports", "S0_GATE.json");
if (fs.existsSync(s0Path)) {
  const s0 = JSON.parse(fs.readFileSync(s0Path, "utf8")) as { verdict: string };
  check("S0_GATE.json verdict PASS", s0.verdict === "PASS", `verdict=${s0.verdict}`);
} else {
  failures.push("S0_GATE.json missing");
}

/* ---- 12. Delivery evidence exists ---- */
for (const rel of [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "docs/USER_GUIDE.md",
  "docs/LIMITATIONS.md",
  "docs/ALGORITHM.md",
  "docs/MODEL_CONTRACT.md",
  "01_project_book/PROJECT_BOOK.md",
  "02_implementation_plan/IMPLEMENTATION_PLAN.md",
  "artifacts/review/REVIEW_INDEX.md",
  "artifacts/review/REVIEW_PACK_01.md",
  "artifacts/review/REVIEW_PACK_02.md",
  "artifacts/release/RELEASE_MANIFEST.json",
]) {
  check(`delivery file exists: ${rel}`, fs.existsSync(path.join(ROOT, rel)));
}

/* ---- 13. SHA256SUMS.txt agrees with manifest + freeze blobs ---- */
// NOTE: the sums describe the FROZEN tree, not the current disk. After
// the handoff commit the disk legitimately differs on the handoff-changed
// files (verify-release.ts default, PROJECT_STATE.md), so a plain
// `sha256sum -c` against the disk only passes at the freeze commit
// itself. Compare each sums entry against the pinned freeze blob
// instead (durable at any HEAD), and additionally run the standard
// `sha256sum -c` inside a fresh extraction of source.zip, which is the
// copy a reviewer actually verifies.
if (fs.existsSync(SUMS_PATH) && rows.length > 0) {
  const sumsLines = fs
    .readFileSync(SUMS_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  const sumsByRepo = new Map<string, string>();
  let malformed = 0;
  for (const line of sumsLines) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m) {
      malformed++;
      continue;
    }
    sumsByRepo.set(m[2], m[1]);
  }
  check("SHA256SUMS.txt lines well-formed", malformed === 0, `${malformed} malformed`);
  let sumsMismatch = 0;
  for (const r of rows) {
    const repoPath = r.zipPath.slice(ZIP_PREFIX.length);
    if (sumsByRepo.get(repoPath) !== r.sha256) sumsMismatch++;
  }
  check(
    "SHA256SUMS.txt agrees with manifest",
    sumsMismatch === 0 && sumsByRepo.size === rows.length,
    `${sumsMismatch} mismatches, sums=${sumsByRepo.size} rows=${rows.length}`,
  );
  if (freezeCommitValid) {
    let blobMismatch = 0;
    let blobMissing = 0;
    for (const [repoPath, hash] of sumsByRepo) {
      let content: Buffer | null = null;
      try {
        content = execFileSync("git", ["show", `${freezeCommit}:${repoPath}`], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        }) as Buffer;
      } catch {
        content = null;
      }
      if (!content) blobMissing++;
      else if (createHash("sha256").update(content).digest("hex") !== hash) blobMismatch++;
    }
    check(
      "SHA256SUMS.txt agrees with pinned freeze blobs",
      blobMismatch === 0 && blobMissing === 0,
      `${blobMismatch} mismatches, ${blobMissing} missing from freeze commit`,
    );
  }
  // Standard-tool guarantee on the frozen content: extract source.zip to a
  // scratch dir and run `sha256sum -c` there.
  try {
    const extractDir = path.join(ROOT, "scripts", ".verify-tmp", "verify-sums-extract");
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    run("python3", ["-c", `import zipfile; zipfile.ZipFile(${JSON.stringify(ZIP_PATH)}).extractall(${JSON.stringify(extractDir)})`]);
    fs.copyFileSync(SUMS_PATH, path.join(extractDir, ZIP_PREFIX.replace(/\/$/, ""), "SHA256SUMS.txt"));
    run("sha256sum", ["-c", "SHA256SUMS.txt"], path.join(extractDir, ZIP_PREFIX.replace(/\/$/, "")));
    check("sha256sum -c passes on fresh extraction of source.zip", true);
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch (e) {
    check("sha256sum -c passes on fresh extraction of source.zip", false, String(e).slice(0, 200));
  }
} else {
  failures.push("SHA256SUMS.txt missing");
}

/* ---- 14. dist.zip + git bundle ---- */
check("dist.zip exists", fs.existsSync(DIST_ZIP_PATH));
let distOk = false;
if (fs.existsSync(DIST_ZIP_PATH)) {
  try {
    run("unzip", ["-t", "-q", DIST_ZIP_PATH]);
    distOk = true;
  } catch {
    distOk = false;
  }
}
check("dist.zip passes unzip -t", distOk);
if (distOk) {
  const pyList =
    "import sys, zipfile\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "print('\\n'.join(z.namelist()))\n";
  let distNames = "";
  try {
    distNames = run("python3", ["-c", pyList, DIST_ZIP_PATH]);
  } catch (e) {
    failures.push(`dist zip listing failed: ${String(e)}`);
  }
  check("dist.zip contains index.html", distNames.split("\n").some((n) => n === `${ZIP_PREFIX}index.html` || n.endsWith("/index.html")), distNames.split("\n").slice(0, 5).join(", "));
}
check("GitBundle.bundle exists", fs.existsSync(BUNDLE_PATH));
if (fs.existsSync(BUNDLE_PATH)) {
  try {
    run("git", ["bundle", "verify", BUNDLE_PATH]);
    check("git bundle verify passes", true);
  } catch {
    check("git bundle verify passes", false, "git bundle verify failed");
  }
  if (freezeCommitValid) {
    try {
      const heads = run("git", ["bundle", "list-heads", BUNDLE_PATH]);
      check(
        "bundle contains pinned freeze commit",
        heads.includes(freezeCommit),
        `heads do not include ${freezeCommit}`,
      );
    } catch {
      check("bundle contains pinned freeze commit", false, "git bundle list-heads failed");
    }
  }
}

console.log(`verify:release: ${passes.length} checks passed, ${failures.length} failed`);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:release: RESULT=PASS");
