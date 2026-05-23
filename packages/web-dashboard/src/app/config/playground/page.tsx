"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
import { fetcher, API } from "@/lib/api";
import {
  PageHeader, Badge, Skeleton, EmptyState,
} from "@/components/ui";

const EXAMPLE_CONTEXT = `{
  "author": "alice",
  "branch": "feature/new-api",
  "files": ["src/app.js", "src/utils.js", "README.md"],
  "labels": ["enhancement"],
  "title": "Add new API endpoint",
  "body": "This PR adds a new REST API endpoint.",
  "changes": { "added": 45, "deleted": 12, "modified": 3 },
  "repo": "acme/app",
  "is_new": true,
  "is_draft": false
}`;

const EXPRESSION_LIBRARY = [
  { label: "Author is bot", expr: "author | match('*[bot]')" },
  { label: "Has label 'bug'", expr: "labels | includes('bug')" },
  { label: "Touches src/", expr: "files | some(match('src/**'))" },
  { label: "All docs", expr: "files | all(extension('.md'))" },
  { label: "Large PR", expr: "changes.added + changes.deleted > 500" },
  { label: "Feature branch", expr: "branch | startsWith('feature/')" },
  { label: "Title contains 'fix'", expr: "title | contains('fix')" },
  { label: "More than 5 files", expr: "files | length > 5" },
  { label: "Not a bot and touches src", expr: "not author | match('*[bot]') and files | some(match('src/**'))" },
  { label: "Security change", expr: "files | some(match('src/auth/**'), match('**/secrets*'))" },
];

export default function PlaygroundPage() {
  const [expression, setExpression] = useState("files | some(match('src/**'))");
  const [contextJSON, setContextJSON] = useState(EXAMPLE_CONTEXT);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const evaluate = useCallback(async () => {
    setLoading(true);
    try {
      const ctx = JSON.parse(contextJSON);
      const BASE = process.env.NEXT_PUBLIC_API_URL || "";
      const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${BASE}/api/config/playground`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expression,
          context: ctx,
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setResult({ error: err.message, trace: [] });
    } finally {
      setLoading(false);
    }
  }, [expression, contextJSON]);

  const insertExpression = (expr: string) => {
    setExpression(expr);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Config Playground"
        subtitle="Test expression rules against sample event payloads"
      />

      {/* Expression library */}
      <div className="px-6 py-3 border-b border-border">
        <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
          Expression Library — click to insert
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EXPRESSION_LIBRARY.map((item) => (
            <button
              key={item.expr}
              onClick={() => insertExpression(item.expr)}
              className="px-2 py-1 text-[11px] font-mono bg-surface-2 border border-border rounded hover:border-accent-blue/50 hover:text-accent-blue transition-colors"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Split pane */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-x divide-border">
        {/* Left: Expression editor */}
        <div className="p-6">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
            Expression
          </div>
          <textarea
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            className="w-full h-16 bg-surface-2 border border-border rounded px-3 py-2 font-mono text-sm text-text-primary focus:outline-none focus:border-accent-blue/50 resize-none"
            placeholder="files | some(match('src/**'))"
            spellCheck={false}
          />

          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2 mt-4">
            Context (JSON)
          </div>
          <textarea
            value={contextJSON}
            onChange={(e) => setContextJSON(e.target.value)}
            className="w-full h-64 bg-surface-2 border border-border rounded px-3 py-2 font-mono text-xs text-text-primary focus:outline-none focus:border-accent-blue/50 resize-y"
            spellCheck={false}
          />

          <button
            onClick={evaluate}
            disabled={loading || !expression.trim()}
            className="mt-3 px-4 py-2 bg-accent-blue text-white text-xs font-mono font-bold rounded hover:bg-accent-blue/90 transition-colors disabled:opacity-50"
          >
            {loading ? "Evaluating..." : "Evaluate"}
          </button>
        </div>

        {/* Right: Results */}
        <div className="p-6">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
            Result
          </div>
          {!result && !loading && (
            <EmptyState icon="🧪" title="Ready to test" body="Write an expression and context, then click Evaluate." />
          )}
          {loading && <Skeleton className="h-32" />}
          {result && !loading && (
            <div>
              {/* Result value */}
              <div className="flex items-center gap-3 mb-4">
                <Badge variant={result.error ? "red" : result.result ? "green" : "default"}>
                  {result.error ? "ERROR" : String(result.result)}
                </Badge>
                {result.evaluated_at && (
                  <span className="text-[10px] font-mono text-text-tertiary">
                    {new Date(result.evaluated_at).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {/* Error */}
              {result.error && (
                <div className="px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded text-xs font-mono text-accent-red mb-4">
                  {result.error}
                </div>
              )}

              {/* Trace */}
              {result.trace && result.trace.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
                    Evaluation Trace
                  </div>
                  <div className="space-y-1">
                    {result.trace.map((step: any, i: number) => (
                      <div
                        key={String(i)}
                        className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 rounded text-xs font-mono"
                      >
                        <Badge variant={step.result ? "green" : "default"}>
                          {String(step.result)}
                        </Badge>
                        <span className="text-text-secondary">{step.step}</span>
                        {step.detail && (
                          <span className="text-text-tertiary ml-auto">{step.detail}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Syntax reference */}
      <div className="px-6 py-4 border-t border-border bg-surface-1/30">
        <details>
          <summary className="text-xs font-mono text-text-tertiary cursor-pointer hover:text-text-secondary">
            Syntax Reference
          </summary>
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
            <div>
              <div className="text-text-tertiary mb-1">Operators</div>
              <div>and, or, not</div>
              <div>&gt;, &gt;=, &lt;, &lt;=, ==, !=</div>
              <div>+, -, *, /</div>
            </div>
            <div>
              <div className="text-text-tertiary mb-1">Filters</div>
              <div>match(pattern)</div>
              <div>contains(str)</div>
              <div>startsWith(str)</div>
              <div>endsWith(str)</div>
              <div>includes(val)</div>
            </div>
            <div>
              <div className="text-text-tertiary mb-1">Array Filters</div>
              <div>some(filter)</div>
              <div>all(filter)</div>
              <div>length</div>
              <div>extension(ext)</div>
            </div>
            <div>
              <div className="text-text-tertiary mb-1">Context Variables</div>
              <div>author, branch, title</div>
              <div>files, labels, repo</div>
              <div>changes.added/deleted</div>
              <div>is_new, is_draft</div>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
