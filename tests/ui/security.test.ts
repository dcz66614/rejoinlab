/**
 * P031 RejoinLab — T008: 静态安全与窄屏检查。
 *
 * - UI 源码不得出现 innerHTML / dangerouslySetInnerHTML（用户输入
 *   不得通过 innerHTML 注入）；
 * - UI 源码不得读写 localStorage / sessionStorage / IndexedDB；
 * - 窄屏样式必须存在：390px 档位（max-width: 480px）下纵向单列；
 * - index.html 必须有 viewport meta，保证移动端按设备宽度渲染。
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stripComments(content: string): string {
  // 静态检查只关心可执行代码：先去掉块注释与行注释，避免文档
  // 中提到被禁 API 名称（如“不写入 localStorage”）造成误报。
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function readUiSources(): Array<{ name: string; content: string }> {
  return readdirSync("src/ui")
    .filter((name: string) => /\.(tsx?|css)$/.test(name))
    .map((name: string) => ({
      name,
      content: stripComments(readFileSync(`src/ui/${name}`, "utf8")),
    }));
}

describe("静态安全检查", () => {
  it("UI 源码中无 innerHTML / dangerouslySetInnerHTML", () => {
    for (const file of readUiSources()) {
      expect(file.content, file.name).not.toContain("innerHTML");
      expect(file.content, file.name).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("UI 源码中无 localStorage / sessionStorage / IndexedDB 读写", () => {
    for (const file of readUiSources()) {
      expect(file.content, file.name).not.toContain("localStorage");
      expect(file.content, file.name).not.toContain("sessionStorage");
      expect(file.content, file.name).not.toContain("indexedDB");
    }
  });

  it("UI 源码中无 eval / new Function / document.write", () => {
    for (const file of readUiSources()) {
      expect(file.content, file.name).not.toMatch(/\beval\s*\(/);
      expect(file.content, file.name).not.toContain("new Function");
      expect(file.content, file.name).not.toContain("document.write");
    }
  });
});

describe("窄屏检查", () => {
  it("styles.css 在 480px 断点（含 390px 档位）下改为纵向单列", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");
    expect(css).toContain("@media (max-width: 480px)");
    const mediaBlock = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(mediaBlock).toContain("grid-template-columns: 1fr");
  });

  it("index.html 有 viewport meta（width=device-width）", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
  });
});
