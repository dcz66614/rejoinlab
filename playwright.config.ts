/**
 * P031 RejoinLab — T011: Playwright E2E 配置。
 *
 * 真实 Chromium（本机已装的 Playwright Chromium），跑生产构建
 * （`vite preview` 伺服 `dist/`），不跑 dev 服务器：E2E 验证的是
 * 将交付的产物，Worker 以独立 chunk（assets/rejoin.worker-*.js）
 * 加载，绝不用 in-process 回退冒充。
 *
 * webServer 先构建再起 preview；同一命令内完成，保证构建产物与
 * 当前源码一致。
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
