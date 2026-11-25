/**
 * P031 RejoinLab — Vitest 配置（测试线束修复）。
 *
 * tests/e2e/rejoinlab.spec.ts 是 Playwright 规格（跑 `npm run test:e2e`），
 * 不是 Vitest 用例。没有本文件时 vitest 默认 include 会把它收进来，
 * 在 vitest 里调用 Playwright 的 test.beforeEach() 会直接抛错，
 * 导致 `npx vitest run` 即使 600 个测试全过也 exit 1。
 * 这里只排除 tests/e2e，其余沿用 vitest 默认 include/exclude。
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
