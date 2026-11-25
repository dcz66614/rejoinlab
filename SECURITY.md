# Security — RejoinLab (P031)

RejoinLab is a local, offline web application. There is no server component,
no user account, no credential, and no network service to attack. This file
states what the application does and does not do with untrusted input, and
what was actually verified (T012).

## What the application does not do

- **No upload.** Imported files never leave the machine. No telemetry, no
  analytics, no error reporting, no remote logging.
- **No network.** The production code makes zero network requests
  (S0 M-12: `src/` scan for `fetch(`/`XMLHttpRequest`/`WebSocket`/
  `node:http(s)`/`node:net` found 0 call points; T012 offline verification
  with all non-`127.0.0.1:4173` requests blocked: 0 external requests,
  0 blocked attempts, 0 errors). `npm ci` downloads from the npm registry
  at install time — that is environment setup, not product runtime.
- **No persistence.** Nothing is written to `localStorage`, `IndexedDB`,
  cookies, or disk by the application (T012 privacy verification: 0 writes,
  0 opens). All state lives in memory; "清空" (Clear) wipes the in-memory
  events, states, and export references.
- **No code execution from input.** Imported events are parsed as JSON/SSE
  only. `rawEvent` is never executed, tool calls are never executed, and
  URLs or code inside event content are never fetched or evaluated.
- **No HTML injection.** All user text in the HTML report is escaped
  (T012 security verification: `<script>`, `<img onerror>`, `<svg onload>`
  payloads appear only as escaped text; no `script`/`img`/`svg` elements,
  no `on*` attributes, no `javascript:` URLs; two renders byte-identical).
  Static scan of 33 files: 0 hits for `innerHTML` / `dangerouslySetInnerHTML`
  / `eval(` / `new Function` / `document.write` / `localStorage` /
  `sessionStorage` / `indexedDB` / `fetch(` / `XMLHttpRequest` / `WebSocket`.

## Input limits (fail-closed)

| Limit | Value | Over the limit |
|---|---|---|
| Input file size | 1 MiB | rejected |
| Single event size | 64 KiB | rejected |
| Events per trace | 40 | 41st event → `INCONCLUSIVE_LIMIT` |
| BFS search nodes | 5,000 | `INCONCLUSIVE_LIMIT` (`limitExceeded`) |
| Single-trace time | 1,000 ms | `INCONCLUSIVE_LIMIT` |
| JSON nesting depth | 10,000 layers → `ParseError`, process survives | rejected, no crash |
| JSON Patch (STATE_DELTA) | RFC 6902, applied in order; unknown op discarded, unapplicable patch → `SNAPSHOT_MISMATCH` | never silently applied |

Unsupported event types (STEP_*, REASONING_*, ACTIVITY_*, SUBAGENT_*, RAW,
CUSTOM, unlisted drafts) are reported as `INCONCLUSIVE_LIMIT` or
`INVALID_INPUT` with position and type — never silently dropped.

## Worker

Analysis runs in a Web Worker. The worker can be cancelled; a cancelled job
produces no `RESULT`, and a stale job's result never overwrites a newer
input's analysis. The in-process fallback import of the replay engine in
the main bundle is dead code at runtime (see `docs/LIMITATIONS.md`
L-T009-01).

## Dependencies

Dependencies are pinned in `package-lock.json` and listed with licenses in
`THIRD_PARTY_NOTICES.md` (137 packages, no copyleft). No separate
vulnerability audit (e.g. `npm audit`) was run as part of T013; run one
before any public release and record the result here.

## Reporting a security issue

There is no deployed service and no bug-bounty program. If you find a
security issue in the input handling, report it through the project
repository's issue tracker with a minimal reproducing input file (JSONL or
SSE). Do not include real user data or credentials in the report.
