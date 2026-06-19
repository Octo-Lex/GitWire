"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  DashboardIcon,
  ReposIcon,
  ReadinessIcon,
  ActivityIcon,
  IssuesIcon,
  PullRequestsIcon,
  CIHealingIcon,
  FixAttemptsIcon,
  DuplicatesIcon,
  ActionsIcon,
  DecisionsIcon,
  QualityGatesIcon,
  CustomRulesIcon,
  WaiversIcon,
  DryRunProofIcon,
  DeliveriesIcon,
  MaintainerIcon,
  AutomationIcon,
  TrustPolicyIcon,
  InsightsIcon,
  IntelligenceIcon,
  ConfigIcon,
  PlaygroundIcon,
} from "./Icons";

interface NavItem {
  href: string;
  label: string;
  icon: React.FC<{ size?: number }>;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { href: "/",              label: "Dashboard",      icon: DashboardIcon },
      { href: "/repos",         label: "Repositories",   icon: ReposIcon },
      { href: "/readiness",     label: "Readiness",      icon: ReadinessIcon },
      { href: "/activity",      label: "Activity",       icon: ActivityIcon },
    ],
  },
  {
    title: "Work",
    items: [
      { href: "/issues",        label: "Issues",         icon: IssuesIcon },
      { href: "/pull-requests", label: "Pull Requests",  icon: PullRequestsIcon },
      { href: "/ci",            label: "CI Healing",     icon: CIHealingIcon },
      { href: "/fix-attempts",  label: "Fix Attempts",   icon: FixAttemptsIcon },
      { href: "/duplicates",    label: "Duplicates",     icon: DuplicatesIcon },
    ],
  },
  {
    title: "Governance",
    items: [
      { href: "/actions",       label: "Actions",        icon: ActionsIcon },
      { href: "/decisions",     label: "Decisions",      icon: DecisionsIcon },
      { href: "/gates",         label: "Quality Gates",  icon: QualityGatesIcon },
      { href: "/custom-rules",  label: "Custom Rules",   icon: CustomRulesIcon },
      { href: "/waivers",       label: "Waivers",        icon: WaiversIcon },
      { href: "/dry-run",       label: "Dry-Run Proof", icon: DryRunProofIcon },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/deliveries",    label: "Deliveries",     icon: DeliveriesIcon },
      { href: "/maintainer",    label: "Maintainer",     icon: MaintainerIcon },
      { href: "/automation",    label: "Automation",     icon: AutomationIcon },
      { href: "/trust",         label: "Trust & Policy", icon: TrustPolicyIcon },
      { href: "/insights",      label: "Insights",       icon: InsightsIcon },
      { href: "/intelligence",  label: "Intelligence",   icon: IntelligenceIcon },
    ],
  },
  {
    title: "Config",
    items: [
      { href: "/config",        label: "Config",         icon: ConfigIcon },
      { href: "/config/playground", label: "Playground", icon: PlaygroundIcon },
      { href: "/policy-preview", label: "Policy Preview", icon: DryRunProofIcon },
      { href: "/rollouts", label: "Rollouts", icon: DryRunProofIcon },
    ],
  },
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
      <nav className="flex-1 py-2 px-3 overflow-y-auto">
        {NAV.map((group, gi) => (
          <div key={group.title} className={gi > 0 ? "mt-3" : ""}>
            <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-text-tertiary">
              {group.title}
            </div>
            {group.items.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname === item.href || (pathname.startsWith(item.href + "/"));
              const IconComp = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "flex items-center gap-2.5 px-3 py-1.5 rounded text-sm font-medium transition-all duration-150",
                    active
                      ? "bg-accent-green/10 text-accent-green border-l-2 border-l-accent-green pl-[10px]"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-2 border-l-2 border-l-transparent"
                  )}
                >
                  <span className="flex items-center justify-center w-5">
                    <IconComp size={18} />
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border">
        <div className="text-[10px] font-mono text-text-tertiary">
          GitWire v0.12.0
        </div>
      </div>
    </aside>
  );
}
