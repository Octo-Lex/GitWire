"use client";

import { ApiItem } from "@/lib/types";

import { useState } from "react";
import useSWR from "swr";

import Link from "next/link";
import { fetcher, API, triggerRepoSync } from "@/lib/api";
import {
  PageHeader, StatCard, Badge, HealthBadge, MiniBar,
  Skeleton, EmptyState, FilterPill,
} from "@/components/ui";
import TransferModal from "@/components/TransferModal";
import { formatDistanceToNow } from "date-fns";

const LANGS = ["All", "TypeScript", "JavaScript", "Python", "Go", "Rust", "Java"];

export default function ReposPage() {
  const [search, setSearch] = useState("");
  const [lang, setLang] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [transferRepo, setTransferRepo] = useState<string | null>(null);

  const qs = new URLSearchParams({ per_page: "20", page: String(page) });
  if (search) qs.set("search", search);
  if (lang && lang !== "All") qs.set("language", lang);

  const { data, isLoading, mutate } = useSWR(API.repos(qs.toString()), fetcher, {
    refreshInterval: 30000,
    keepPreviousData: true,
  });

  const repos = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function handleSync(owner: string, name: string) {
    const key = `${owner}/${name}`;
    setSyncing((s) => ({ ...s, [key]: true }));
    try {
      await triggerRepoSync(owner, name);
      setTimeout(() => mutate(), 3000);
    } finally {
      setSyncing((s) => ({ ...s, [key]: false }));
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Repositories"
        subtitle={meta.total != null ? `${meta.total} repositories` : ""}
        actions={
          <input
            type="search"
            placeholder="Search repos…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="bg-surface-2 border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-green/60 w-52 font-mono"
          />
        }
      />

      {/* Language filter */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border overflow-x-auto">
        {LANGS.map((l) => (
          <FilterPill
            key={l}
            active={lang === l || (l === "All" && !lang)}
            onClick={() => { setLang(l === "All" ? "" : l); setPage(1); }}
          >
            {l}
          </FilterPill>
        ))}
      </div>

      {/* Table */}
      <div className="px-6 py-4">
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Repository</th>
                  <th className="text-left px-4 py-2.5 font-medium">Lang</th>
                  <th className="text-right px-4 py-2.5 font-medium">★</th>
                  <th className="text-right px-4 py-2.5 font-medium">Issues</th>
                  <th className="text-right px-4 py-2.5 font-medium">PRs</th>
                  <th className="text-left px-4 py-2.5 font-medium w-40">CI pass rate</th>
                  <th className="text-left px-4 py-2.5 font-medium">Health</th>
                  <th className="text-left px-4 py-2.5 font-medium">Last synced</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {isLoading && [...Array(8)].map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {[...Array(9)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))}
                {!isLoading && !repos.length && (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState icon="⎇" title="No repositories found" body="Try adjusting your search or language filter." />
                    </td>
                  </tr>
                )}
                {repos.map((repo: ApiItem) => {
                  const syncKey = String(repo.full_name);
                  return (
                    <tr key={String(repo.github_id)} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors group">
                      <td className="px-4 py-3">
                        <div className="font-mono text-sm text-text-primary font-medium">{String(repo.full_name)}</div>
                        <div className="text-xs text-text-tertiary mt-0.5 font-mono">{String(repo.default_branch ?? "")}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-tertiary">{String(repo.language ?? "—")}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{String(repo.stars ?? 0)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/issues?repo=${String(repo.full_name)}`} className="font-mono text-xs text-text-secondary hover:text-accent-green">
                          {String(repo.open_issues ?? 0)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/pull-requests?repo=${String(repo.full_name)}`} className="font-mono text-xs text-text-secondary hover:text-accent-green">
                          {String(repo.open_prs ?? 0)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 w-40">
                        <MiniBar value={Number(repo.ci_pass_rate)} />
                      </td>
                      <td className="px-4 py-3">
                        <HealthBadge status={String(repo.health_status ?? "active")} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">
                        {repo.last_synced_at
                          ? formatDistanceToNow(new Date(String(repo.last_synced_at)), { addSuffix: true })
                          : "never"}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => setTransferRepo(String(repo.full_name))}
                          className="btn text-xs opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                        >
                          ⇗ Transfer
                        </button>
                        <button
                          onClick={() => handleSync(String(repo.owner), String(repo.name))}
                          disabled={syncing[syncKey]}
                          className="btn text-xs opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                        >
                          {syncing[syncKey] ? "↻ syncing…" : "↻ sync"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary font-mono">
                Page {meta.page} of {meta.total_pages} · {meta.total} repos
              </span>
              <div className="flex gap-2">
                <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← prev</button>
                <button className="btn text-xs" disabled={page >= meta.total_pages} onClick={() => setPage((p) => p + 1)}>next →</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Transfer modal */}
      {transferRepo && (
        <TransferModal
          repoFullName={transferRepo}
          onClose={() => setTransferRepo(null)}
          onDone={() => { setTransferRepo(null); mutate(); }}
        />
      )}
    </div>
  );
}
