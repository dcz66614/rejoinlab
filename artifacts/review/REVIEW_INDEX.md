# REVIEW_INDEX — P031 RejoinLab 冻结审查索引（冻结 `4cc2ded`）

冻结 commit：`4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb`（`git rev-parse HEAD` 于冻结时；冻结树 = 232 文件，`artifacts/release/` 与 `artifacts/review/` 当时为未追踪的待生成目录，不在冻结树内）。
冻结父提交：`44d59df757e92025908d1fe6d637fa175c659a15`（`44d59df`，T014 重新冻结准备：verify-release 针头 678/66、PROJECT_STATE 披露修正、src/protocol/types.ts 头注释同步 v1.0.2 §3.4；无产品改动）。
交接 commit H1：本提交（发布文件 + 具名干净冻结日志 + verify-release 默认钉住更新为冻结 hash；`git rev-parse HEAD` 于交接时即 H1）。
交接后续 H2：本提交（仅 bundle 归档与 manifest/index/pack 的 bundle 字段更新，见 bundle 说明；`git rev-parse HEAD` 于交接后续时即 H2）。
规格：PROJECT_BOOK.md v1.0.2 + IMPLEMENTATION_PLAN.md v1.0.2（Drive 文件夹 `P031-rejoinlab` id `1ql-Glo_rVUMTMMbdw98ctbdhA62eBQrG`，4 规格文件已核；FIX-R3 规格升版 v1.0.2，ADR-004；计划 spec_version 已同步 1.0.2）。

## 冻结包内容

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `artifacts/release/source.zip`（232 文件） | 5525120 | `7835e02ca0d59bc58717c44f84f669aa853dd3bd8768ff3d46cd379a1f43bd09` |
| `artifacts/release/dist.zip`（4 文件） | 123310 | `61ee70afc0a717b711c0e1504c09bba4b3d5086ccaa446d95907c41a05296df9` |
| `artifacts/release/GitBundle.bundle` | 84089757 | `2d6669a8095a71159336cedd62ee0d6b98e914a12f3c1796eff3969492670ae5` |
| `artifacts/release/SOURCE_MANIFEST.csv`（232 行 + 表头） | 28176 | `6a052d52942ffbfef1b2b4a8aa8b3db32276c6ba3ffa923a75d433c74b34cab6` |
| `artifacts/release/SHA256SUMS.txt`（232 行） | 22278 | `d49be9b82d4dfc78b9f4e70633482ff41a56c1a1b1da976e66443f3b3db07948` |
| `artifacts/release/RELEASE_MANIFEST.json` | 2115 | `18175d0eaaaa8ad5e81826810c4e709dee5b9e83673e163c92e29d59604bd413` |
| `artifacts/review/REVIEW_PACK_01.md`（168 文件） | 21362 | `5d42e71532435c67724f4851fb8a6c9b99be3a6b510e20d9c9122bc6485660a5` |
| `artifacts/review/REVIEW_PACK_02.md`（64 文件 + 3 具名日志） | 13874 | `cd94586feda72bde24ba028ac3053ebbdd827866ad521630e42066ce6914c91e` |

`source.zip` 前缀 `rejoinlab-1.0.0/`；`dist.zip` 前缀同。`SOURCE_MANIFEST.csv` 列为 `path,sha256,bytes,source`（全部 `source=git`），路径为 zip 内路径；`SHA256SUMS.txt` 为仓库相对路径标准格式。`sha256sum -c`（仓库根目录运行）仅在冻结 commit `4cc2ded` 本身检出时通过；在交接提交（H1/H2/H3）检出时实测为 228 OK / 4 FAILED，4 个失败恰为 H1/H2 改动的 `PROJECT_STATE.md`、两份 T014 日志、`scripts/verify-release.ts`，属已记录的预期差异，不是冻结内容错误。终审员真正应看的保证是 `verify:release` check 13 的钉住冻结 blob 比对（每项与冻结 commit 的 blob 哈希逐项一致）与新鲜解压 `source.zip` 后在其内运行 `sha256sum -c` 通过，二者均已通过。

## 如何复现（终审员用）

```bash
git clone <GitBundle.bundle> rejoinlab && cd rejoinlab   # 或 git clone <repo> 后 git checkout 4cc2ded
git rev-parse HEAD   # 应为 4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb
npm ci
npm run typecheck    # exit 0
npm test             # vitest 678/678 + Oracle pytest 177 + goldens 24/24 + e2e 12/12
npm run test:determinism && npm run test:performance && npm run test:offline && npm run test:privacy && npm run test:security
npm run verify:docs          # 87 checks，fail-closed：数字须与当次日志一致；必须在 verify:s0 之前跑（见下注）
npm run verify:licenses      # 22 checks
node scripts/verify-s0.mjs   # S0_GATE: verdict=PASS（24/24 parity；最慢单轨迹与最慢 Golden 数值随冷启动波动，见 README）
REJOINLAB_FREEZE_COMMIT=4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb npm run verify:release
```

注意：

- **复现顺序注意（verify:docs 与 verify:s0 的先后）**：`verify:s0` 会复写 `T012_PERFORMANCE.log` 等 T012 日志（新的冷启动实测值），而 `verify:docs` 要求 README 计时引用与当次日志逐字一致，因此 `verify:docs` 必须在 `verify:s0` 之前跑；若已跑过 `verify:s0`，须先重新同步 README 计时引用至最新日志终值再跑 `verify:docs`，否则计时类检查会 FAIL（实测：跑 s0 前 87/87 PASS，跑 s0 后直接重跑即 FAIL，如 worst Golden 61.89/G06）。这不是产品缺陷，是两门禁共享日志文件的顺序约束。

- `verify:release` 必须用环境变量钉住冻结 commit（脚本默认值为冻结前 HEAD，交接 commit 会把它更新为冻结 hash）；绝不从 HEAD 推断冻结 commit。
- 性能数字（S0 42.8 ms / G05 10.7 ms；T012 20.88 / 76.86 / 12.77 / 42.00 / 105.80 ms）是带时间戳的当次运行实测最大值，各轮有冷启动波动；复现时数值会变，只要仍 < 1,000 ms 门槛且文档与当次日志一致即为通过，不要拿旧数字当门槛。
- **冻结内日志的定点说明（P2-R2-02 流程根治的核心）**：一份由运行某提交产生的日志，若写进该提交本身，会改变该提交的哈希——因此冻结内任何日志都不可能逐字记录冻结 commit 自己的哈希。本轮采取 GPT 在 R2 中认可的补救标准：冻结内日志（S0_GATE.json gitHead、`T014_FULL_REGRESSION.log` 首行、`T012_*`、`T007_*`、`T006_ORACLE.log`、`T014_VERIFY_DOCS/verify:licenses/verify:release/threeway`）全部来自冻结父提交 `44d59df757e92025908d1fe6d637fa175c659a15`（`44d59df`）的干净 worktree 全量运行；父提交→冻结的差异仅为这些日志文件本身 + README/ALGORITHM 计时引用同步（无产品改动，`git diff 44d59df 4cc2ded --stat` 可证）。冻结 commit 本身的干净 worktree 全量重跑以具名日志形式随交接提交 H1 归档（见 REVIEW_PACK_02“具名干净冻结日志”一节）：`T014_FULL_REGRESSION_4cc2ded.log`、`S0_4cc2ded.log`、`VERIFY_RELEASE_4cc2ded.log`，其 HEAD 均为冻结 commit，verify:release 60/60。
- **Bundle 说明**：`GitBundle.bundle` 在 H1 之后创建，refs 为 main + HEAD（均指 H1）与 tag `freeze-4cc2ded`（指冻结 commit）；`git bundle verify` 通过，`git bundle list-heads` 含冻结 commit。H2 仅把 bundle 文件本身及 manifest/index/pack 中的 bundle 字段更新为该 bundle 的实测哈希/字节数——H2 是 bundle 之外的元数据后续提交，REVIEW_INDEX 在此明文披露，不声称 H2 在 bundle 内。

## 审查包分工

- `REVIEW_PACK_01.md`：源码、Oracle、测试、夹具与配置文件（168 文件，逐文件 SHA-256）。
- `REVIEW_PACK_02.md`：文档、冻结规格、证据与已知偏差（64 文件）+ 3 份具名干净冻结日志 + 交付文件（dist.zip / bundle / manifests）说明 + 截图证据说明。
- 本索引：冻结身份、全部文件哈希、复现步骤。

## 冻结前验收（T014 重新跑过）

- `npm ci` exit 0；`npm run typecheck` exit 0；`npm test` exit 0（vitest 678/678、Oracle pytest 177、goldens 24/24、e2e 12/12）
- T012 五命令全部 RESULT: PASS；`verify:s0` verdict=PASS（parity 24/24、classification 24/24、convergence 24/24、determinism 2400）
- `verify:docs` 87/87 PASS；`verify:licenses` 22/22 PASS；`verify:release` 见 `artifacts/logs/T014_VERIFY_RELEASE.log`
- 三向核对（冻结 commit 树文件 vs source.zip 内容 vs manifest）见 `artifacts/logs/T014_THREEWAY.log`：232/232 一致
- dist.zip 由冻结 commit 的干净 worktree（`npm ci` + `npm run build`）生成并经纯静态服务器独立验证
- 重大未解决 P0/P1：0 项（已知偏差与限制见 REVIEW_PACK_02 与 `docs/LIMITATIONS.md`，均为非阻塞）
