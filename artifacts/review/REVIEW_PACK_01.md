# REVIEW_PACK_01 — 源码、测试与配置（冻结 `4cc2ded`）

冻结 commit：`4cc2dedb9312f9d86d8a9e68c0f0716b63cb3dcb`（`git rev-parse HEAD` 于冻结时；冻结树 = 232 文件，`artifacts/release/` 与 `artifacts/review/` 当时为未追踪的待生成目录，不在冻结树内）。
源码包：`artifacts/release/source.zip`，232 个文件，5,525,120 字节，SHA-256 `7835e02ca0d59bc58717c44f84f669aa853dd3bd8768ff3d46cd379a1f43bd09`。
本包覆盖源码、Oracle、测试、夹具与配置文件，共 168 个文件。SHA-256 与 `artifacts/release/SOURCE_MANIFEST.csv` 逐项一致；与冻结 commit 的 blob 内容逐项核对（`git show <freeze>:<path>` 取内容再算 SHA-256，见 `npm run verify:release` 检查 5）。

## 验收证据（T014 重新跑过，全部 PASS）

- `npm ci` exit 0（138 个包，与 lockfile 一致）
- `npm run typecheck` exit 0（0 错误）
- `npm test` exit 0：vitest 34 文件 678/678；Oracle pytest 177 passed；`oracle/run_goldens` 24/24 PASS；Playwright e2e 12/12
- `npm run test:determinism` RESULT: PASS（300 次 0 失败）
- `npm run test:performance` RESULT: PASS（40 事件 evaluate 最大 20.88 ms、analyze 最大 76.86 ms；最慢 Golden G01 12.77 ms；BFS 最多 8；41 事件 10/10 INCONCLUSIVE_LIMIT；Worker 计算最大 42.00 ms、往返最大 105.80 ms）
- `npm run test:offline` / `test:privacy` / `test:security` 全部 RESULT: PASS
- `node scripts/verify-s0.mjs` S0_GATE: verdict=PASS（parity 24/24、classification 24/24、convergence 24/24、determinism 2400 次；最慢单轨迹 42.8 ms；最慢 Golden G05 10.7 ms）
- `npm run verify:docs` 87 checks passed, 0 failed，RESULT=PASS
- `npm run verify:licenses` 22 checks passed, 0 failed，RESULT=PASS（137 个包 100% 覆盖，0 copyleft）
- `npm run verify:release` 见 `artifacts/logs/T014_VERIFY_RELEASE.log`（冻结前以 `REJOINLAB_FREEZE_COMMIT=44d59df…`（父提交）运行，60/60 PASS；冻结 commit 本身的干净 worktree 重跑以 `REJOINLAB_FREEZE_COMMIT=4cc2ded…` 运行，同样 60/60 PASS，具名日志随交接 commit 归档，见 REVIEW_INDEX）

## 性能数字口径

各轮实测存在冷启动波动。README / ALGORITHM 引用的是带时间戳的当次运行实测最大值（T012：2026-11-24T01:47:11.439Z 运行；S0：2026-11-24T01:47:42.241Z 生成），与当次磁盘日志逐值核对（`npm run verify:docs` 现算现核，fail-closed）。不要引用施工者早期汇报数、复核重跑数（20.38/60.71/71.00/321.00，只存在于复核报告中）或已被覆盖的早期运行数（29.94/76.17/26.60/49.00/101.30、12.91）。

## 文件清单

| `.gitignore` | 413 | `13614699a6a381cddb1f9625484aed7f9070e7e2c7fa471b74f9be5d583cd6c4` |
| `fixtures/golden/G01.json` | 2314 | `b51db61ea2ae401e86bd9b9622db676e8ac71dda2e6b3af187b5bf9c33786f28` |
| `fixtures/golden/G02.json` | 3751 | `59bd12273ba5515e454ecd69cd64298e8bb2724754e5171b7780c43feaffbe90` |
| `fixtures/golden/G03.json` | 4367 | `1c7e67d8cbddbdafa8a38c1e2042ae67b262e489e91a3cb827773ff570009dec` |
| `fixtures/golden/G04.json` | 1656 | `8abd8a6b6420c498bb25aac75b116e9032205667b83bcaa1b1d3c4c274113c5e` |
| `fixtures/golden/G05.json` | 2543 | `3871569653046f14014f069c49c315f9b675d01474855c791528fa46abed9c07` |
| `fixtures/golden/G06.json` | 2689 | `2a78b553c2232505f8b57fd5b7f430b8b60baaeecd7a04b0d4c4b40879146d78` |
| `fixtures/golden/G07.json` | 1448 | `699fc288985b31f5a3006adfa2bf890240ede932f503d558d23b7c1482226898` |
| `fixtures/golden/G08.json` | 1520 | `553be88a2726e2f9810d32c16c6b0ddf269b850a987cdc8ed1c90c85e8b0d4dc` |
| `fixtures/golden/N01.json` | 1350 | `eaa30a95cdc38e78f98273c6741b57911702b015c2044a301d3b34c0795b3590` |
| `fixtures/golden/N02.json` | 1799 | `472debeb1d985f585cf00f0f4e6d127edaab5c3476c8a850979dfcfaf7ba0e47` |
| `fixtures/golden/N03.json` | 2273 | `b2b1d14a9093f80faee2c745b15d1eb3384a2345d7cc263ae0652b448eaaf770` |
| `fixtures/golden/N04.json` | 3057 | `fa4d44109cc1c935eac8af750249a6a47d45365450fa2faeb9d79ed72352936a` |
| `fixtures/golden/N05.json` | 1606 | `47a19fb7cb29352ae7000a74a5b1f36c78dbe3b16034f5b465d3d44b11ab635c` |
| `fixtures/golden/N06.json` | 1699 | `1c59ff0e549ae2a674179a1968ff1e6770bd270a7b9094f89969eec786d286a0` |
| `fixtures/golden/N07.json` | 1801 | `a55bc6e1aa169747fc382d428568ca01471a63811b1e8e05603fe0793ef92eac` |
| `fixtures/golden/N08.json` | 1970 | `9bcfa45924ba50efdf91b43efb610d652d18474487249c13c99b1e807242667d` |
| `fixtures/golden/N09.json` | 3198 | `0caea36cc46eefbaa9c17890f3e41cecee33cbc197c4a7e6e789992b119cecfa` |
| `fixtures/golden/N10.json` | 2388 | `001b5077e183f128c036c934f4b4e72164b36c7aa6725a92c4746108fd218f44` |
| `fixtures/golden/N11.json` | 1592 | `edc5c5e827765f8c78c11799f5f17ffd2e21ff4c01274fcba0d5ca56ccc6694a` |
| `fixtures/golden/N12.json` | 1632 | `dfe00de890c1a728414c10a88d938ad166e12d324307acd1923c620658a88e6a` |
| `fixtures/golden/N13.json` | 1502 | `e3388d5ea9d49f47f225659b90aefd69d1a83fb4b3ee2ed0bac6fd1a2c8ff184` |
| `fixtures/golden/N14.json` | 1995 | `e75e5341b01f3d2dadcdb19604d7718d0fc4fa021a4abd1b6374ace5fdf8f926` |
| `fixtures/golden/N15.json` | 2906 | `f2875c5a81b401fa430c8891e06fdbbb36731026cb9a48119bc0b98a6a207e1f` |
| `fixtures/golden/N16.json` | 1739 | `186adbff1d4282d88bf174b34fe1adc1dc1e114da617718d86d0fbf6a91d24a0` |
| `index.html` | 313 | `610c4a2b9af1b86fa5058c88d6be0a169afb8674bba36f5f0a061878ca1c08cd` |
| `oracle/README.md` | 5972 | `a81cb534614ea041f8afa97bbc0937ed136dde7fa037cbf56ef933f492c1eaad` |
| `oracle/__init__.py` | 337 | `f9584a648d9828e82efda98c51ca398022fdba9e6017ba342509d1a4303a229a` |
| `oracle/canonical.py` | 8952 | `eac11dafbc6bd8ee85c7a8c77bf2f36409a05d2e966b3abc12577fe0df8f58d1` |
| `oracle/diff.py` | 9280 | `6e91998fc6bb90472183bc892f54b574cdf9aca17fc73fc837578a4fbf13b56c` |
| `oracle/generate_goldens.py` | 21854 | `a11b8a9103eafb0e39611546ca5ca77a2545650500172416301a76d447158242` |
| `oracle/golden_expected.json` | 16467 | `effa771887bf08d59857ca0c41f5f838e180b2fd7c9c9fe9a456a1db2c2cb8bd` |
| `oracle/parity.py` | 14652 | `77c87276f84eb2c45a169c57b3414f4efd3c9c9b3ac4bba26be8215acf4c440d` |
| `oracle/reference.py` | 93445 | `7a2f71be68669346464030d5ccdff8222cda1b32f520e8a3d4ca6c12a49b7fd2` |
| `oracle/replay.py` | 48213 | `224edadcadad43063fb2238450e089236d35509923b6ccfc52b278265d50bfd9` |
| `oracle/run_goldens.py` | 5970 | `4435d4e9eff700bf74800560b1e6e5ec651ef2e7f627b9d65f8ff9d21026c012` |
| `oracle/tests/__init__.py` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `oracle/tests/conftest.py` | 299 | `56f798e6003c8f64afea1ac4cc0f472bd895624b2513f984514f0acb39f1b4ef` |
| `oracle/tests/fixtures/fixr3_chunk_index.json` | 1597 | `f58aab9591202b1f5b6b2e2d6c35a3461bbadb1e453f651e9f6e300748a3d7de` |
| `oracle/tests/fixtures/fixr3_empty_toolcalls.json` | 1404 | `e8da7332104b71c06c5b69f3f78e19cf7c34b24ade5264d6c849302f0dfdf167` |
| `oracle/tests/fixtures/fixr3_finish_without_start.json` | 515 | `1a36bd06b0b691f40f30a493abc5403a0c2b4ad0c852bf0636f979872a0438c8` |
| `oracle/tests/fixtures/fixr3_finish_wrong_run.json` | 691 | `492a6b2dc3871e1e4a4ec7bb43516f0faa12bd5ab1e3683114aa385db60819db` |
| `oracle/tests/fixtures/fixr3_pending_cross_run.json` | 2402 | `bfc8ea9c311ba5eb3b97d64a6f7d94e6a667091f2679aad52f4af147fc61cf13` |
| `oracle/tests/fixtures/fixr3_pending_grouped.json` | 1741 | `3d911d4e2fb462e69f69122b4c52331ba24d3b7b0aca824a374232054ebc587f` |
| `oracle/tests/fixtures/fixr3_pending_grouped_declared.json` | 1735 | `75d732d55361bb0c1d461338d0385faa68b2eb6e8d281019e4cb1cd7d2448632` |
| `oracle/tests/fixtures/fixr3_pending_mismatch.json` | 1406 | `9de61bae3187c97850b64e1e7e41dadf21b8cc216a320cb594e537376d11b15b` |
| `oracle/tests/fixtures/input_empty.json` | 1312 | `0480cd880b50ebea1c40fbb6644b1eb6e6102158fd529141ee3748226ac6b1de` |
| `oracle/tests/fixtures/input_illegal_bad_role.json` | 1391 | `8dce212c89f2e8a8a45f018159e6ff590e96f0336b87f15b22f49790e5855855` |
| `oracle/tests/fixtures/input_illegal_message_no_id.json` | 1368 | `16168916acabf56437c0342face10eb72acd96fbc17fa872ebc42c10a872f4c3` |
| `oracle/tests/fixtures/input_illegal_messages_missing.json` | 1293 | `4ad9fa3aec52e51cc8e9e5619e0557cdebcec7b12b31dcee3f2dbc937ff08ee0` |
| `oracle/tests/fixtures/input_illegal_messages_not_array.json` | 1325 | `a497d70e8b135bb7c77552eb631caa6524fe67dbebd839309d2b235489a5b165` |
| `oracle/tests/fixtures/input_illegal_not_object.json` | 1244 | `97d26a3c85dc9f64ec443c3295849103dca8d7d922ad36e4b0298c3555819a75` |
| `oracle/tests/fixtures/input_messages.json` | 1829 | `c78375f0dc2d998e1f23a8d73225d318d678239893fbd4a265a59103c8eec738` |
| `oracle/tests/fixtures/input_no_input.json` | 1199 | `39a187d5e668fa2b4e10c26b485b0c345fc1450b7d61333c1b33fd0c4085e944` |
| `oracle/tests/fixtures/input_replay_no_reseed.json` | 1593 | `9aa88613463728d664a8678af6c2588910b0429f85a2b51c58831876a2f37908` |
| `oracle/tests/fixtures/input_run_mismatch.json` | 2478 | `b8c70cda6a93b94c357fe1d42b8c3f18834243473117c7febb20e3759f02c69a` |
| `oracle/tests/fixtures/input_stale_state.json` | 2378 | `8e56607c7a4a7ed0d035d3402b94bc2c4ee2e472858cba5e28936a3ee2e78749` |
| `oracle/tests/fixtures/input_state.json` | 1372 | `54a19380d5cbdf00e3a7ce6d04fe7dd9532f94cb97c6e1f1746b3fb307ab7366` |
| `oracle/tests/fixtures/input_thread_mismatch.json` | 2484 | `9dbeb12f34bc085171405e552085e61d015dfb223a0e399150e27ed3068952e1` |
| `oracle/tests/fixtures/input_tool_no_content.json` | 2738 | `dafd76ca8a0ac298666fde5fc557ada24f1d8752bce8e2867ecf5b38a14022f8` |
| `oracle/tests/fixtures/input_tool_result.json` | 3960 | `3b3d4591ad4866de31da757a1d17d1a2834cb3b2cda3fece4d51093a5ee9a9bd` |
| `oracle/tests/fixtures/parity_error_code.json` | 987 | `ef2d71351668ab3a5d4334dab953898e60cbf74853282f1702d1888599a2bb12` |
| `oracle/tests/fixtures/parity_outcome.json` | 1445 | `d85681935cde1a7e5c77908ef68939ab684609855c4501ddc223bd3666059f14` |
| `oracle/tests/fixtures/parity_parent_run.json` | 1505 | `c39f84a718bce605b25fb47357f2de73fff04a6d8473e3acb0426148489311a4` |
| `oracle/tests/fixtures/parity_protocol_version.json` | 1008 | `8d35287d33ba19c2c2f542688e951a4f3f5a47dcd451f6ac5a2ddee07360238d` |
| `oracle/tests/fixtures/parity_result.json` | 992 | `74d2c3baee9900a34d8a40f04661ab899c3ea10b24f06e4afcc0a396a615ef7b` |
| `oracle/tests/fixtures/parity_result_null.json` | 994 | `a320b3596d8339b14caf093c2af4faf228bc210b8109c35461e0d4cdf89c3b56` |
| `oracle/tests/test_canonical.py` | 4767 | `cc34def582b923a2a1eddd973b9008a0704444aa104fdd965b90a95146fa43a4` |
| `oracle/tests/test_golden.py` | 4452 | `19d7cc3e7427a5fa5a515eca64a29d022d73a2f695ad8e346a8131a6310cb59d` |
| `oracle/tests/test_parity_fix_r2.py` | 8882 | `344e065d8e87c78a969055ea3ee2bafbc250a3d5d385bd8edd5ba22bfa2752a7` |
| `oracle/tests/test_reducer.py` | 12189 | `21cbb1cf0ed83fc2948849fb0413eacc7f2de6ea10eafd2a05161a47aef9fb16` |
| `oracle/tests/test_replay.py` | 9143 | `b882dfc944d0d9fc3efdfeaf1b4d67c4b3dda2d232a44a9d4690016928f9f78d` |
| `oracle/tests/test_run_started_input.py` | 24218 | `ecc11b83ab9381db03f32a93a109f52176a5f091ab09a74a57044ad00bf60629` |
| `package-lock.json` | 93851 | `cc26bf21cd6bf87f5788bb44f1f5b762c14634ac14ee2fd03e90be7424ad910c` |
| `package.json` | 3475 | `e4a87f5fd924f5b10462c44f32a53c317c1a00713545184b4aabe9e09e4068dd` |
| `playwright.config.ts` | 969 | `740f56048d831de4c600a317d9cf35978f35a086e113d304164842a7281ddee4` |
| `scripts/oracle-expand-chunks.py` | 1429 | `f3d25a1f370944cd370b9148ebd90cd20a9478cb6e4ab9357f20f33600ee24ca` |
| `scripts/oracle-parity.py` | 10043 | `d24bc1ddf17b464cc68dece7a1c6ebe7ca0e3ef7a2173a74d3202b4dfe2942c1` |
| `scripts/verify-docs.ts` | 11146 | `f082b954bb7e70e02b3ef850bd85c4d9ac5351db74ef9124ec63cca08ccc01e4` |
| `scripts/verify-licenses.ts` | 6398 | `9edd6c0b1bb712dc6e2ed54c5e879efa7e0c20b7bb8b6d8ce8609f48e1ae8e22` |
| `scripts/verify-release.ts` | 22631 | `684cc68dd5d6b8c6a7f653f88d3bfd66805786b6dee1823dbb3bb8b6403dde2d` |
| `scripts/verify-s0.mjs` | 47253 | `c981880134294dee07b826eb7400dffa2b9e68d235fd2f7823aa8c3308e91714` |
| `scripts/verify_determinism.ts` | 5981 | `5cca73608bb2ec48ce2f52e6ad187135bc8a541c0c8422c5ff457f3416098814` |
| `scripts/verify_offline.ts` | 10951 | `76d606751676fe8867a29ff14914457e96ce90e93604b6712b3b7385b6f4eb9b` |
| `scripts/verify_performance.ts` | 13826 | `1eec6269bf01b20a5583c6818da9636e5a632feef80ea35b9d85a751843b9652` |
| `scripts/verify_privacy.ts` | 14709 | `cc80ffb9c7bdf32d35c8b4b124f0959699f42dfb5d72b3aae42ce592e01a997c` |
| `scripts/verify_security.ts` | 17906 | `0427fbdf33315c42cce81be2e4b310858e15fb64a2ed640136d6ac6bfb3eeda1` |
| `src/core/canonical.ts` | 17277 | `d1a1c400b2c8262504b36f3d170c0c30ce499b7986544d666fdf8a59d06be936` |
| `src/core/diff.ts` | 12858 | `def1fd325be18eda7df92e833d5c5b26a270c92de144b8036af686480084c10f` |
| `src/core/lifecycle.ts` | 27635 | `eaddd9a5d632d16a5887451585e73ef5ae4fd24d29ba8c1346d371619ccf1cf8` |
| `src/core/reducer.ts` | 17987 | `3f3ec3b00968238081207083599505b63f9efe8edcadf9591541ec14fd54ea97` |
| `src/core/snapshot.ts` | 23353 | `37f5f4e07af23f89dfb7b3884215c2e13da4f7c64c71e0b553949f9b13084ddc` |
| `src/core/state.ts` | 19032 | `57b48242987b9ed2019316d86430142e4c862c2651aa66271fe6721625ae3870` |
| `src/main.tsx` | 379 | `0b098a6a2f8894429f9248b5570a3ff2da25ea93fd946eeff8ee60558e77b1cf` |
| `src/parser/index.ts` | 1342 | `1594f777480c471a84977231c5593d550596f8a4e7c6aeba8e0f4a8f4e471244` |
| `src/parser/jsonl.ts` | 2588 | `736aa2c474ba71bee57652a7304ff6cdab5a07ab286523931f287f24803900a0` |
| `src/parser/normalize.ts` | 49400 | `aaab9bc0ef9a70623a4c01a3a09f79e10f0dab89ecb82f3818dab904b9851c24` |
| `src/parser/sse.ts` | 4823 | `b454fee481367e7e2ff6476bda70ce45e318b25ae67edead1e34f2b54ae7ca4e` |
| `src/protocol/types.ts` | 13842 | `9a5cf55ac730a1702890c699c194fa0a0c5f1840a401361fd8e3a6bd9c5bd124` |
| `src/replay/align.ts` | 3945 | `25dabcb67c842292ebb9f15ab95a053317ef0cceefdd611709a01f30c19067b9` |
| `src/replay/inject.ts` | 12005 | `58fa4e6d0c962ff4cf7a7b24932bc3c97c2927699828997fe028348962e52d2b` |
| `src/replay/planner.ts` | 47735 | `840cba77d2fe46b95d514f444a22b11881b514eb6cc057fc5de91c8eddcebee7` |
| `src/replay/search.ts` | 12430 | `a1d7889cb455782756b7a0b0f94f5b12992cbd7150b4564f7777ab67b7a18700` |
| `src/report/html.ts` | 16349 | `1d6c97f8bebcf6c389fa72dc6df19fbf7e5077cfbfe08fa2c9d52e0eee413054` |
| `src/report/json.ts` | 12678 | `4f1cba9e0b651d06f61b6ee51a76236590dcc02da7dad23fa9493c323689620b` |
| `src/report/schema.ts` | 28165 | `3076f2c1d1dd9f0af20ffba8562504a73b50ad70cebc33b200f80b01558cc71c` |
| `src/ui/App.tsx` | 12031 | `03f996cd3dd24c2f03658b4dc1f2cb6d6a68832d55ce24e070983691925af9ae` |
| `src/ui/Diagnostics.tsx` | 2665 | `e29946066d3eb066bb59de2260dbeed2bc4cc4a2b557bc9afd030638b2438442` |
| `src/ui/ExportPanel.tsx` | 2570 | `c39a2358cf72fb8c6925c6c4d58ba72abf50d1cc5ce5cac2fb7d37b85e8d3493` |
| `src/ui/ImportPanel.tsx` | 6856 | `64a5907e7a8b7a754e4b827def4e062e3b6cc0970d126852a07f4bfddecd2c69` |
| `src/ui/ScenarioPanel.tsx` | 9359 | `00991935de16c61d0eeac26076cee664215c835b7bad205897e4515a015af6cc` |
| `src/ui/StateDiff.tsx` | 6991 | `6d2f784cd91fca6aad6ca3458f0ba5549a5eb654750a8868c250327e007455c9` |
| `src/ui/Timeline.tsx` | 14448 | `8cf35d5c375bc823104f7a7fe7eb04da55a562b9dd99422c78bf3954c6b9bd99` |
| `src/ui/TimelineEvent.tsx` | 4982 | `fdd7e7f13a9cbe9949b3ae69bd8b05fd9fbca722d80294f845908cb1ca59c757` |
| `src/ui/analyze.ts` | 10750 | `e77761f4983ba449488019c089c8f87c79f91329ec8322ddadb8a18434b07689` |
| `src/ui/styles.css` | 6630 | `88b9ec5130b082602837e96c8f18e86bd2729caada7c764af33a780bb5a72f51` |
| `src/ui/timeline.css` | 3196 | `10393e61754d46064c51557ef045a6cb10b28a117cf2e37d4952e8b8d1f722b0` |
| `src/worker/client.ts` | 8637 | `8242660f26332dc8ca592265276598dbefc98ca25d455d15bd5fe3b587117f12` |
| `src/worker/protocol.ts` | 9834 | `7fedeff5d85b5ebf2530e6fe81308a40b5de5f0cfedc8a5fc6f36501f09abb7c` |
| `src/worker/rejoin.worker.ts` | 15345 | `bbc2ac37813e0aeab454c2cb90cee22a2c2d0e9141d2d6339aee2f0110a9e63e` |
| `tests/core/canonical/canonical.test.ts` | 15490 | `f6555eb91e25a09b29583b1953a475e0edf3c68e8d2c5e056296b657f5a78196` |
| `tests/core/canonical/oracle-parity.test.ts` | 10197 | `7fe23538f97d5f523d7cf508bcf0a008a496c127da07cd84003d1cf6f6ae4161` |
| `tests/core/determinism/determinism.test.ts` | 4357 | `92fb8bb74597a9913c6a052deff901ae77bf961f169f9a0fb6fa0db3dc3510ca` |
| `tests/core/diff/diff.test.ts` | 16032 | `bdd331876ce5a94ca48da99abd01aee6078b0fdcd041633d2a2c1777f5250be9` |
| `tests/core/helpers.ts` | 2335 | `74521e2b5cbca29fbdefb7571734b5119766789ede320c573ca17be2095eed22` |
| `tests/core/reducer.test.ts` | 17806 | `e5a605bf79af8203f02e247b93404629b683d08a61266edb7ab74f88978a5178` |
| `tests/core/snapshot.test.ts` | 22673 | `24ee21488b1c5e20b31710092fdf392eb8948fd8bcea6f05e412005f10f7ac4d` |
| `tests/e2e/fixtures/g01.jsonl` | 652 | `bec3e4527e4ca46134bd650186048998a4934747060fe914e65971c618e84131` |
| `tests/e2e/fixtures/normal.jsonl` | 896 | `2c0c64739b43982fe9b5693b2c987e9e15ddabbfdb7a9e0db7bc8eee3e99b3a2` |
| `tests/e2e/fixtures/normal.sse` | 941 | `01b55d6347c6fdca6cfcb33f17ab9d4a93832e2f73e974cafcd287b712bf134d` |
| `tests/e2e/fixtures/two-snapshot.jsonl` | 624 | `a8694ea581166ac133c6a5dbd3d28b8ea31842e0a6effa83f516bacd56e5ad8b` |
| `tests/e2e/rejoinlab.spec.ts` | 24208 | `b835519e8484cbf79e66101b47505d19a3d23b1f25efff7457d9173e0ba2f122` |
| `tests/parser/determinism.test.ts` | 2818 | `3f195e975691931a93117603271157d81bd36d43bba2ee99cd83c68dac019870` |
| `tests/parser/fixtures/chunks.jsonl` | 481 | `e13a3eaf66d9517f5c58afd8063409f09892e1d876f15a7a3417ffc903b38d41` |
| `tests/parser/fixtures/multiline-data.sse` | 286 | `9520ea9a37734bad66bf99aad0373a01b91460b495fab42507cd6e7a8bfb19d5` |
| `tests/parser/fixtures/normal.jsonl` | 896 | `2c0c64739b43982fe9b5693b2c987e9e15ddabbfdb7a9e0db7bc8eee3e99b3a2` |
| `tests/parser/fixtures/normal.sse` | 941 | `01b55d6347c6fdca6cfcb33f17ab9d4a93832e2f73e974cafcd287b712bf134d` |
| `tests/parser/jsonl.test.ts` | 11634 | `446e584f172d10b8d32da9a2218eb7aabf24f2603421512e876b9781035ff1bc` |
| `tests/parser/normalize.test.ts` | 22792 | `729a376d2dc5b227e045491240dd0a3a445f846c0da4d831de90c058be0edee6` |
| `tests/parser/sse.test.ts` | 7109 | `1033a7cef07bea41393dd381acfca5c79f69502a235b4ae68470ff942ca1180d` |
| `tests/replay/determinism.test.ts` | 3868 | `64a7c926a085c3b113ed9b0ec316973e139ff34cbdd9e17b81f845bbb23c6dc7` |
| `tests/replay/duplicate-result.test.ts` | 6508 | `e44be83255f1269e923597bbe7a49e82d44678973b26798bb2f228c5aaf2d65f` |
| `tests/replay/edge-t003.test.ts` | 3162 | `b11e8fdabf509950e258fcbd19226de5f8efaa4844de668cf6a3e19bdb6dfd47` |
| `tests/replay/golden-helpers.ts` | 9711 | `743fa67c1ee982d8313d9d993e66334e5431105d9a8dd100a612e0c507a83608` |
| `tests/replay/golden.test.ts` | 4726 | `7da36f242c77fbe964c2ffc86c4c56b644e799e1bf2702cf1335ff3da18dfdc6` |
| `tests/replay/inject.test.ts` | 8854 | `08adb175ed3ead52935eedde6d6b096f5d5e8da4332342e42a774f0a09df0d03` |
| `tests/replay/planner.test.ts` | 9339 | `98aed0020da09bca4c85cf797749f85f04c71650fd30ef315b92ca05e95920af` |
| `tests/replay/search.test.ts` | 3936 | `100710dd3bb317284d2137ea6b247b83e5606e92a492697fc5c0e39fa03a380b` |
| `tests/report/export.test.tsx` | 12477 | `1b49eda7119287686a8a13869fa73eed5ebf7c11b8b0ed358fd5dae0be6406d9` |
| `tests/report/fix-r1-null-paths.test.ts` | 11154 | `34a3156c1ea08cb2d95b4caac945b9f5e0eb79604d35867c0500c304955da147` |
| `tests/report/html.test.ts` | 10456 | `86f3bbd537709e49525835cf52c6e9af2479e546a07f1f8053daf0b1eb37c610` |
| `tests/report/json.test.ts` | 17556 | `76b4c1a8be8b064841882ff56e73780276f9c01418f66d370d734e80e46bb02c` |
| `tests/report/schema.test.ts` | 10139 | `75d777774f0fa8214307b88bc97e6f5047d8819d971869548fbccf27ad88c80d` |
| `tests/s0/gate.test.ts` | 79736 | `6d61d6865dde7c4536fc0e96e50dc6e2c7e067c4728afde569b455cecd9cd2ee` |
| `tests/s0/performance.test.ts` | 7053 | `2e15d56d7dd3099da7a2f991509aada4c66f0e1dba3ff1b4232cecbd566fd8e5` |
| `tests/timeline/AppTimeline.test.tsx` | 6296 | `a6051ab6a5912f9fedaa2de96a804af8afd292e493bb94132411e0630ea0d7e1` |
| `tests/timeline/Timeline.test.tsx` | 11245 | `bee4835ef5ad41a091fa81b4968a92d975924bf12d188fd9cf34ede08ddbd60a` |
| `tests/ui/App.test.tsx` | 15262 | `19209879376e3f5b16b60039dca942a42c2526a1988c18a3a07a31feb35e5ff6` |
| `tests/ui/analyze.test.ts` | 13544 | `2badbe416d768bf5c6a5b32880f5385aff5840d3e46b65df9a84c59dbe2846bf` |
| `tests/ui/components.test.tsx` | 7345 | `e3e0fef06878d21459fb0a68d352a48d1ce9519127a43679cb6f30135ee8c256` |
| `tests/ui/security.test.ts` | 2727 | `7347c6d1b279ffaf85ab1dc01e728962d5a7f48b583fb3f1263978974a1429cf` |
| `tests/worker/client.test.ts` | 10131 | `6ca73e29b263d20b633a88a622ff5cb30824cc5edae9529a452566260bc3806b` |
| `tests/worker/host.test.ts` | 5774 | `343d74b729aee5096c2538d0fc1e832398751c2d94af06a18a0684c056af812b` |
| `tests/worker/parity.test.ts` | 8931 | `c81c05170bff56dec81edc9a38b307055913661bd1e9ddb5cf41d3811a13496e` |
| `tests/worker/protocol.test.ts` | 1719 | `55f3f32ae065f2ff0997cd3b3ab67d8d9ba88dfc67e3dfb8dc0f3f7863d0230b` |
| `tsconfig.json` | 428 | `9ffd55f4003c86674abd58b98b525430ff42dc3ba1ff575bacfba224bd3a0511` |
| `vite.config.ts` | 136 | `5240308ebeb01504b9a13bf043e020ee88103a35041c31de34ed03e48bcb37fd` |
| `vitest.config.ts` | 637 | `43d940fab6839b60c8507256eb28d777584a2390634ab6b0036cec7ef942ee5d` |
