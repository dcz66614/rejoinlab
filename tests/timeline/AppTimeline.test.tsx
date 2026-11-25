/**
 * @vitest-environment jsdom
 *
 * P031 RejoinLab — T009: App 经 Worker 的集成测试。
 *
 * jsdom 没有 Web Worker API，客户端退回同一份协议 host 的
 * in-process 执行（mode 如实报告为 in-process，界面注明）；
 * 真实浏览器中的独立 Worker 线程路径由 T011 E2E（Chromium）核验。
 * 这里核查 App 接线本身：开始 → Worker 结果 → StateDiff +
 * Diagnostics + Timeline 三者同源展示；暂停真实取消且不产生结果。
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

const FAULTY_JSONL = [
  '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
  '{"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"search","parentMessageId":"msg-1"}',
  '{"type":"TOOL_CALL_ARGS","toolCallId":"call-1","delta":"{\\"q\\":\\"x\\"}"}',
  '{"type":"TOOL_CALL_END","toolCallId":"call-1"}',
  '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
].join("\n");

async function importAndWait(text: string, fileName: string, count: number): Promise<void> {
  const input = screen.getByLabelText("选择事件文件") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], fileName)] } });
  await screen.findByText(`${count} 条`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App 经 Worker：正常轨迹", () => {
  it("开始后双轨时间线出现，两条轨道各 6 条事件，终态哈希一致", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    expect(screen.getByTestId("run-status").textContent).toBe("已完成");
    // Worker 模式如实注明（jsdom 无 Worker API，走 in-process host）。
    expect(screen.getByTestId("worker-mode-note").textContent).toContain("独立 Worker 线程");
    const fullTrack = screen.getByTestId("timeline-track-full");
    const resumeTrack = screen.getByTestId("timeline-track-resume");
    expect(within(fullTrack).getAllByRole("button")).toHaveLength(6);
    expect(within(resumeTrack).getAllByRole("button")).toHaveLength(6);
    // 点击完整轨道事件，展示原始 JSON。
    const firstRow = within(fullTrack).getAllByRole("button")[0];
    expect(firstRow).toBeDefined();
    fireEvent.click(firstRow as HTMLElement);
    const panel = screen.getByTestId("timeline-selected-json");
    expect(panel.textContent).toContain("RUN_STARTED");
    expect(panel.textContent).toContain("run-1");
  });

  it("逐事件回放：逐步推进到末尾始终一致", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    fireEvent.click(screen.getByRole("button", { name: "跳到末尾" }));
    expect(screen.getByTestId("timeline-step-comparison").textContent).toContain(
      "两侧状态一致",
    );
  });
});

describe("App 经 Worker：故障轨迹与取消", () => {
  it("REPLAY_PREFIX 故障轨迹：不一致 + 首个分歧标记与 StateDiff 同值", async () => {
    render(<App />);
    await importAndWait(FAULTY_JSONL, "faulty.jsonl", 6);
    fireEvent.click(screen.getByLabelText(/从头完整重放/));
    fireEvent.change(screen.getByLabelText("断线位置"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText(/重放已处理前缀/));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("不一致（INCONSISTENT）");
    expect(screen.getAllByText("DUPLICATE_TOOL_CALL").length).toBeGreaterThanOrEqual(1);
    const divergenceIndex = screen.getByTestId("first-divergence-source-index").textContent;
    const fullTrack = screen.getByTestId("timeline-track-full");
    const divergenceRow = within(fullTrack)
      .getAllByRole("button")
      .find((row) => row.getAttribute("data-source-index") === divergenceIndex);
    expect(divergenceRow?.textContent).toContain("首个分歧");
    // 恢复轨道上有重复标记。
    const resumeTrack = screen.getByTestId("timeline-track-resume");
    expect(
      within(resumeTrack)
        .getAllByRole("button")
        .some((row) => row.textContent?.includes("重复")),
    ).toBe(true);
  });

  it("暂停：开始后立即暂停，Worker 任务被取消且不产生结果与时间线", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-status").textContent).toBe("已暂停");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/裁决/)).toBeNull();
    expect(screen.queryByTestId("timeline-track-full")).toBeNull();
    expect(screen.getByTestId("run-status").textContent).toBe("已暂停");
  });

  it("清空：清除时间线与结果", async () => {
    render(<App />);
    await importAndWait(TRACE_JSONL, "normal.jsonl", 6);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByText("一致（CONSISTENT）");
    expect(screen.getByTestId("timeline-track-full")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.queryByTestId("timeline-track-full")).toBeNull();
    expect(screen.queryByText(/裁决/)).toBeNull();
  });
});
