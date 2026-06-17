"use client";

import { useState, useCallback } from "react";
import {
  PageHeader, Skeleton,
} from "@/components/ui";

/**
 * Policy Preview Dashboard
 *
 * Non-mutating: lets operators paste .gitwire.yml YAML and validate it
 * against the policy validation API. Never saves, never mutates GitHub.
 *
 * Calls POST /api/config/validate and renders the structured response.
 */

const SEVERITY_STYLES: Record<string, string> = {
  high: "bg-red-500/10 text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  error: "bg-red-500/10 text-red-400 border-red-500/20",
  info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

const EXAMPLE_YAML = `version: 1

pillars:
  triage:
    enabled: true
    auto_label: true
  ci_healing:
    enabled: true
    auto_patch: true
  issue_fix:
    enabled: false
  ai_review:
    enabled: true

settings:
  dry_run: false`;

interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; severity: string; message: string }>;
  warnings: Array<{ path: string; severity: string; message: string }>;
  enabled_pillars: string[];
  dry_run: boolean;
  risky_settings: Array<{ path: string; reason: string; severity: string; mitigated_by_dry_run: boolean }>;
  normalized_config: Record<string, unknown>;
  parsed_at: string;
}

export default function PolicyPreviewPage() {
  const [yamlInput, setYamlInput] = useState<string>(EXAMPLE_YAML);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const validate = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    setResult(null);
    try {
      const BASE = process.env.NEXT_PUBLIC_API_URL || "";
      const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${BASE}/api/config/validate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ yaml: yamlInput }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data: ValidationResult = await res.json();
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Validation request failed";
      setApiError(msg);
    } finally {
      setLoading(false);
    }
  }, [yamlInput]);

  const highRisks = result?.risky_settings.filter(r => r.severity === "high") ?? [];
  const mediumRisks = result?.risky_settings.filter(r => r.severity === "medium") ?? [];
  const lowRisks = result?.risky_settings.filter(r => r.severity === "low") ?? [];
  const unmitigatedRisks = result?.risky_settings.filter(r => !r.mitigated_by_dry_run) ?? [];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Policy Preview"
        subtitle="Validate .gitwire.yml before applying — non-mutating analysis"
      />

      {/* Safety banner */}
      <div className="mx-6 mt-4 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-2 flex items-center gap-2">
        <span className="text-blue-400 text-sm font-mono">[PREVIEW]</span>
        <span className="text-blue-400/80 text-xs">
          This preview does not save config or mutate GitHub. Paste YAML to analyze its effect.
        </span>
      </div>

      <div className="px-6 py-4">
        {/* YAML Input */}
        <div className="mb-3">
          <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">
            .gitwire.yml content
          </label>
          <textarea
            value={yamlInput}
            onChange={(e) => setYamlInput(e.target.value)}
            rows={16}
            spellCheck={false}
            className="w-full bg-surface-2 border border-border rounded-lg p-3 text-xs font-mono text-text-primary resize-y focus:border-accent-primary/50 focus:outline-none"
            placeholder="Paste your .gitwire.yml here..."
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={validate}
            disabled={loading || !yamlInput.trim()}
            className="px-4 py-2 bg-accent-green text-surface-0 text-xs font-mono font-bold rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50"
          >
            {loading ? "Validating..." : "Validate policy"}
          </button>
          <button
            onClick={() => { setYamlInput(EXAMPLE_YAML); setResult(null); setApiError(null); }}
            className="px-3 py-2 text-xs font-mono text-text-secondary border border-border rounded hover:border-text-tertiary transition-colors"
          >
            Reset to example
          </button>
          <button
            onClick={() => { setYamlInput(""); setResult(null); setApiError(null); }}
            className="px-3 py-2 text-xs font-mono text-text-secondary border border-border rounded hover:border-text-tertiary transition-colors"
          >
            Clear
          </button>
        </div>

        {/* API Error */}
        {apiError && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
            <div className="text-red-400 text-sm font-mono mb-1">Validation failed</div>
            <div className="text-red-400/70 text-xs">{apiError}</div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="mt-4 space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="mt-4 space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className={"rounded-lg p-3 border " + (result.valid ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5")}>
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Status</div>
                <div className={"text-lg font-bold " + (result.valid ? "text-green-400" : "text-red-400")}>
                  {result.valid ? "Valid" : "Invalid"}
                </div>
              </div>
              <div className={"rounded-lg p-3 border " + (result.dry_run ? "border-amber-500/30 bg-amber-500/5" : "border-gray-500/20 bg-surface-2")}>
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Dry-Run</div>
                <div className={"text-lg font-bold " + (result.dry_run ? "text-amber-400" : "text-text-primary")}>
                  {result.dry_run ? "On" : "Off"}
                </div>
              </div>
              <div className="rounded-lg p-3 border border-border bg-surface-2">
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Pillars</div>
                <div className="text-lg font-bold text-text-primary">{result.enabled_pillars.length}</div>
                <div className="text-[10px] text-text-tertiary">enabled</div>
              </div>
              <div className={"rounded-lg p-3 border " + (result.risky_settings.length > 0 ? "border-red-500/20 bg-red-500/5" : "border-green-500/20 bg-green-500/5")}>
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Risks</div>
                <div className={"text-lg font-bold " + (result.risky_settings.length > 0 ? "text-red-400" : "text-green-400")}>
                  {result.risky_settings.length}
                </div>
                {unmitigatedRisks.length > 0 && (
                  <div className="text-[10px] text-red-400/70">{unmitigatedRisks.length} unmitigated</div>
                )}
              </div>
              <div className={"rounded-lg p-3 border " + (result.warnings.length > 0 ? "border-amber-500/20 bg-amber-500/5" : "border-border bg-surface-2")}>
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider">Warnings</div>
                <div className={"text-lg font-bold " + (result.warnings.length > 0 ? "text-amber-400" : "text-text-primary")}>
                  {result.warnings.length}
                </div>
              </div>
            </div>

            {/* Errors (structural validation failures) */}
            {result.errors.length > 0 && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <div className="text-xs font-mono uppercase text-red-400 tracking-wider mb-2">
                  Errors ({result.errors.length})
                </div>
                <div className="space-y-2">
                  {result.errors.map((e, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border " + (SEVERITY_STYLES[e.severity] || SEVERITY_STYLES.error)}>
                        {e.severity || "error"}
                      </span>
                      {e.path !== "*" && (
                        <span className="text-[10px] font-mono text-text-tertiary">{e.path}</span>
                      )}
                      <span className="text-xs text-text-primary">{e.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Enabled pillars */}
            {result.valid && result.enabled_pillars.length > 0 && (
              <div className="rounded-lg border border-border bg-surface-2 p-4">
                <div className="text-[10px] font-mono uppercase text-text-tertiary tracking-wider mb-2">
                  Enabled Pillars ({result.enabled_pillars.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {result.enabled_pillars.map((p) => (
                    <span key={p} className="text-xs font-mono px-2 py-1 rounded border bg-blue-500/10 text-blue-400 border-blue-500/20">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Risky settings */}
            {result.risky_settings.length > 0 && (
              <div className="rounded-lg border border-red-500/20 bg-surface-2 p-4">
                <div className="text-xs font-mono uppercase text-red-400 tracking-wider mb-3">
                  Risky Settings ({result.risky_settings.length})
                </div>
                <div className="space-y-3">
                  {/* High severity */}
                  {highRisks.length > 0 && (
                    <div>
                      <div className="text-[10px] font-mono text-red-400/70 uppercase mb-1">High</div>
                      {highRisks.map((r, i) => (
                        <RiskRow key={"h" + i} risk={r} dryRun={result.dry_run} />
                      ))}
                    </div>
                  )}
                  {/* Medium severity */}
                  {mediumRisks.length > 0 && (
                    <div>
                      <div className="text-[10px] font-mono text-amber-400/70 uppercase mb-1">Medium</div>
                      {mediumRisks.map((r, i) => (
                        <RiskRow key={"m" + i} risk={r} dryRun={result.dry_run} />
                      ))}
                    </div>
                  )}
                  {/* Low severity */}
                  {lowRisks.length > 0 && (
                    <div>
                      <div className="text-[10px] font-mono text-blue-400/70 uppercase mb-1">Low</div>
                      {lowRisks.map((r, i) => (
                        <RiskRow key={"l" + i} risk={r} dryRun={result.dry_run} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-surface-2 p-4">
                <div className="text-xs font-mono uppercase text-amber-400 tracking-wider mb-3">
                  Warnings ({result.warnings.length})
                </div>
                <div className="space-y-2">
                  {result.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border " + (SEVERITY_STYLES[w.severity] || SEVERITY_STYLES.warning)}>
                        {w.severity || "warning"}
                      </span>
                      {w.path !== "*" && (
                        <span className="text-[10px] font-mono text-text-tertiary">{w.path}</span>
                      )}
                      <span className="text-xs text-text-primary">{w.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Normalized config (collapsible) */}
            {result.valid && (
              <div className="rounded-lg border border-border bg-surface-2">
                <button
                  onClick={() => setShowConfig(!showConfig)}
                  className="w-full px-4 py-2 text-left text-xs font-mono text-text-secondary hover:text-text-primary transition-colors flex items-center justify-between"
                >
                  <span className="uppercase tracking-wider text-text-tertiary">Normalized Config (redacted)</span>
                  <span className="text-text-tertiary">{showConfig ? "Hide" : "Show"}</span>
                </button>
                {showConfig && (
                  <pre className="px-4 pb-4 text-[10px] font-mono text-text-secondary overflow-auto max-h-80 whitespace-pre-wrap">
                    {JSON.stringify(result.normalized_config, null, 2)}
                  </pre>
                )}
              </div>
            )}

            {/* Parsed timestamp */}
            {result.parsed_at && (
              <div className="text-[10px] text-text-tertiary text-center">
                Analyzed at {new Date(result.parsed_at).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Risk row component with mitigation badge */
function RiskRow({ risk, dryRun }: { risk: { path: string; reason: string; severity: string; mitigated_by_dry_run: boolean }; dryRun: boolean }) {
  const mitigated = risk.mitigated_by_dry_run && dryRun;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="text-xs font-mono text-text-secondary flex-1">
        <span className="text-text-tertiary">{risk.path}</span>
        <span className="text-text-primary"> {risk.reason}</span>
      </span>
      {risk.mitigated_by_dry_run && (
        <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border " + (mitigated
          ? "border-green-500/30 bg-green-500/10 text-green-400"
          : "border-red-500/30 bg-red-500/10 text-red-400")}>
          {mitigated ? "dry-run safe" : "dry-run off"}
        </span>
      )}
      {!risk.mitigated_by_dry_run && (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-gray-500/20 bg-gray-500/5 text-gray-400">
          not mitigated
        </span>
      )}
    </div>
  );
}
