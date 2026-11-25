# P031 RejoinLab 规格核验日志（v1.0.0）

核验时间：2026-11-23 ~14:00 GMT。核验人：规格核验与归档协调员（主聊天复核后方可宣布 VERIFIED）。
来源：~/workspace/P031_SPECS.md（87,938 B，含 GPT 消息 2 回复全文 + 消息 3 补发回复全文 + 主聊天头注）。
拆分输出：
- ~/workspace/p031-rejoinlab/01_project_book/PROJECT_BOOK.md — 232 行，45,988 B，SHA-256 b88d3a288f9f309ff1b6cffb6f50f2e1e79be3a65cef2b0a96814ec1d4c3706e
- ~/workspace/p031-rejoinlab/02_implementation_plan/IMPLEMENTATION_PLAN.md — 165 行，32,812 B，SHA-256 d371242e146654783b7238e45221266a20718085fe46639df3cd44b934250c67

## 1. 拆分与合并方法（逐字，不改写 GPT 原文）

- PROJECT_BOOK.md：取 P031_SPECS.md 第 27–258 行（自“文件一：PROJECT_BOOK.md”至“项目状态：SPECIFICATION_FROZEN_PENDING_OWNER_REVIEW / NO_CODE_BUILT。”），逐字。
- IMPLEMENTATION_PLAN.md：取第 260–326 行（自“# 文件二：IMPLEMENTATION_PLAN.md”至 T007 卡片被截断行）；T007 卡片在“验收命令：…python -m pytest -q oracle/tests。”处截断，其后 173 字符的截断硬门文本（“硬门（页面呈现至此中断）：Golden 正确分类 24/24；…；单轨迹性能 |（该行后无数值，页面直接进入下一段）”）被消息 3 的完整版 T007 硬门表格（18 行，含 S0 PASS/FAIL 裁决）替换；随后插入消息 3 的 T008–T014 七张详细任务卡（76 行，含“一、IMPLEMENTATION_PLAN.md 第 6 节补充”小标题行）。
- 排除项（均记录于此，非悄悄删除）：
- 主聊天头注（P031_SPECS.md 第 1–9 行、附录头注第 341–351 行）——非 GPT 规格正文。
- 消息 2 的“…”标注行（第 328 行）——主聊天/浏览器标注，非 GPT 正文。
- 消息 2 结尾的“交付确认”段（“PROJECT_BOOK.md：完整输出。IMPLEMENTATION_PLAN.md：完整输出。…两份文件均未使用'略'代替章节，没有省略章节”）——已被证实为假（T008–T014 当时确实缺失），不收入冻结规格。
- 消息 3 的回复框架文字（道歉与分工说明段、结尾“本次补发确认：…”句）——回复框架，非规格正文；但分工纠正本身已按其执行（见 D-05）。
- 转录 artifact 处理：P031_SPECS.md 中 GPT 正文行带统一的 4 空格行首缩进（293 行；另 116 行为 0 缩进），与 P030 规格文件格式不一致；拆分时统一去掉这 4 空格（逐行核实：非空行缩进只取 0 或 4 两种值，无其他缩进）。内容字符除行首缩进外未动。

## 2. 机械核验结果（全部通过项）

- 项目书章节：§0–§18 共 19 节全部齐全，无缺失。
- 实施计划章节：§0–§6 共 7 节；T001–T014 详细任务卡全部齐全（14/14）。
- 工时一致：S0 5+7+9+8+7+9+7=52h；S1 4+4+3+2+3+2+2=20h；52+20=72h 任务预算；+16h 缓冲=88h 总预算。14 张卡片的“预算 X 小时”与 §2.2 任务总表逐项一致（14/14）。
- 关键数字一致：24 Golden（G01–G08 8 条 + N01–N16 16 条，项目书 §9 逐项核实）；15 种 MVP 事件（项目书 §3.2，所列 15 种 + 明确不支持清单）；10 个诊断代码（§6：DUPLICATE_TOOL_CALL、LOST_EVENT、OUT_OF_ORDER、MESSAGE_REORDER、SNAPSHOT_MISMATCH、DIVERGENT_STATE、SUSPECTED_DUPLICATE、TOOL_CALL_ID_REUSE、MISSING_TERMINAL、TRUNCATED_RUN）；5 种裁决（§7：CONSISTENT、INCONSISTENT、INCONCLUSIVE_LIMIT、INVALID_INPUT、INCOMPLETE_TRACE）；40 条事件上限；单轨迹 <1,000 ms（计划 T007 表；项目书用“1 秒”表述，5 处）；搜索节点 ≤5,000；真人参与 0 人；MIT 协议；rejoinlab.report/v1（项目书 3 处、计划 3 处）。
- T007 表一致性：项目书 §11 S0 门数字（24/24、8/8、16/16、100%）与计划 T007 完整硬门表格一致；截断标记（“单轨迹性能 |（”、“页面呈现至此中断”）在两个规格文件中均已不存在。
- 分工一致性：消息 3 的分工纠正已执行——T006 负责 oracle/ + Golden（计划 §4.2 亦然）；T008 ui/、T009 worker/+Timeline、T010 report/+ExportPanel、T011 E2E、T012 安全与性能脚本、T013 文档、T014 集成冻结，§4.2 文件归属与补发卡片一致，无重复分配。
- 证据纠正已入规格：项目书 §2.3 的 E02-B 采用了 GPT 核实后的精确表述（MESSAGES_SNAPSHOT 改掉已有 assistant message 的 ID 后旧位置残留，非“快照随机改变所有消息 ID”）；§2.4 明确 AG-UI 1.0 HTTP+SSE 绑定不支持流恢复、SSE id 不是恢复游标（与消息 2 开头的纠正一致）。
- “略”字核查：项目书 6 处、计划 2 处均为合法词内字符（忽略/省略/策略/选择），无以“略”代章节的省略标记。
- 前置信息一致：两文件 spec_version 均为 1.0.0；项目书 status 为 SPECIFICATION_FROZEN_PENDING_OWNER_REVIEW；计划 status 为 READY_FOR_S0_IMPLEMENTATION。

## 3. MINOR 发现（非阻断，须记入规格使用说明）

- D-01（已知缺口，浏览器转录截断）：计划中有 8 处“（页面代码块中另有后续文件，提取时截断显示）”标注，全部位于 T008–T014 的输出文件清单（T008 L93、T009 L104、T010 L115、T011 L126、T012 L137、T013 L148、T014 L159）及 T012 的验收命令（L140，“npm run test:”后截断）。冻结规格中这些清单是不完整的——施工时不得把可见清单当作穷尽清单，须以计划 §4.1 工作区布局与 §4.2 文件归属为准。是否需向 GPT 追问完整清单，由主聊天定夺。
- D-02（字段集不一致）：计划 §6 引言称“每张任务卡均包含：TASK_ID；目标；输入；输出；禁止修改；验收命令；预期证据；完成定义；失败回退”，实际三套字段约定并存：T001–T004 用“工作内容/禁止修改/预期证据”；T005–T006 用“工作内容/禁止：…”（无“禁止修改：”标题）；T008–T014 用“实施内容/验收标准”（无“禁止修改/预期证据”）。另有卡片标题措辞微差：§2.2 总表称 T012“隐私、安全、性能与离线测试”，卡片称“性能、确定性、安全与离线验证”；总表称 T010“JSON/HTML 报告和导出”，卡片称“JSON 报告与独立 HTML 导出”——含义相同。
- D-03（T007 卡片字段缺失）：T007 卡片无“完成定义”与“失败回退”字段（以硬门验收矩阵 + S0 PASS/FAIL 裁决收尾）；其余 13 张卡片均有完成定义，T001–T006 与 T008–T014 均有失败回退。
- D-04（计划无 §7+ 收尾章节）：实施计划在 §6 任务卡后即结束，没有总体冻结声明、ADR/变更规则、验收总则等收尾章节（P030 的计划有 §14 冻结与版本管理）。项目书 §0/§18 的冻结信息与诚实边界部分覆盖此缺口，但计划文件本身没有冻结声明。
- D-05（合并接缝记录）：计划文件的 T007 完整表格与 T008–T014 卡片来自消息 3 补发；消息 2 的虚假“交付确认”段未收入冻结规格（见 §1 排除项）。T007 卡片被截断的 173 字符硬门文本已被完整表替换，替换前后均已核对。
- D-06（计划未写 AG-UI 1.0 发布日期）：项目书 §2.1 写明 AG-UI 1.0 发布于 2026-09-18；计划全文只写“AG-UI 1.0”而无日期锚点。非矛盾，仅为信息缺口。

## 4. DOCX

- 生成脚本：~/workspace/p031-rejoinlab/00_control/build_docx.py（改编自 P030 同名脚本；P031 的 md 用“#”标记标题，转换时去掉标题行的“#”前缀再定样式，转换前后全文连接比对）。
- PROJECT_BOOK.docx：55,744 B，SHA-256 7e01a45a463f4793c300721913d51730afa5fa795583030b5e10ade64d5eabc1；md 非空行 210，docx 段落 210，全文精确匹配 True；标题 100 个（§0–§18 全在）。
- IMPLEMENTATION_PLAN.docx：49,768 B，SHA-256 53a3025c88c30b2a76beae41423983b2c06eac25c2c15884c64f8023c09a5a34；md 非空行 155，docx 段落 155，全文精确匹配 True；标题 26 个（§0–§6 全在；T001–T014 卡片为正文段落，T 前缀加粗，与 P030 一致）。

## 5. Drive 归档

- 文件夹：agent project auto / P031-rejoinlab，id `1ql-Glo_rVUMTMMbdw98ctbdhA62eBQrG`（新建；上传前已确认不存在）。文件夹内共 4 个文件，无重复。
- 4 个文件（md×2 + docx×2）逐个按 fileId 核对大小 + MD5，全部 MATCH。

| 文件 | 本地大小 | 本地 SHA-256 | Drive fileId | Drive MD5 | 核对 |
|---|---|---|---|---|---|
| PROJECT_BOOK.md | 45,988 B | b88d3a28… | 1SDJR4uLOWlL3pD69HTBUBEljIA_ONpXm | ef031656… | MATCH |
| IMPLEMENTATION_PLAN.md | 32,812 B | d371242e… | 1TmYPDsDrBTpPGYhMHiTJvo-IvBIvG4NB | 1a90a5d9… | MATCH |
| PROJECT_BOOK.docx | 55,744 B | 7e01a45a… | 1xKQPIHDbdgd1hJcBlApkQnJ3dVj8G5SN | 18530b4c… | MATCH |
| IMPLEMENTATION_PLAN.docx | 49,768 B | 53a3025c… | 1yB9Rzq8_PIk4WCVZrNzW4TA3yAByr-Zo | 244ba488… | MATCH |
