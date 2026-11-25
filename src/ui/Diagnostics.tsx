/**
 * P031 RejoinLab — T008: 诊断面板。
 *
 * 原样展示 T005 的报告层诊断：代码、严重级别、sourceIndex、消息、
 * 证据。CRITICAL / WARNING 同时用文字与颜色标识，不只依赖颜色。
 * 证据用 <details> 折叠展示，JSON 文本经 React 转义渲染。
 */
import type { ReplayDiagnostic } from "../replay/planner.js";

export interface DiagnosticsProps {
  readonly diagnostics: readonly ReplayDiagnostic[];
}

function severityLabel(severity: ReplayDiagnostic["severity"]): string {
  return severity === "CRITICAL" ? "严重" : "警告";
}

export function Diagnostics(props: DiagnosticsProps) {
  const { diagnostics } = props;
  const criticalCount = diagnostics.filter((d) => d.severity === "CRITICAL").length;
  const warningCount = diagnostics.length - criticalCount;
  return (
    <section className="panel diagnostics-panel" aria-label="诊断">
      <h2>诊断</h2>
      {diagnostics.length === 0 ? (
        <p className="hint">无诊断。注意：无诊断不等于 Agent 后端正确，只说明本次双轨比较未发现可证实的不一致。</p>
      ) : (
        <>
          <p className="meta-line">
            共 {diagnostics.length} 条：严重（CRITICAL）{criticalCount} 条，警告（WARNING）{warningCount} 条。
          </p>
          <ul className="diagnostic-list">
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.code}-${diagnostic.sourceIndex ?? "none"}-${index}`}
                className={`diagnostic diagnostic-${diagnostic.severity.toLowerCase()}`}
              >
                <p>
                  <strong>{diagnostic.code}</strong>{" "}
                  <span className={`severity-badge severity-${diagnostic.severity.toLowerCase()}`}>
                    {diagnostic.severity} · {severityLabel(diagnostic.severity)}
                  </span>
                  {diagnostic.sourceIndex !== undefined && (
                    <span> · sourceIndex {diagnostic.sourceIndex}</span>
                  )}
                  {diagnostic.relatedSourceIndices !== undefined &&
                    diagnostic.relatedSourceIndices.length > 0 && (
                      <span> · 相关 sourceIndex：{diagnostic.relatedSourceIndices.join(", ")}</span>
                    )}
                </p>
                <p>{diagnostic.message}</p>
                <details>
                  <summary>证据</summary>
                  <pre>{JSON.stringify(diagnostic.evidence, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
