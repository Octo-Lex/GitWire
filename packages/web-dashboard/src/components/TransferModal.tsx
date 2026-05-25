"use client";

import { useState } from "react";
import { fetcher } from "@/lib/api";

interface TransferModalProps {
  repoFullName: string;
  onClose: () => void;
  onDone: () => void;
}

export default function TransferModal({ repoFullName, onClose, onDone }: TransferModalProps) {
  const [newName, setNewName] = useState("");
  const [migrate, setMigrate] = useState(true);
  const [step, setStep] = useState<"form" | "preview" | "loading" | "done" | "error">("form");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  async function handlePreview() {
    if (!newName.includes("/") || newName.split("/").length !== 2) {
      setError("Must be in owner/repo format");
      return;
    }
    setStep("loading");
    setError("");
    try {
      const res = await fetch(
        `/api/repos/${encodeURIComponent(repoFullName)}/transfer/preview`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      setPreview(data);
      setStep("preview");
    } catch (err: any) {
      setError(err.message);
      setStep("form");
    }
  }

  async function handleTransfer() {
    setStep("loading");
    setError("");
    try {
      const res = await fetch(
        `/api/repos/${encodeURIComponent(repoFullName)}/transfer`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_full_name: newName, migrate }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transfer failed");
      setResult(data);
      setStep("done");
    } catch (err: any) {
      setError(err.message);
      setStep("preview");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-0 border border-border rounded-xl shadow-2xl w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {step === "form" && (
          <>
            <h2 className="text-lg font-bold text-text-primary mb-1">Transfer Repository</h2>
            <p className="text-sm text-text-secondary mb-4">
              Move <span className="font-mono text-accent-green">{repoFullName}</span> to a new owner or organization.
            </p>

            <label className="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-1">
              New full name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-owner/repo-name"
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 mb-4"
            />

            <label className="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-2">
              Data handling
            </label>
            <div className="space-y-2 mb-4">
              <label className="flex items-start gap-3 cursor-pointer p-2 rounded hover:bg-surface-2/40">
                <input
                  type="radio"
                  name="migrate"
                  checked={migrate}
                  onChange={() => setMigrate(true)}
                  className="mt-1 accent-[#00d97e]"
                />
                <div>
                  <div className="text-sm font-medium text-text-primary">Migrate data</div>
                  <div className="text-xs text-text-tertiary">
                    Keep all history — actions, decisions, deliveries, audit trail — under the new name
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer p-2 rounded hover:bg-surface-2/40">
                <input
                  type="radio"
                  name="migrate"
                  checked={!migrate}
                  onChange={() => setMigrate(false)}
                  className="mt-1 accent-[#00d97e]"
                />
                <div>
                  <div className="text-sm font-medium text-text-primary">Fresh start</div>
                  <div className="text-xs text-text-tertiary">
                    Soft-delete old data. The repo reappears clean under the new name on next webhook
                  </div>
                </div>
              </label>
            </div>

            {error && <div className="text-xs text-red-400 mb-3">{error}</div>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn text-sm">Cancel</button>
              <button
                onClick={handlePreview}
                disabled={!newName.includes("/")}
                className="px-4 py-1.5 rounded text-sm font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-40"
              >
                Preview Impact
              </button>
            </div>
          </>
        )}

        {step === "preview" && preview && (
          <>
            <h2 className="text-lg font-bold text-text-primary mb-1">Transfer Preview</h2>
            <p className="text-sm text-text-secondary mb-4">
              <span className="font-mono text-text-tertiary">{repoFullName}</span>
              {" → "}
              <span className="font-mono text-accent-green">{newName}</span>
            </p>

            {migrate ? (
              <div className="bg-surface-2 rounded-lg p-4 mb-4 space-y-3">
                <div className="text-sm font-medium text-text-primary">
                  ✅ Migrate mode — data preserved under new name
                </div>
                <div className="text-xs text-text-tertiary">
                  FK-linked tables ({preview.fk_auto_follow}) auto-follow via github_id={preview.repo?.github_id}
                </div>

                {preview.data_at_risk && (
                  <div>
                    <div className="text-xs font-mono text-text-tertiary uppercase mb-1">
                      Text columns to backfill
                    </div>
                    <div className="space-y-1">
                      {Object.entries(preview.data_at_risk.denormalized_rows || {}).map(([table, count]: [string, any]) => (
                        <div key={table} className="flex justify-between text-xs">
                          <span className="text-text-secondary">{table}</span>
                          <span className="font-mono text-text-tertiary">{count} rows</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between text-xs mt-2 pt-2 border-t border-border">
                      <span className="font-medium text-text-primary">Total rows to update</span>
                      <span className="font-mono text-accent-green">{preview.data_at_risk.denormalized_total}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-red-900/10 border border-red-800/30 rounded-lg p-4 mb-4 space-y-2">
                <div className="text-sm font-medium text-red-300">
                  ⚠️ Fresh start — old data will be hidden
                </div>
                <div className="text-xs text-red-400/80">
                  The repo <span className="font-mono">{repoFullName}</span> will be soft-deleted.
                  It reappears under <span className="font-mono">{newName}</span> when the next webhook arrives.
                  Historical data ({preview.data_at_risk?.grand_total || 0} rows) stays in DB but is hidden.
                </div>
              </div>
            )}

            {error && <div className="text-xs text-red-400 mb-3">{error}</div>}

            <div className="flex justify-end gap-2">
              <button onClick={() => setStep("form")} className="btn text-sm">← Back</button>
              <button
                onClick={handleTransfer}
                className="px-4 py-1.5 rounded text-sm font-medium bg-red-600/80 text-white hover:bg-red-600"
              >
                {migrate ? "Transfer & Migrate" : "Transfer & Start Fresh"}
              </button>
            </div>
          </>
        )}

        {step === "loading" && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="animate-spin text-3xl mb-3">⟳</div>
            <div className="text-sm text-text-secondary">
              {step === "loading" && !preview ? "Analyzing impact..." : "Executing transfer..."}
            </div>
          </div>
        )}

        {step === "done" && result && (
          <>
            <h2 className="text-lg font-bold text-text-primary mb-1">
              {result.status === "migrated" ? "✅ Transfer Complete" :
               result.status === "fresh_start" ? "🔄 Fresh Start" :
               "✓ Already Transferred"}
            </h2>
            <div className="bg-surface-2 rounded-lg p-4 mb-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Old name</span>
                <span className="font-mono text-text-tertiary">{result.old_name}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">New name</span>
                <span className="font-mono text-accent-green">{result.new_name}</span>
              </div>
              {result.backfilled && (
                <div className="mt-2 pt-2 border-t border-border">
                  <div className="text-xs font-mono text-text-tertiary uppercase mb-1">Backfilled</div>
                  {Object.entries(result.backfilled).map(([table, count]: [string, any]) => (
                    <div key={table} className="flex justify-between text-xs">
                      <span className="text-text-secondary">{table}</span>
                      <span className="font-mono text-text-tertiary">{count} rows</span>
                    </div>
                  ))}
                </div>
              )}
              {result.note && (
                <div className="text-xs text-text-tertiary mt-2 pt-2 border-t border-border">
                  {result.note}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <button onClick={onDone} className="px-4 py-1.5 rounded text-sm font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
