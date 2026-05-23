"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV = [
  { href: "/",              label: "Dashboard",       icon: "◈" },
  { href: "/repos",         label: "Repositories",    icon: "⎇" },
  { href: "/issues",        label: "Issues",          icon: "◎" },
  { href: "/pull-requests", label: "Pull Requests",   icon: "⌥" },
  { href: "/duplicates",    label: "Duplicates",      icon: "⊗" },
  { href: "/ci",            label: "Self-Healing CI",  icon: "⚙" },
  { href: "/automation",    label: "Automation",      icon: "⌘" },
  { href: "/trust",         label: "Trust & Policy",  icon: "🛡" },
  { href: "/insights",      label: "Insights",        icon: "◈" },
  { href: "/maintainer",    label: "Maintainer",      icon: "⟳" },
  { href: "/fix-attempts",  label: "Fix Attempts",    icon: "⚡" },
  { href: "/intelligence", label: "Intelligence",     icon: "\uD83E\uDDE0" },
  { href: "/config",       label: "Config",           icon: "\u2699" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-surface-0 flex flex-col">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-border">
        <Link href="/" className="flex items-center gap-2.5 group">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00d97e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:opacity-80 transition-opacity">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
          </svg>
          <span className="font-display text-base font-bold text-text-primary tracking-tight">GitWire</span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-2.5 px-3 py-2 rounded text-sm font-medium transition-colors",
                active
                  ? "bg-accent-green/10 text-accent-green"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-2"
              )}
            >
              <span className="text-base font-mono w-5 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border">
        <div className="text-[10px] font-mono text-text-tertiary">
          GitWire v0.1
        </div>
      </div>
    </aside>
  );
}
