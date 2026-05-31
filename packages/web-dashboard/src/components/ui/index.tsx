"use client";

import clsx from "clsx";

// ── Badge ──────────────────────────────────────────────────────────────────
export function Badge({ children, variant = "default", className }: { children: React.ReactNode; variant?: string; className?: string }) {
  const variants: Record<string, string> = {
    default:  "bg-surface-3 text-text-secondary border border-border",
    green:    "bg-accent-green/10 text-accent-green border border-accent-green/25",
    red:      "bg-accent-red/10 text-accent-red border border-accent-red/25",
    amber:    "bg-accent-amber/10 text-accent-amber border border-accent-amber/25",
    blue:     "bg-accent-blue/10 text-accent-blue border border-accent-blue/25",
    purple:   "bg-accent-purple/10 text-accent-purple border border-accent-purple/25",
  };
  return (
    <span className={clsx("badge", variants[variant] ?? variants.default, className)}>
      {children}
    </span>
  );
}

// ── Health badge ───────────────────────────────────────────────────────────
export function HealthBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: string }> = {
    healthy:  { label: "healthy",  variant: "green"  },
    active:   { label: "active",   variant: "blue"   },
    degraded: { label: "degraded", variant: "amber"  },
    at_risk:  { label: "at risk",  variant: "red"    },
  };
  const { label, variant } = map[status] ?? { label: status, variant: "default" };
  return <Badge variant={variant}>{label}</Badge>;
}

// ── CI conclusion badge ────────────────────────────────────────────────────
export function CIBadge({ conclusion, healStatus }: { conclusion?: string; healStatus?: string }) {
  if (healStatus === "healed") return <Badge variant="purple">⚡ healed</Badge>;
  if (healStatus === "retrying") return <Badge variant="amber">↻ retrying</Badge>;
  const map: Record<string, { label: string; variant: string }> = {
    success:       { label: "passed",    variant: "green"  },
    failure:       { label: "failed",    variant: "red"    },
    cancelled:     { label: "cancelled", variant: "default"},
    skipped:       { label: "skipped",   variant: "default"},
    in_progress:   { label: "running",   variant: "blue"   },
  };
  const { label, variant } = map[conclusion ?? ""] ?? { label: conclusion ?? "unknown", variant: "default" };
  return <Badge variant={variant}>{label}</Badge>;
}

// ── Priority badge ─────────────────────────────────────────────────────────
export function PriorityBadge({ priority }: { priority?: string | null }) {
  const map: Record<string, string> = {
    critical: "red",
    high:     "amber",
    medium:   "blue",
    low:      "default",
  };
  if (!priority) return null;
  return <Badge variant={map[priority] ?? "default"}>{priority}</Badge>;
}

// ── Status dot ────────────────────────────────────────────────────────────
export function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy:  "bg-accent-green",
    active:   "bg-accent-blue",
    degraded: "bg-accent-amber",
    at_risk:  "bg-accent-red",
    success:  "bg-accent-green",
    failure:  "bg-accent-red",
    running:  "bg-accent-blue animate-pulse-dot",
  };
  return <span className={clsx("status-dot", colors[status] ?? "bg-text-tertiary")} />;
}

// ── Skeleton loader (shimmer effect) ────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={clsx("rounded shimmer", className)} />
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
export function EmptyState({ icon = "\u25CE", title, body }: { icon?: string; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="text-3xl text-text-tertiary mb-3 font-mono">{icon}</span>
      <div className="text-text-secondary font-medium mb-1">{title}</div>
      {body && <div className="text-text-tertiary text-sm">{body}</div>}
    </div>
  );
}

// ── Page header ────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-border">
      <div>
        <h1 className="font-display text-xl font-bold text-text-primary tracking-tight">{title}</h1>
        {subtitle && <p className="text-text-secondary text-sm mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Stat card with optional sparkline trend ────────────────────────────────
export function StatCard({ label, value, sub, accent, loading, trend }: { label: string; value?: string | number | null; sub?: string; accent?: string; loading?: boolean; trend?: number[] }) {
  const accentColor: Record<string, string> = {
    green:  "text-accent-green",
    red:    "text-accent-red",
    amber:  "text-accent-amber",
    blue:   "text-accent-blue",
    purple: "text-accent-purple",
  };

  return (
    <div className="card p-4 animate-slide-up">
      <div className="text-xs text-text-tertiary font-mono uppercase tracking-wider mb-2">{label}</div>
      {loading ? (
        <Skeleton className="h-8 w-20 mb-1" />
      ) : (
        <div className="flex items-end gap-2">
          <div className={clsx("text-3xl font-display font-bold tabular-nums", accent ? accentColor[accent] ?? "text-text-primary" : "text-text-primary")}>
            {value ?? "\u2014"}
          </div>
          {trend && trend.length >= 2 && <Sparkline data={trend} width={48} height={20} />}
        </div>
      )}
      {sub && <div className="text-xs text-text-tertiary mt-1">{sub}</div>}
    </div>
  );
}

// ── Sparkline (inline SVG trend) ───────────────────────────────────────────
function Sparkline({ data, width = 48, height = 20 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const points = data.map(function (v, i) {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((v - min) / range) * h;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");

  // Determine if trend is up or down
  const firstHalf = data.slice(0, Math.ceil(data.length / 2));
  const secondHalf = data.slice(Math.ceil(data.length / 2));
  const avgFirst = firstHalf.reduce(function (a, b) { return a + b; }, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce(function (a, b) { return a + b; }, 0) / secondHalf.length;
  const isUp = avgSecond >= avgFirst;
  const color = isUp ? "#00d97e" : "#ff4d6a";

  return (
    <svg width={width} height={height} className="shrink-0 self-center mb-1">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Mini bar (CI pass rate inline) ────────────────────────────────────────
export function MiniBar({ value, max = 100 }: { value?: number | null; max?: number }) {
  const pct = Math.min(100, Math.max(0, Number(value ?? 0)));
  const color = pct >= 90 ? "bg-accent-green" : pct >= 70 ? "bg-accent-amber" : "bg-accent-red";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-surface-3 rounded-full overflow-hidden">
        <div className={clsx("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs text-text-secondary w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Filter pill ───────────────────────────────────────────────────────────
export function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "px-3 py-1 text-xs font-mono rounded border transition-all",
        active
          ? "bg-accent-green/15 border-accent-green/40 text-accent-green"
          : "bg-surface-2 border-border text-text-secondary hover:text-text-primary hover:border-border-bright"
      )}
    >
      {children}
    </button>
  );
}
