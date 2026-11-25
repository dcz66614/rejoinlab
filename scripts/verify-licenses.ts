/**
 * P031-T013 verify:licenses — licence assertions for RejoinLab.
 *
 * Checks (all must pass; any failure exits 1):
 *  1. LICENSE contains the MIT licence text and the RejoinLab copyright line.
 *  2. Every direct dependency named in package.json appears in the
 *     "All packages" table of THIRD_PARTY_NOTICES.md with the installed
 *     version (read from that package's own package.json — never guessed).
 *  3. The "All packages" table has exactly one row per installed package
 *     in node_modules/ (count computed at runtime), and every row's version
 *     AND license match that package's own package.json.
 *  4. No package has a missing license; no copyleft license (GPL / LGPL /
 *     AGPL / MPL) is present.
 *
 * This script is a deterministic text/parse check. It does not re-audit
 * license texts (spot-checked by T013 against the LICENSE files shipped
 * inside the packages); re-run the enumeration after any dependency change.
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

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const licenseText = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
const notices = fs.readFileSync(
  path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);

// 1. LICENSE is the MIT text with the RejoinLab copyright line.
check(
  'LICENSE contains "MIT License"',
  licenseText.includes("MIT License"),
  "LICENSE is missing the MIT License heading",
);
check(
  'LICENSE contains "Permission is hereby granted, free of charge"',
  licenseText.includes("Permission is hereby granted, free of charge"),
  "LICENSE is missing the MIT grant clause",
);
check(
  'LICENSE contains "Copyright (c) 2026 RejoinLab Contributors"',
  licenseText.includes("Copyright (c) 2026 RejoinLab Contributors"),
  "LICENSE is missing the RejoinLab copyright line",
);

// Parse the "## All packages" table only: "| name | version | license | scope | use |".
const allSection = notices.split("## All packages")[1] ?? "";
const rowRe = /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm;
const recorded = new Map<string, { version: string; license: string }>();
for (const m of allSection.matchAll(rowRe)) {
  const name = m[1].trim();
  if (name === "Package") continue;
  recorded.set(name, { version: m[2].trim(), license: m[3].trim() });
}

// 2 + 3. Installed tree enumeration (ground truth from disk).
function installedPackages(): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(ROOT, "node_modules")).sort()) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(ROOT, "node_modules", name)).sort()) {
        out.push(`${name}/${sub}`);
      }
    } else {
      out.push(name);
    }
  }
  return out.filter((n) =>
    fs.existsSync(path.join(ROOT, "node_modules", n, "package.json")),
  );
}
const installed = installedPackages();
check(
  `THIRD_PARTY_NOTICES.md "All packages" table has ${installed.length} rows (one per installed package)`,
  recorded.size === installed.length,
  `table rows=${recorded.size}, installed=${installed.length}`,
);

const COPYLEFT = ["GPL", "LGPL", "AGPL", "MPL"];
let licenseMismatches = 0;
let versionMismatches = 0;
let missingLicenses = 0;
let copyleftFound: string[] = [];
for (const name of installed) {
  const installedPkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8"),
  ) as { version: string; license?: string | { type?: string } };
  const rec = recorded.get(name);
  if (!rec) {
    failures.push(`THIRD_PARTY_NOTICES.md is missing "${name}"`);
    continue;
  }
  const lic =
    typeof installedPkg.license === "string"
      ? installedPkg.license
      : (installedPkg.license?.type ?? "MISSING");
  if (lic === "MISSING") missingLicenses++;
  if (rec.license !== lic) {
    licenseMismatches++;
    failures.push(`"${name}" recorded license "${rec.license}" != installed "${lic}"`);
  }
  if (rec.version !== installedPkg.version) {
    versionMismatches++;
    failures.push(
      `"${name}" recorded version "${rec.version}" != installed "${installedPkg.version}"`,
    );
  }
  if (COPYLEFT.some((c) => lic.includes(c))) copyleftFound.push(`${name} (${lic})`);
}
check("every installed package has a license field", missingLicenses === 0, `${missingLicenses} missing`);
check("no recorded license mismatches", licenseMismatches === 0, `${licenseMismatches} mismatched`);
check("no recorded version mismatches", versionMismatches === 0, `${versionMismatches} mismatched`);
check("no copyleft license present", copyleftFound.length === 0, copyleftFound.join(", "));
if (licenseMismatches === 0 && versionMismatches === 0) {
  passes.push(`all ${installed.length} recorded rows match installed version + license`);
}

// Direct dependencies explicitly.
const directDeps: string[] = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];
check(
  "package.json has direct dependencies to check",
  directDeps.length > 0,
  "no dependencies or devDependencies in package.json",
);
for (const dep of directDeps.sort()) {
  check(
    `THIRD_PARTY_NOTICES.md lists direct dependency "${dep}"`,
    recorded.has(dep),
    `"${dep}" is missing from the "All packages" table`,
  );
}

console.log(
  `verify:licenses: ${passes.length} checks passed, ${failures.length} failed`,
);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:licenses: RESULT=PASS");
