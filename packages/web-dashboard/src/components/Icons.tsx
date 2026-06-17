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
  EnvelopeSimple,
  ArrowsClockwise,
  GearSix,
  Scroll,
  ChartBar,
  Brain,
  SlidersHorizontal,
  Flask,
  Pulse,
  Eye,
} from "@phosphor-icons/react";

import type { IconProps } from "@phosphor-icons/react";

interface GitWireIconProps {
  size?: number;
}

function icon(Comp: React.ForwardRefExoticComponent<IconProps & React.RefAttributes<unknown>>, label: string): React.FC<GitWireIconProps> {
  return function GitWireIcon({ size = 18 }: GitWireIconProps) {
    return <Comp size={size} weight="regular" aria-label={label} />;
  };
}

// ── Sidebar icons ─────────────────────────────────────────────────────────

export const DashboardIcon   = icon(SquaresFour,          "Dashboard");
export const ReposIcon       = icon(FolderSimple,         "Repositories");
export const ReadinessIcon   = icon(ShieldCheck,          "Readiness");
export const ActivityIcon    = icon(Pulse,                "Activity");
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
export const DeliveriesIcon  = icon(EnvelopeSimple,       "Deliveries");
export const MaintainerIcon  = icon(ArrowsClockwise,      "Maintainer");
export const AutomationIcon  = icon(GearSix,              "Automation");
export const TrustPolicyIcon = icon(Scroll,               "Trust & Policy");
export const InsightsIcon    = icon(ChartBar,             "Insights");
export const IntelligenceIcon = icon(Brain,               "Intelligence");
export const ConfigIcon      = icon(SlidersHorizontal,    "Config");
export const PlaygroundIcon  = icon(Flask,                "Playground");
export const DryRunProofIcon = icon(Eye,                   "Dry-Run Proof");

// ── Status / misc icons ───────────────────────────────────────────────────

export const LiveDot = icon(Pulse, "Live");
export const ClockIcon = icon(ClockCounterClockwise, "Time");
