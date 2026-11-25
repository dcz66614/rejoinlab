/**
 * @vitest-environment jsdom
 *
 * P031 RejoinLab — T008: App 端到端交互测试（真实浏览器 API 层，
 * jsdom）：文件导入、拖放、断线位置、恢复策略、故障注入、运行 /
 * 暂停 / 重置 / 清空、XSS 防护、无本地存储写入。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../src/ui/App.js";

const TRACE_JSONL = [
  '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"你好，"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"世界"}',
  '{"type":"TEXT_MESSAGE_END","messageId":"msg-1"}',
  '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
].join("\n");

const TRACE_SSE = [
  "id: evt-0",
  'data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  "",
  "id: evt-1",
  'data: {"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
  "",
  "id: evt-2",
  'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"你好，世界"}',
  "",
  "id: evt-3",
  'data: {"type":"TEXT_MESSAGE_END","messageId":"msg-1"}',
  "",
  "id: evt-4",
  'data: {"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
  "",
].join("\n");

const BAD_JSONL = [
  '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  '{"type":"TEXT_MESSAGE_START"}',
].join("\n");

const XSS_JSONL = [
  '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  '{"type":"TEXT_MESSAGE_START","messageId":"<img src=x onerror=alert(1)>","role":"assistant"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"<img src=x onerror=alert(1)>","delta":"<script>alert(1)</script>"}',
  '{"type":"TEXT_MESSAGE_END","messageId":"<img src=x onerror=alert(1)>"}',
  '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
].join("\n");

function importViaInput(text: string, fileName: string): void {
  const input = screen.getByLabelText("选择事件文件") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], fileName)] } });
}

async function importAndWait(text: string, fileName: string, count: number): Promise<void> {
  importViaInput(text, fileName);
  await screen.findByText(`${count} 条`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App：导入", () => {
  it("JSONL 导入 UI 通过：显示协议版本、文件名与正确事件数量", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    expect(screen.getAllByText(/AG-UI 1\.0/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("normal.jsonl")).toBeTruthy();
    expect(screen.getByTestId("event-count").textContent).toBe("6 条");
    expect(screen.getByText("JSONL")).toBeTruthy();
    expect(screen.getByText("RUN_STARTED")).toBeTruthy();
    expect(screen.getAllByText("TEXT_MESSAGE_CONTENT")).toHaveLength(2);
  });

  it("SSE 导入 UI 通过：识别 SSE 格式，保留 transportEventId", async () => {
    render(<App />);
    await importAndWait(TRACE_SSE, "trace.sse", 5);
    expect(screen.getByText("SSE")).toBeTruthy();
    expect(screen.getByText(/SSE id=evt-0/)).toBeTruthy();
  });

  it("文件拖放通过：drop 文件后完成导入", async () => {
    render(<App />);
    const zone = screen.getByLabelText("拖放导入区");
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File([TRACE_JSONL], "dropped.jsonl")] },
    });
    await screen.findByText("6 条");
    expect(screen.getByText("dropped.jsonl")).toBeTruthy();
  });

  it("解析错误展示：code、sourceIndex 与行号", async () => {
    render(<App />);
    importViaInput(BAD_JSONL, "bad.jsonl");
    await screen.findByText(/解析错误/);
    expect(screen.getByText("INVALID_INPUT")).toBeTruthy();
    expect(screen.getByText(/sourceIndex 1/)).toBeTruthy();
    expect(screen.getByText(/第 2 行/)).toBeTruthy();
    expect(screen.getByText(/字段 messageId/)).toBeTruthy();
    // 解析失败不返回部分事件：事件数量为 0。
    expect(screen.getByTestId("event-count").textContent).toBe("0 条");
  });
});

describe("App：实验参数", () => {
  it("断线位置选择通过：不断线 + 每个 sourceIndex 各一项", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    const select = screen.getByLabelText("断线位置") as HTMLSelectElement;
    expect(select.options.length).toBe(7);
    expect(select.options[0]?.textContent).toContain("不断线");
    expect(select.options[6]?.textContent).toContain("sourceIndex 5");
    fireEvent.change(select, { target: { value: "2" } });
    expect(select.value).toBe("2");
  });

  it("三种恢复策略选择通过", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByText("从头完整重放")).toBeTruthy();
    expect(screen.getByText("从检查点恢复")).toBeTruthy();
    expect(screen.getByText("按 sourceIndex 游标续接")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    expect((screen.getByLabelText(/从头完整重放/) as HTMLInputElement).checked).toBe(true);
  });

  it("故障注入配置 8 种可选：8 个复选框，带参数的算子展开参数输入", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(8);
    for (const label of [
      "游标跳过",
      "丢失事件",
      "重复事件",
      "消息 ID 重映射",
      "重放已处理前缀",
      "陈旧快照",
      "交换相邻事件",
      "截断流",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByLabelText(/重复事件/));
    expect(screen.getByLabelText(/重复事件 目标 sourceIndex/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/游标跳过/));
    expect(screen.getByLabelText(/游标跳过起始 sourceIndex/)).toBeTruthy();
    expect(screen.getByLabelText(/游标跳过结束 sourceIndex/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/消息 ID 重映射/));
    expect(screen.getByLabelText(/重映射原消息 ID/)).toBeTruthy();
  });
});

describe("App：运行控制", () => {
  it("开始运行：正常轨迹显示裁决“一致（CONSISTENT）”，无诊断", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    expect(screen.getByText(/无诊断/)).toBeTruthy();
    expect(screen.getByTestId("run-status").textContent).toBe("已完成");
  });

  it("开始运行：注入 REPLAY_PREFIX 的故障轨迹显示“不一致”与 CRITICAL 诊断", async () => {
    const faulty = [
      '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
      '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
      '{"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"search","parentMessageId":"msg-1"}',
      '{"type":"TOOL_CALL_ARGS","toolCallId":"call-1","delta":"{\\"q\\":\\"x\\"}"}',
      '{"type":"TOOL_CALL_END","toolCallId":"call-1"}',
      '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
    ].join("\n");
    render(<App />);
    await importAndWait(faulty, "faulty.jsonl", 6);
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    // REPLAY_PREFIX 只在设置了断线位置时才重放已处理前缀。
    fireEvent.change(screen.getByLabelText("断线位置"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText(/重放已处理前缀/));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("不一致（INCONSISTENT）");
    expect(screen.getAllByText("DUPLICATE_TOOL_CALL").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/CRITICAL · 严重/).length).toBeGreaterThanOrEqual(1);
  });

  it("暂停：开始后立即暂停，取消本次分析且不产生结果", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-status").textContent).toBe("已暂停");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/裁决/)).toBeNull();
    expect(screen.getByTestId("run-status").textContent).toBe("已暂停");
  });

  it("重置：清除结果与运行状态，保留已导入事件", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(screen.queryByText(/裁决/)).toBeNull();
    expect(screen.getByTestId("event-count").textContent).toBe("6 条");
    expect(screen.getByTestId("run-status").textContent).toBe("未运行");
  });

  it("清空：100% 清除界面数据（文件、事件、配置、结果）", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    fireEvent.click(screen.getByLabelText(/重复事件/));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    // 等待运行完成（不依赖具体裁决：重复 RUN_STARTED 会多一条时间线记录）。
    await waitFor(() => {
      expect(screen.getByTestId("run-status").textContent).toBe("已完成");
    });
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByTestId("event-count").textContent).toBe("0 条");
    expect(screen.getByText("未导入")).toBeTruthy();
    expect(screen.queryByText(/裁决/)).toBeNull();
    expect(screen.getByText(/无诊断/)).toBeTruthy();
    expect(screen.getByTestId("run-status").textContent).toBe("未运行");
    // 配置恢复默认：策略回到“从检查点恢复”，注入全不选，断线位置只剩“不断线”。
    expect((screen.getByLabelText(/从检查点恢复/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    const select = screen.getByLabelText("断线位置") as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    // 事件列表消失。
    expect(within(document.body).queryByText("RUN_STARTED")).toBeNull();
  });
});

describe("App：FIX-T008 回归（F2/F3/F5）", () => {
  it("F2：断线位置文案写明已交付条数（选 i 交付 i+1 条），运行后回显同步", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    const select = screen.getByLabelText("断线位置") as HTMLSelectElement;
    // i=0 不再写“在第 0 个事件后断线”；i=2 交付 3 条。
    expect(select.options[1]?.textContent).toBe("在 sourceIndex 0 处断线（已交付 1 条）");
    expect(select.options[3]?.textContent).toBe("在 sourceIndex 2 处断线（已交付 3 条）");
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    const echo = screen.getByRole("region", { name: "实验配置回显" });
    expect(echo.textContent).toContain("在 sourceIndex 2 处断线（已交付 3 条）");
    expect(echo.textContent).not.toContain("个事件后断线");
  });

  it("F3：运行后改动配置，回显与结果保持运行时刻快照", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    const echo = screen.getByRole("region", { name: "实验配置回显" });
    expect(echo.textContent).toContain("RESUME_FROM_CHECKPOINT");
    expect(echo.textContent).toContain("不断线");
    // 运行后改策略与断线位置：回显仍是运行时刻的配置。
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    fireEvent.change(screen.getByLabelText("断线位置"), { target: { value: "2" } });
    expect(echo.textContent).toContain("RESUME_FROM_CHECKPOINT");
    expect(echo.textContent).not.toContain("FULL_REPLAY_FROM_START");
    expect(echo.textContent).toContain("不断线");
    expect(echo.textContent).not.toContain("已交付 3 条");
    // 结果本身仍是旧配置跑出来的。
    expect(screen.getByText("一致（CONSISTENT）")).toBeTruthy();
    expect(screen.getByTestId("run-status").textContent).toBe("已完成");
  });

  it("F5：勾选 REPLAY_PREFIX 且未设置断线位置时显示不生效提示；设置断线位置后提示消失", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByLabelText(/重放已处理前缀/));
    expect(screen.getByText(/未设置断线位置时本次不生效/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("断线位置"), { target: { value: "4" } });
    expect(screen.queryByText(/未设置断线位置时本次不生效/)).toBeNull();
    // 取消勾选后提示也不应残留。
    fireEvent.click(screen.getByLabelText(/重放已处理前缀/));
    expect(screen.queryByText(/未设置断线位置时本次不生效/)).toBeNull();
  });
});

describe("App：安全", () => {
  it("XSS 防护：含 <img onerror> 与 <script> 的用户输入只作文本渲染，不产生元素、不执行", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { container } = render(<App />);
    await importAndWait(XSS_JSONL, "xss.jsonl", 5);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    // delta 超过 24 字符时界面截断显示（末尾加 …），按截断后文本断言。
    expect(container.textContent).toContain("<script>alert(1)</script");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("无本地存储写入：导入、运行、清空后 localStorage 仍为空", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
