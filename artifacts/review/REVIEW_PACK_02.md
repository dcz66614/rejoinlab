# REVIEW_PACK_02 — 文档、规格与证据（冻结 `4cc2ded`）

冻结 commit：`4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb`。
源码包：`artifacts/release/source.zip`，232 个文件，5,525,120 字节，SHA-256 `7835e02ca0d59bc58717c44f84f669aa853dd3bd8768ff3d46cd379a1f43bd09`。
本包覆盖文档、冻结规格、项目状态与全部测试证据，共 64 个文件（另附 3 份具名干净冻结日志，见下）。SHA-256 与 `artifacts/release/SOURCE_MANIFEST.csv` 逐项一致。

## 交付文件（不在源码包内，随冻结包一并归档）

- `artifacts/release/dist.zip`：123,310 字节，SHA-256 `61ee70afc0a717b711c0e1504c09bba4b3d5086ccaa446d95907c41a05296df9`；由冻结 commit 的干净 worktree（`npm ci` + `npm run build`，59 个模块，Worker chunk 58.08 kB）生成；已用纯静态服务器独立验证（index.html 200、JS 200、Worker 200，标题 `RejoinLab — 续流证`）。
- `artifacts/release/GitBundle.bundle`：84,089,757 字节，SHA-256 `2d6669a8095a71159336cedd62ee0d6b98e914a12f3c1796eff3969492670ae5`；`git bundle verify` 通过，含冻结 commit `4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb`（refs/heads/main + HEAD 指 H1 `61938d9`，tag `freeze-4cc2ded` 指冻结 commit），含全部提交；
- `artifacts/release/SOURCE_MANIFEST.csv`：232 行 + 表头。
- `artifacts/release/SHA256SUMS.txt`：232 行，`sha256sum -c` 通过（仓库根目录运行）。
- `artifacts/release/RELEASE_MANIFEST.json`：冻结身份、文件哈希、测试摘要。

## 已知偏差（须终审确认，不要静默接受）

- **T010 null 路径（已规格修订）**：规格 §13.2 原写 `fullPath`/`resumePath` 为必填 PathResult 对象；实现在输入无效或事件超限（无双轨终态，`src/replay/planner.ts` 返回 null）时记 null——诚实编码（省略违 required、伪造空路径会带不符的 finalStateHash）。FIX-R1 已按 P1-R1-03 修订规格至 v1.0.1：PROJECT_BOOK §13.2 改为 `PathResult | null` + ADR-001/002，DOCX 已同步。`shortestInjectionSequence` 语义亦已在 FIX-R1（P2-R1-08）中明确：未算出时记 null，与“无注入即达成”的 `[]` 区分，Schema 与生产者已同步。见 `docs/LIMITATIONS.md` L-T010-01/L-T010-02。
- **G06 显式陈旧检查点 UI 不可达**：UI 无法传显式检查点（`client.ts` 的 recovery 对象无 checkpoint 字段），G06 原样在 UI 上不可达；T011 用等价复现（双快照 + STALE_SNAPSHOT，走同一分支 `planner.ts:979`）覆盖——产品设计边界，非 E2E 缺口。见 L-T011-01。
- **Oracle stale 打印（已修复）**：`oracle/run_goldens.py` 曾输出 `parity with production TypeScript: PENDING T007`——stale 文案；FIX-R1（P2-R1-05）已删除该过期提示。S0 门禁已独立证明 parity 24/24（`verify:s0` 重跑 PASS）。输出本身 24/24 正确。见 L-T012-02。
- **verify-docs.ts 的 S0 检查曾把数值写死**：T013 交付的脚本把 S0 的 43.9 ms / G05 11.9 ms 写成字面量断言，任何一次 S0 重跑都会失败；T014 已改为现算现核（与 T012 检查同款 fail-closed），README/ALGORITHM 同步为当次运行值（S0 42.8 / G05 10.7；T012 20.88/76.86/12.77/42.00/105.80）。此后每次 S0 或 T012 重跑都须同步更新文档数字，否则 `verify:docs` 失败——设计如此，不是缺陷。
- 其余 32 项限制见 `docs/LIMITATIONS.md`（L-T003-01–03、L-T007-01–09、L-T009-01–03、L-T010-01–04、L-T011-01–02、L-T012-01–02、L-T013-01–03、L-SPEC-01–06）。
- 规格 MINOR D-01–D-06（见 00_control/VERIFY_LOG.md §3）：D-01 施工以计划 §4.1/§4.2 为准；D-04 计划无 §7+ 收尾章节（已接受，项目书 §0/§18 覆盖）。
- **FIX-R1 遗留披露（已关闭其一）**：IMPLEMENTATION_PLAN.md spec_version 漂移已由 FIX-R2 P2-R2-01 关闭（计划 MD + DOCX 已同步 v1.0.1）；S0_REPORT.md §3 保留首次 FAIL 运行的历史记录（合法历史，非过期断言）。
- **FIX-R2 已知限制（已由 FIX-R3 闭合，见 00_control/ADR-004.md 与 FIX-R3 协调日志）**：§3.3 两处 TS/Oracle 分歧已由 FIX-R3 改行为双侧 INVALID_INPUT（RUN_FINISHED fail-open 回退分支已删；pending 推导已统一为逻辑调用分组 + 当前 run 作用域）；D-02 两处 parity 边界已有 FIX-R3 夹具覆盖（F1–F5、D-02a、D-02b，fixR3Parity 8/8）；src/oracle 头注释已同步 v1.0.2。
- **FIX-R3 已知限制（R4 披露项，见 00_control/ADR-004.md 与 FIX-R3 协调日志）**：D-02a 显式 `[]` toolCalls 仍为未修复的已知角（有意为之：改投影为键存在会动 23/24 条 Golden 的终态哈希；B 组有界断言：去键后哈希相等）；Oracle RUN_FINISHED 仍无 threadId 检查（TS 有；ADR-004 已知角，FIX-R3 范围外）。

## 截图证据

`artifacts/screenshots/` 10 张（T011 E2E 三视口 + 故障场景），全部由 FIX-R3 全量回归 e2e 重跑（12/12）重新生成：T011_HOME.png（SHA `48f4c5ccaead…`）、T011_NARROW.png（SHA `3894a28a7b27…`）。e2e 日志见 `artifacts/logs/T011_E2E.log`（T011）与 `artifacts/logs/T014_FULL_REGRESSION.log`（FIX-R3 重跑 12/12）。

## 具名干净冻结日志（交接提交 H1，不在冻结树内）

冻结 commit 本身无法在自身内部记录自己的哈希（一份由运行某提交产生的日志若写进该提交，会改变该提交的哈希——见 REVIEW_INDEX 的定点说明）。因此冻结内日志来自父提交 `44d59df757e92025908d1fe6d637fa175c659a15`（`44d59df`）的干净 worktree 全量运行（见 REVIEW_INDEX），而以下三份日志是冻结 commit 本身的干净 worktree 全量重跑产物（HEAD 即冻结 commit），随交接提交归档。它们不在冻结树内，不在 `SOURCE_MANIFEST.csv` / `SHA256SUMS.txt` 内；哈希为交接提交内文件实测值。

| 文件 | 字节 | SHA-256 | 内容 |
|---|---|---|---|
| `artifacts/logs/T014_FULL_REGRESSION_4cc2ded.log` | 13893 | `cf6cc419628d0512b6dfa12d61f0525cbee6fbe6e41567926b3a0f1465e2fe47` | 干净 worktree 全量回归（typecheck + npm test），HEAD=冻结 commit |
| `artifacts/logs/S0_4cc2ded.log` | 595 | `77b9a722d6de2027255174b54576fcacd1d7e64d2297b7936c4bf89dd6ac30ca` | 干净 worktree verify:s0 stdout + 矩阵摘要，HEAD=冻结 commit，verdict PASS |
| `artifacts/logs/VERIFY_RELEASE_4cc2ded.log` | 3153 | `bcd6c8d173c6762a6c45f793efe254261817cf18b8901045bdbefb64777623f5` | 干净 worktree verify:release（钉住冻结 commit），60/60 PASS |

## 文件清单

| `00_control/ADR-001.md` | 5490 | `d4cb1879220ab6e10c4ebdb2ef479fbea512af7fd4e67bf7e5e6e279cdb7ec7f` |
| `00_control/ADR-002.md` | 5254 | `dfb22122f3c9b273afd322ddee3bde78b886a01f2714df5f25bf4c26ea304028` |
| `00_control/ADR-003.md` | 16322 | `4129eaad7f79a6cf6c1aa1c649c036758cbb8b20cdcf20b6bebb8f8e6c4fc218` |
| `00_control/ADR-004.md` | 20165 | `179d370e6881121efdf4d38610af7e0ffdf126ea0ea25022ce0d3827788394cd` |
| `00_control/PROJECT_STATE.md` | 14299 | `3a700f3ca8f8b366f3cff9687231598096cc792b10fa7cab3dffe2b9cd4a9fd7` |
| `00_control/VERIFY_LOG.md` | 9016 | `bf430ddc816da110034ffc19dd060cb2e884119a9a2d084092ea99207bd25509` |
| `00_control/build_docx.py` | 4235 | `e4022271d6cd61db604d95cdd38ec0b40141681ae4aa700b58a4e5d1ddb1c5d0` |
| `01_project_book/PROJECT_BOOK.docx` | 58378 | `0b20a2fc610b163633abcd7b4795781b7bc28726985e0150364fd58b6b6af615` |
| `01_project_book/PROJECT_BOOK.md` | 53319 | `a7b757d108800dca25d24691929874730616664a96ddcfad0de87c4656bdf7ad` |
| `02_implementation_plan/IMPLEMENTATION_PLAN.docx` | 50106 | `752ce66cf6efb12e394fa2fcfd20339386fbfcb05a1def4bf82cb561450110d0` |
| `02_implementation_plan/IMPLEMENTATION_PLAN.md` | 33785 | `b52f4c6b511d5de3036e4ddc28b44e1247568fdf82abe2fa4145692d0fcd0562` |
| `LICENSE` | 1079 | `5834bf980e7e092f1c44759eb57bcd6520b2275960dca534809b4b40841be9de` |
| `README.md` | 13328 | `a5f45a5de6e4886dabe9b4049d41ba243a43d433c71ad0952643a6bcf99815d8` |
| `SECURITY.md` | 3593 | `62fd203bca7374761fec68cc3ee5345676705e7d311545b21abc9cebd34af4a5` |
| `THIRD_PARTY_NOTICES.md` | 14714 | `ba3c5b03a71678895c0e0c3a9575190134700a3c1214d281ab0a8e7871cbbf19` |
| `artifacts/logs/S0_fff999d.log` | 595 | `990449de41bf414bf0661bd5fa74374b99bd68add6c641543dad82c3a053bd63` |
| `artifacts/logs/T001_ENVIRONMENT.md` | 11007 | `87daeb8e168a9d7268a90100de06616908c185a892338e75c73224faadafb587` |
| `artifacts/logs/T002_PARSER.log` | 8047 | `c0cc2a64e55f60aa211e75ef5ca039fc0e6fd75953d82a4d9a638b98202da2a9` |
| `artifacts/logs/T003_REDUCER.log` | 12387 | `8013b13dd7cddad9242d2acd702007da53ae5951299bc2322a53eccbf85f5288` |
| `artifacts/logs/T004_CANON.log` | 8264 | `d88293be04ea279247c093c52b37ab40e4eccefa8e9719965d5afc8a1d7c5afb` |
| `artifacts/logs/T006_ORACLE.log` | 4066 | `b8223328102e4987be490d5537badbecb9cf985a1de211445563bda9a9dd5076` |
| `artifacts/logs/T007_ORACLE.log` | 4633 | `0f891cfc71d1b18eacc30c9b688e576757e61859b160eb74d16e769471ca5c5c` |
| `artifacts/logs/T007_PARITY.log` | 630 | `96d161cfdbe057e0241916c19caf081f33ff30e2fe56bd815539c41adc8df0f2` |
| `artifacts/logs/T007_PRODUCTION.log` | 27253 | `12626be4d5827458448cd1e25c4f170c71be0dc8f5667f36e8b4f3d708d7e483` |
| `artifacts/logs/T007_TSCONFIG_PROBE.log` | 6535 | `f4b8b6318f0deed3afb4c1ff3cd50350ca44386938394a3568a3003e33572ebf` |
| `artifacts/logs/T011_E2E.log` | 11590 | `3e78578157deba5f18edca3e1eec52b12871ec3d8717d5ca34b8218bf19b40d0` |
| `artifacts/logs/T012_DETERMINISM.log` | 3647 | `505ed962e49db043eb1b590dff2c34415dc5c114712bb00e5761f26d75e544ee` |
| `artifacts/logs/T012_OFFLINE.log` | 2280 | `ea66dc8a17cd7ff9d05f46faf99734aad4bf6a2a8e4e5eae3665e6fd0f3ce4b6` |
| `artifacts/logs/T012_OFFLINE_EXPORT.html` | 10653 | `d84c7f9636e7e07b652e2e05ad9d3d23a2502902e67fb2f3f362e45975b0fddb` |
| `artifacts/logs/T012_OFFLINE_EXPORT.json` | 3249 | `986a509133e87da6987efb5fce2a56a9e3c47cbf3b47c262cad95234045a935e` |
| `artifacts/logs/T012_PERFORMANCE.log` | 7171 | `45af54cb86b36e0509eb1a3b7816af62e4de5d5c281323bb7faafa8b3ac8ef66` |
| `artifacts/logs/T012_PRIVACY.log` | 3016 | `041f81ad6cb11894732e7fc226aba6dcb825693d17295c78520a665f6e35b00e` |
| `artifacts/logs/T012_SECURITY.log` | 4816 | `b71c784faed4693ce90ea1f2b50a54faa2ba752327052f1eb421d8c5f116ee4c` |
| `artifacts/logs/T014_FULL_REGRESSION.log` | 13383 | `4395d3abf61609966e6115d0d8962bcb1d0b79a8506731e0b2c171189f22e6ec` |
| `artifacts/logs/T014_FULL_REGRESSION_fff999d.log` | 14034 | `8fc9adb29312c6af865339f2685b9da79fb9bf9b83566154f0c6367731cc9e87` |
| `artifacts/logs/T014_THREEWAY.log` | 150 | `c22286eabb84f853c36f981e41f4b44b78a00c5386532ad470789658bd12d743` |
| `artifacts/logs/T014_VERIFY_DOCS.log` | 4557 | `2b146092ef878ac7cb4f2fc6ca5f875473dd64a7f6d7694945e964d5248bef41` |
| `artifacts/logs/T014_VERIFY_LICENSES.log` | 1676 | `a7855108bfc4ed3575db6858158012bf65376c11b07745769624c35975895899` |
| `artifacts/logs/T014_VERIFY_RELEASE.log` | 3153 | `049000e3a8b147d38bb696da35b26ba955db894cbf9c35df46123fbffb62b756` |
| `artifacts/logs/VERIFY_RELEASE_fff999d.log` | 3344 | `dc1afe64ae46818a081724bc49cc97f207c5d2b5fa201477bb11334b17d86c29` |
| `artifacts/manifests/S0_SHA256SUMS.txt` | 4262 | `140e20eccace6a9a219f5dc2e0738160bbe6e89da81624ba4d01735d92272c5e` |
| `artifacts/reports/S0_DETERMINISM.json` | 3765 | `ad82fb9da4b5b7238c0d45f88536656fc353c7a2b4dfa5feb05a13971ef5d5f0` |
| `artifacts/reports/S0_GATE.json` | 14664 | `9c6beebb0b2dfd9377249fc7cdc2056c612bb154c2c81ebadc09a6391f0f4bfd` |
| `artifacts/reports/S0_PARITY.json` | 132854 | `38a5898a93f6f45c87dc145da7c3180f5a2d4c0d3f34cfc002538f1d026d6174` |
| `artifacts/reports/S0_REPORT.md` | 16852 | `4c4526b1f691debc73e462b319f3882f53c90e80210c3d74f70cf8adae13678d` |
| `artifacts/screenshots/T011_CANCEL.png` | 368832 | `f895319c701f4b075992ada28b9cc47ee84ba59709253acf1867419e67aab1ff` |
| `artifacts/screenshots/T011_EXPORT.png` | 574598 | `adcef5734ee751daaf461ebef2048228affeb30b992c97016ad7f2d3bcdb2d07` |
| `artifacts/screenshots/T011_FAULT_DUPLICATE.png` | 691205 | `f149f5f102b66c07496b79843a0dd8ee4d325e1ab4fda6ffef2f130f61e85839` |
| `artifacts/screenshots/T011_FAULT_REORDER.png` | 717446 | `e2059980ad8fd518e09ed40e769c9e2cccc92bcd5f1a3f5c15109cbc2afb797c` |
| `artifacts/screenshots/T011_FAULT_SNAPSHOT.png` | 643249 | `5bab76e45ad20548881214e4e0c223c7d23fe22799066a4f0e051331fca0b61f` |
| `artifacts/screenshots/T011_HOME.png` | 310334 | `48f4c5ccaead1a4300fd979a2cc75e579afd6d4df167ba245b99d12a943e88ef` |
| `artifacts/screenshots/T011_JSONL_IMPORT.png` | 369046 | `0c053629a74bf8260516fdeb0ecbaee71092a5715859bdfcc2d4ff2b7aaff645` |
| `artifacts/screenshots/T011_NARROW.png` | 299064 | `3894a28a7b273aee2e4aaf61562be6137291c6dfcc8298451e7fc2ec66f96552` |
| `artifacts/screenshots/T011_NORMAL_RUN.png` | 574226 | `63d183ecf138c01f859044227f5d2fa7af0942ecb90455b7fa3e0c9adc9aa949` |
| `artifacts/screenshots/T011_SSE_IMPORT.png` | 369472 | `909ea4b0618615ac25672014b18a741cfc56c8617a67fb5767c2238bb403b0c5` |
| `docs/ADR-F01-pending-derived.md` | 22043 | `9f1e3496ef82379e09eb7e2388cbf3bd07759eada34027b75bb0adae3ddad90a` |
| `docs/AGUI_SCOPE.md` | 12185 | `ac1abc679d67bcfb41df1b7958789496e4fed3402f02ee317422b7e0db5669f9` |
| `docs/ALGORITHM.md` | 7737 | `cc75e51d08c70435c4f835d9525de3e302332acfc8a9ff5dead94534d42f3c0d` |
| `docs/DIAGNOSTIC_TEMPLATES.md` | 17062 | `090cca4772502153c5bfafb2ae80be0028f9201df4e4c284d2ce1bad11a42b98` |
| `docs/EVENT_SCHEMA.md` | 25821 | `d1967f4d15d0be66ac6907e938438d8ed97718803237c82f573582a87169b933` |
| `docs/LIMITATIONS.md` | 12333 | `c03600f16e901d1fdde03f0bd37f4c0b31c7e83a1bf254ec5ee6dbf83e36009b` |
| `docs/MODEL_CONTRACT.md` | 13854 | `f10355d279912405754e858c6c1fa2ca42e713c7d338dd5d5c49b3efebb2bed3` |
| `docs/USER_GUIDE.md` | 11031 | `38c2cfb02c2fd7353710847893f5d6f06d144e76b1a561cd386d7dad5da3c173` |
| `docs/ag-ui-1.0-schema.json` | 94359 | `4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a` |
