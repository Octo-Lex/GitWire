"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { title: "Overview", items: [
    { href: "/", label: "Dashboard", icon: "◈" },
    { href: "/repos", label: "Repositories", icon: "⎇" },
    { href: "/readiness", label: "Readiness", icon: "✓" },
    { href: "/activity", label: "Activity", icon: "⏱" },
  ]},
  { title: "Work", items: [
    { href: "/issues", label: "Issues", icon: "◎" },
    { href: "/pull-requests", label: "Pull Requests", icon: "⌥" },
    { href: "/ci", label: "CI Healing", icon: "⚕" },
    { href: "/fix-attempts", label: "Fix Attempts", icon: "🔧" },
    { href: "/duplicates", label: "Duplicates", icon: "⊗" },
  ]},
  { title: "Governance", items: [
    { href: "/actions", label: "Actions", icon: "▶" },
    { href: "/decisions", label: "Decisions", icon: "⚖" },
    { href: "/gates", label: "Quality Gates", icon: "🛡" },
    { href: "/deliveries", label: "Deliveries", icon: "🔗" },
  ]},
  { title: "Config", items: [
    { href: "/custom-rules", label: "Custom Rules", icon: "⚡" },
    { href: "/trust", label: "Trust & Policy", icon: "📜" },
  ]},
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed top-0 left-0 w-56 h-screen bg-surface-0 border-r border-border flex flex-col z-40">
      <div className="px-5 py-4 border-b border-border">
        <Link href="/" className="flex items-center gap-2.5 group">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00d97e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:opacity-80 transition-opacity">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
          </svg>
          <span className="font-display text-base font-bold text-text-primary tracking-tight">GitWire</span>
        </Link>
      </div>

      <nav className="flex-1 py-2 px-3 overflow-y-auto">
        {NAV.map((group, gi) => (
          <div key={group.title} className={gi > 0 ? "mt-3" : ""}>
            <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-text-tertiary">
              {group.title}
            </div>
            {group.items.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors mb-0.5 ${
                    active
                      ? "bg-accent-green/10 text-accent-green font-medium"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-2/60"
                  }`}
                >
                  <span className="text-base leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="px-5 py-3 border-t border-border">
        <div className="text-[10px] font-mono text-text-tertiary">
          GitWire v0.12.0 · Demo
        </div>
      </div>
    </aside>
  );
}
