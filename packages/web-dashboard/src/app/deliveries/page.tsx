"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, API } from "@/lib/api";
import {
  Badge,
  StatCard,
  EmptyState,
  PageHeader,
} from "@/components/ui";

interface DeliveryStats {
  total: number;
  processed_ok: number;
  errors: number;
  error_rate: number;
  last_1h: number;
  last_24h: number;
  last_7d: number;
  last_30d: number;
  active_repos: number;
  events_per_hour: number;
  earliest: string;
  latest: string;
}

interface EventBreakdown {
  events: Array<{
    event_name: string;
    count: number;
    errors: number;
    last_received: string;
  }>;
}

interface TimelinePoint {
  date: string;
  total: number;
  errors: number;
  processed: number;
}

interface DeliveryRow {
  id: number;
  delivery_id: string;
  event_name: string;
  action: string | null;
  repo: string;
  processed: boolean;
  error: string | null;
  received_at: string;
}

interface DeliveryList {
  data: DeliveryRow[];
  meta: { total: number; limit: number; offset: number };
}

function MiniSparkline({ data, maxVal }: { data: number[]; maxVal: number }) {
  const w = 120;
  const h = 28;
  if (data.length === 0) return null;
  const safeMax = Math.max(maxVal, 1);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / safeMax) * h;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={w} height={h} className="inline-block">
      <polyline fill="none" stroke="#00d97e" strokeWidth="1.5" points={points} />
    </svg>
  );
}

export default function WebhooksPage() {
  const [eventFilter, setEventFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [repoFilter, setRepoFilter] = useState<string>("");

  const { data: stats } = useSWR<DeliveryStats>(
    "/api/webhooks/deliveries/stats",
    fetcher
  );

  const { data: eventBreakdown } = useSWR<EventBreakdown>(
    "/api/webhooks/deliveries/events",
    fetcher
  );

  const { data: timeline } = useSWR<{ timeline: TimelinePoint[] }>(
    "/api/webhooks/deliveries/timeline?days=14",
    fetcher
  );

  const { data: reposData } = useSWR<{ data: Array<{ full_name: string }> }>(
    "/api/repos?limit=100",
    fetcher
  );

  const repos = reposData?.data ?? [];

  const params = new URLSearchParams();
  if (eventFilter) params.set("event", eventFilter);
  if (statusFilter) params.set("status", statusFilter);
  if (repoFilter) params.set("repo", repoFilter);
  params.set("limit", "50");

  const { data: deliveries } = useSWR<DeliveryList>(
    "/api/webhooks/deliveries?" + params.toString(),
    fetcher
  );

  const s = stats ?? {
    total: 0, processed_ok: 0, errors: 0, error_rate: 0,
    last_1h: 0, last_24h: 0, last_7d: 0, events_per_hour: 0, active_repos: 0,
  };

  const deliveryRows = deliveries?.data ?? [];
  const eventList = eventBreakdown?.events ?? [];
  const timelineData = timeline?.timeline ?? [];

  // Sparkline data
  const sparklineValues = timelineData.map((t) => t.total);
  const sparklineMax = Math.max(...sparklineValues, 1);

  return (
    <div>
      <PageHeader title="Webhook Deliveries" subtitle="Track GitHub webhook events, success rates, and errors" />

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Deliveries" value={s.total} />
        <StatCard label="Last 24h" value={s.last_24h} accent="blue" />
        <StatCard label="Errors" value={s.errors} accent={s.errors > 0 ? "red" : undefined} />
        <StatCard label="Events/Hour" value={s.events_per_hour} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Timeline sparkline */}
        <div className="card md:col-span-2">
          <h3 className="text-sm font-semibold text-text-secondary mb-3">
            Delivery Volume (14 days)
          </h3>
          <div className="flex items-end gap-1 h-32">
            {timelineData.map((t) => {
              const h = Math.max((t.total / sparklineMax) * 100, 2);
              return (
                <div
                  key={t.date}
                  className="flex-1 flex flex-col items-center justify-end group relative"
                  style={{ height: "100%" }}
                >
                  <div
                    className="w-full bg-accent-green/30 hover:bg-accent-green/50 rounded-t transition-colors"
                    style={{ height: h + "%" }}
                    title={t.date + ": " + t.total + " events (" + t.errors + " errors)"}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-text-tertiary mt-1">
            {timelineData.length > 0 && (
              <>
                <span>{timelineData[0]?.date?.slice(5)}</span>
                <span>{timelineData[timelineData.length - 1]?.date?.slice(5)}</span>
              </>
            )}
          </div>
        </div>

        {/* Event breakdown */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-secondary mb-3">
            Event Types
          </h3>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {eventList.map((e) => (
              <div
                key={e.event_name}
                className="flex items-center justify-between text-xs cursor-pointer hover:bg-surface-2/40 rounded px-2 py-1 transition-colors"
                onClick={() => setEventFilter(eventFilter === e.event_name ? "" : e.event_name)}
              >
                <span className={eventFilter === e.event_name ? "text-accent-green font-medium" : "text-text-primary"}>
                  {e.event_name}
                </span>
                <div className="flex items-center gap-2">
                  {e.errors > 0 && (
                    <span className="text-red-400">{e.errors}</span>
                  )}
                  <span className="text-text-tertiary">{e.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Delivery table */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent Deliveries</h2>
          <div className="flex gap-2 items-center">
            <select
              className="bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
            >
              <option value="">All Repos</option>
              {repos.map((r) => (
                <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
              ))}
            </select>
            <button
              className={"px-2 py-1 rounded text-xs " + (statusFilter === "error" ? "bg-red-900/50 text-red-300" : "bg-gray-700 text-gray-400")}
              onClick={() => setStatusFilter(statusFilter === "error" ? "" : "error")}
            >
              Errors Only
            </button>
            {eventFilter && (
              <button
                className="px-2 py-1 rounded text-xs bg-blue-900/50 text-blue-300"
                onClick={() => setEventFilter("")}
              >
                Clear filter: {eventFilter}
              </button>
            )}
          </div>
        </div>

        {deliveryRows.length === 0 ? (
          <EmptyState title="No deliveries found" body="Webhook events will appear here once GitHub sends them" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Event</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Repo</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {deliveryRows.map((d) => (
                <tr key={d.id} className="border-b border-border/50 hover:bg-surface-2/40">
                  <td className="px-3 py-2 text-xs text-text-tertiary whitespace-nowrap">
                    {new Date(d.received_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{d.event_name}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{d.action || "\u2014"}</td>
                  <td className="px-3 py-2 text-xs">{d.repo}</td>
                  <td className="px-3 py-2">
                    {d.error ? (
                      <Badge className="bg-red-900/50 text-red-300">
                        Error
                      </Badge>
                    ) : (
                      <Badge className="bg-green-900/50 text-green-300">
                        OK
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
