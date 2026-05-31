"use client";

// GitWire icon set — Phosphor Icons (regular weight)
// Consistent rendering across all platforms (replaces Unicode symbols)

import {
  SquaresFour,
  FolderSimple,
  ShieldCheck,
  ClockCounterClockwise,
  WarningCircle,
  GitPullRequest,
  Wrench,
  FirstAidKit,
  Copy,
  PlayCircle,
  Scales,
  ShieldCheckered,
  Lightning,
  Ticket,
  Inbox,
  ArrowsClockwise,
  GearSix,
  Scroll,
  ChartBar,
  Brain,
  SlidersHorizontal,
  Flask,
  Activity,
} from "@phosphor-icons/react";

import type { IconProps } from "@phosphor-icons/react";

type IconSize = 16 | 18 | 20;

const defaultSize: IconSize = 18;

function icon(Comp: React.ForwardRefExoticComponent<IconProps & React.RefAttributes<unknown>>, label: string) {
  return function GitWireIcon({ size = defaultSize }: { size?: IconSize }) {
    return <Comp size={size} weight="regular" aria-label={label} />;
  };
}

// ── Sidebar icons ─────────────────────────────────────────────────────────

export const DashboardIcon   = icon(SquaresFour,          "Dashboard");
export const ReposIcon       = icon(FolderSimple,         "Repositories");
export const ReadinessIcon   = icon(ShieldCheck,          "Readiness");
export const ActivityIcon    = icon(Activity,             "Activity");
export const IssuesIcon      = icon(WarningCircle,        "Issues");
export const PullRequestsIcon = icon(GitPullRequest,      "Pull Requests");
export const CIHealingIcon   = icon(Wrench,               "CI Healing");
export const FixAttemptsIcon = icon(FirstAidKit,          "Fix Attempts");
export const DuplicatesIcon  = icon(Copy,                 "Duplicates");
export const ActionsIcon     = icon(PlayCircle,           "Actions");
export const DecisionsIcon   = icon(Scales,               "Decisions");
export const QualityGatesIcon = icon(ShieldCheckered,     "Quality Gates");
export const CustomRulesIcon = icon(Lightning,            "Custom Rules");
export const WaiversIcon     = icon(Ticket,               "Waivers");
export const DeliveriesIcon  = icon(Inbox,                "Deliveries");
export const MaintainerIcon  = icon(ArrowsClockwise,      "Maintainer");
export const AutomationIcon  = icon(GearSix,              "Automation");
export const TrustPolicyIcon = icon(Scroll,               "Trust & Policy");
export const InsightsIcon    = icon(ChartBar,             "Insights");
export const IntelligenceIcon = icon(Brain,               "Intelligence");
export const ConfigIcon      = icon(SlidersHorizontal,    "Config");
export const PlaygroundIcon  = icon(Flask,                "Playground");

// ── Status / misc icons ───────────────────────────────────────────────────

export const LiveDot = icon(Activity, "Live");
export const ClockIcon = icon(ClockCounterClockwise, "Time");
