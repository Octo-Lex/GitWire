# GitWire — Brand, Media & Website Asset Specification

## 1. Brand Identity

### Name
**GitWire** — one word, capital G and W.

### Tagline
> **Self-hosted AI that manages your GitHub.**

### Short Description
GitWire is a self-hosted GitHub App that uses Claude AI to triage issues, heal failing CI, review pull requests, and contribute code — all on autopilot.

### What It Is (For Press / About Pages)
GitWire is an open-source, self-hosted platform that connects to GitHub via a GitHub App and automates repository management using AI. It runs on your infrastructure — a single Docker Compose command deploys the API, dashboard, PostgreSQL, Redis, and background workers. Once installed on your repositories, GitWire watches webhooks in real-time and takes action: classifying issues, diagnosing CI failures, generating patches, reviewing PRs for security issues, and enforcing branch policies.

### What It Is NOT
- Not a SaaS product — it's self-hosted
- Not a GitHub Copilot alternative — it's GitHub *account* management, not code completion
- Not a CI runner — it *heals* CI, it doesn't run builds

---

## 2. The Eight Pillars

| # | Pillar | What It Does |
|---|--------|--------------|
| 1 | **Issue & PR Triage** | Claude classifies every new issue and PR by type, priority, and complexity. Auto-labels. |
| 2 | **Self-Healing CI** | Detects failing CI runs, diagnoses the root cause with Claude, generates a patch, opens a PR. |
| 3 | **Autonomous Contributor** | Two-pass AI pipeline: analyze issue → pick files → generate fixes → open PR. Scope-guarded. |
| 4 | **Maintainer Tools** | Stale issue/PR management, branch cleanup, `/gitwire` comment commands, scheduled scans. |
| 5 | **Multi-Repo Insights** | Fleet-wide sync across orgs, reconciliation, governance dashboards, 36-table analytics. |
| 6 | **Branch Enforcement** | Policy-as-code for branch protection, violation detection, config validation. |
| 7 | **Merge Queue** | Auto-merge queue with check gates, approval requirements, feedback rules. |
| 8 | **AI Review Gate + Audit Trail** | Pre-merge Claude review with GitHub Check Runs. Hash-chained, SOC2/ISO27001 audit trail. |

---

## 3. Color System

### Primary Palette (Existing Dashboard)

| Token | Hex | Usage |
|-------|-----|-------|
| **surface-0** | `#0A0A0B` | Page background |
| **surface-1** | `#111114` | Card background |
| **surface-2** | `#18181C` | Sidebar, elevated cards |
| **surface-3** | `#222228` | Hover states, inputs |
| **surface-4** | `#2E2E36` | Borders, dividers |
| **text-primary** | `#E8E8F0` | Headings, primary text |
| **text-secondary** | `#8E8EA0` | Descriptions, meta text |
| **text-tertiary** | `#5A5A6E` | Disabled, timestamps |
| **border** | `#2E2E36` | Default borders |
| **border-bright** | `#44444F` | Active/hover borders |

### Accent Colors (Existing Dashboard)

| Token | Hex | Usage |
|-------|-----|-------|
| **accent-green** | `#00D97E` | Primary accent, success, brand mark |
| **accent-red** | `#FF4D6A` | Errors, failures, critical findings |
| **accent-amber** | `#FFB547` | Warnings, stale items |
| **accent-blue** | `#4D9FFF` | Links, informational |
| **accent-purple** | `#A78BFA` | AI/ML indicators |
| **brand** | `#1D9E75` | Official brand green |

### Landing Page Accent (From MediaPackage)

| Token | Hex | Usage |
|-------|-----|-------|
| **Electric Orange** | `#FF6A00` | Landing page CTA, hero accents, social cards |
| **Charcoal** | `#0D0D0F` | Landing page background (matches surface-0) |

**Note:** The dashboard uses **green** (#00D97E) as primary accent. The landing page/brand materials use **Electric Orange** (#FF6A00) for differentiation and visibility. Both work on the dark charcoal background.

---

## 4. Typography

| Role | Font | Weight | Usage |
|------|------|--------|-------|
| **Display** | Syne | 700-800 | Logo wordmark, hero headlines |
| **Sans** | DM Sans | 400-600 | Body text, navigation, descriptions |
| **Mono** | JetBrains Mono | 400 | Code snippets, metrics, technical data |

All three fonts are Google Fonts / open-source.

---

## 5. Website Asset Requirements

### 5A. Logo — SVG Mark

| Property | Specification |
|----------|--------------|
| **Format** | SVG (vector) |
| **Style** | Wire/circuit aesthetic — clean lines, geometric, angular |
| **Color** | `#FF6A00` (Electric Orange) on transparent |
| **Concept** | Stylized "GW" monogram OR a Git branch/node icon that suggests connectivity + automation |
| **Constraint** | Must read clearly at 16×16 px (favicon) and scale to any size |
| **Deliverables** | `logo-mark.svg` (icon only), `logo-horizontal.svg` (mark + "GitWire" text), `logo-dark.svg` (white mark for dark BG), `logo-orange.svg` (orange mark for dark BG) |

### 5B. Favicon Set

| File | Size | Background | Content |
|------|------|------------|---------|
| `favicon-16.png` | 16×16 | Transparent | Simplified mark, 1 color (#FF6A00) |
| `favicon-32.png` | 32×32 | Transparent | Full mark detail |
| `favicon.ico` | 16+32 | Transparent | Multi-size ICO |
| `apple-touch-icon.png` | 180×180 | `#0D0D0F` (Charcoal) | Mark centered, padded 20% |
| `favicon.svg` | Vector | Transparent | SVG favicon (modern browsers) |

### 5C. Header / Navbar

| Property | Specification |
|----------|--------------|
| **Height** | 64 px (desktop), 56 px (mobile) |
| **Background** | `#0D0D0F` with 80% opacity + `backdrop-blur(12px)` |
| **Layout** | Logo (left) → Nav links (center) → GitHub star button + "Get Started" CTA (right) |
| **Logo size** | Mark: 28×28 px, Wordmark: 80×20 px |
| **Nav links** | "Features" · "Architecture" · "Docs" · "GitHub" — `#E8E8F0` text, `#FF6A00` on hover |
| **Sticky** | Yes — `position: fixed`, `z-index: 50` |
| **Mobile** | Hamburger menu, slide-out drawer from left |

### 5D. Hero Section

| Property | Specification |
|----------|--------------|
| **Min height** | 80vh (desktop), 70vh (mobile) |
| **Background** | `#0D0D0F` with subtle grid pattern at 5% opacity |
| **Grid pattern** | 40×40 px cells, `#FFFFFF` at 5% opacity |
| **Content max width** | 1200 px, centered |
| **Headline** | Syne 800, 56 px desktop / 36 px mobile, `#E8E8F0` |
| **Subheadline** | DM Sans 400, 20 px desktop / 16 px mobile, `#8E8EA0` |
| **CTA buttons** | Primary: `#FF6A00` fill, `#0D0D0F` text, 12×24 px padding. Secondary: `#2E2E36` border, `#E8E8F0` text |
| **CTA size** | Height 48 px, border-radius 8 px |

### 5E. Feature Cards (Pillars Grid)

| Property | Specification |
|----------|--------------|
| **Grid** | 2 columns desktop, 1 column mobile |
| **Card max width** | 580 px |
| **Card background** | `#111114` |
| **Card border** | 1px `#2E2E36`, border-radius 12 px |
| **Card padding** | 32 px |
| **Icon** | 40×40 px, `#FF6A00` accent |
| **Title** | DM Sans 600, 18 px, `#E8E8F0` |
| **Description** | DM Sans 400, 15 px, `#8E8EA0`, max 2 lines |
| **Hover** | Border → `#FF6A00`, subtle glow |
| **Gap** | 24 px between cards |

### 5F. Architecture Diagram Section

| Property | Specification |
|----------|--------------|
| **Background** | `#0A0A0B` (same as page) |
| **Diagram max width** | 900 px, centered |
| **Diagram format** | Inline SVG or Mermaid (rendered) |
| **Caption** | DM Sans 400, 14 px, `#5A5A6E`, centered below diagram |

### 5G. Stats / Social Proof Bar

| Property | Specification |
|----------|--------------|
| **Background** | `#111114` |
| **Height** | Auto (padding 48 px vertical) |
| **Layout** | 4 stats in a row (desktop), 2×2 grid (mobile) |
| **Stat number** | Syne 800, 40 px, `#FF6A00` |
| **Stat label** | DM Sans 400, 14 px, `#8E8EA0` |
| **Stats** | 8 Pillars · 36 DB Tables · 9 Workers · 90+ API Endpoints |

### 5H. Screenshot Gallery

| Property | Specification |
|----------|--------------|
| **Card aspect ratio** | 16:9 |
| **Card border-radius** | 8 px |
| **Card border** | 1px `#2E2E36` |
| **Screenshot max width** | 1000 px |
| **Caption** | DM Sans 400, 14 px, `#8E8EA0`, centered below |
| **Layout** | 2 columns desktop, 1 column mobile, 24 px gap |

### 5I. Footer

| Property | Specification |
|----------|--------------|
| **Background** | `#0A0A0B` |
| **Top border** | 1px `#2E2E36` |
| **Height** | Auto (padding 48 px vertical) |
| **Content max width** | 1200 px, centered |
| **Layout** | 4 columns: Brand, Navigation, Resources, Legal |
| **Logo** | Mark + "GitWire" wordmark, `#FF6A00` mark |
| **Links** | DM Sans 400, 14 px, `#8E8EA0`, `#E8E8F0` on hover |
| **Copyright** | "© 2026 Elephant Rock Lab. MIT License." — `#5A5A6E`, 13 px |
| **Social icons** | GitHub icon, 20×20 px, `#8E8EA0` → `#FF6A00` on hover |

---

## 6. Social / Open Graph Assets

### 6A. GitHub Repository Social Preview

| Property | Specification |
|----------|--------------|
| **File** | `docs/social-preview.png` |
| **Dimensions** | 1280 × 640 px |
| **Background** | `#0D0D0F` |
| **Content** | Center: Logo mark (large, ~200px) + "GitWire" wordmark below. Underneath: "Self-hosted AI that manages your GitHub." Bottom row: 8 pillar icons with labels. |
| **Typography** | Syne for logo, DM Sans for tagline |

### 6B. Twitter/X Card

| Property | Specification |
|----------|--------------|
| **Dimensions** | 1200 × 675 px |
| **Background** | `#0D0D0F` with subtle grid |
| **Content** | Same as GitHub social preview but wider aspect |

### 6C. GitHub Profile Avatar (Elephant-Rock-Lab org or GitWire specifically)

| Property | Specification |
|----------|--------------|
| **Dimensions** | 1000 × 1000 px |
| **Background** | `#0D0D0F` |
| **Content** | Logo mark centered, filling ~60% of canvas |
| **Color** | `#FF6A00` mark |

---

## 7. Icon Set Requirements

### 7A. Pillar Icons — Use `lucide-react`

All icons from [lucide.dev](https://lucide.dev) (MIT license, already installed as `lucide-react`). 2px stroke, 24×24 viewBox.

Import: `import { IconName } from 'lucide-react'`

| Pillar | Lucide Icon | Import Name |
|--------|-------------|-------------|
| Issue & PR Triage | `Tag` | `<Tag />` |
| Self-Healing CI | `Wrench` | `<Wrench />` |
| Autonomous Contributor | `Bot` | `<Bot />` |
| Maintainer Tools | `Settings` | `<Settings />` |
| Multi-Repo Insights | `BarChart3` | `<BarChart3 />` |
| Branch Enforcement | `Shield` | `<Shield />` |
| Merge Queue | `GitMerge` | `<GitMerge />` |
| AI Review Gate | `ScanSearch` | `<ScanSearch />` |

**Styling:** Default `#E8E8F0` (text-primary), accent `#FF6A00` (electric orange).
`<Tag size={20} className="text-accent-orange" />`

### 7B. UI Icons — Also `lucide-react`

| Context | Icon | Import |
|---------|------|--------|
| Dashboard nav | `LayoutGrid` | `<LayoutGrid />` |
| Repositories | `GitBranch` | `<GitBranch />` |
| Issues | `Tag` | `<Tag />` |
| Pull Requests | `GitMerge` | `<GitMerge />` |
| CI Runs | `Activity` | `<Activity />` |
| Duplicates | `Search` | `<Search />` |
| Fix Attempts | `FileCode` | `<FileCode />` |
| Automation | `Zap` | `<Zap />` |
| Trust & Policy | `ShieldCheck` | `<ShieldCheck />` |
| Intelligence | `BrainCircuit` | `<BrainCircuit />` |
| Insights | `BarChart3` | `<BarChart3 />` |
| Maintainer | `Settings` | `<Settings />` |
| GitHub link (footer/header) | `Github` | `<Github />` |
| External link | `ExternalLink` | `<ExternalLink />` |
| CTA arrow | `ArrowRight` | `<ArrowRight />` |
| Nav chevron | `ChevronRight` | `<ChevronRight />` |
| Mobile menu | `Menu` | `<Menu />` |
| Close | `X` | `<X />` |

---

## 8. File Deliverables Checklist

| File | Format | Size | Purpose |
|------|--------|------|---------|
| `logo-mark.svg` | SVG | Vector | Logo icon only |
| `logo-mark-orange.svg` | SVG | Vector | Orange variant for dark BG |
| `logo-mark-white.svg` | SVG | Vector | White variant for dark BG |
| `logo-horizontal.svg` | SVG | Vector | Mark + "GitWire" text, horizontal layout |
| `logo-horizontal-dark.svg` | SVG | Vector | Same, white text |
| `favicon.svg` | SVG | Vector | Modern browser favicon |
| `favicon.ico` | ICO | 16+32 | Legacy favicon |
| `favicon-16.png` | PNG | 16×16 | Small favicon |
| `favicon-32.png` | PNG | 32×32 | Standard favicon |
| `apple-touch-icon.png` | PNG | 180×180 | iOS home screen |
| `social-preview.png` | PNG | 1280×640 | GitHub repo social card |
| `twitter-card.png` | PNG | 1200×675 | Twitter/X preview |
| `avatar.png` | PNG | 1000×1000 | GitHub org avatar |

> **Icons:** All icons use `lucide-react` (MIT). No custom SVG icon files needed — import directly in code. Total: 20+ icons available from a single `npm install lucide-react`.

---

## 9. Landing Page Wireframe Summary

```
┌─────────────────────────────────────────────────────┐
│  HEADER (64px, sticky)                              │
│  [Logo]  Features  Architecture  Docs  [★ GitHub] [Get Started →] │
├─────────────────────────────────────────────────────┤
│                                                     │
│  HERO (80vh)                                        │
│                                                     │
│       Self-hosted AI                                │
│       that manages your GitHub.                     │
│                                                     │
│  Triage issues. Heal CI. Review PRs.                │
│  Contribute code. All on autopilot.                 │
│                                                     │
│  [Get Started]  [View on GitHub]                    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  STATS BAR                                          │
│  8 Pillars    36 Tables    9 Workers    90+ APIs    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  FEATURES (2-col grid)                              │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │ <Tag/> Triage      │  │ <Wrench/> Self-Heal │         │
│  └──────────────────┘  └──────────────────┘         │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │ <Bot/> Contributor  │  │ <Settings/> Maintainer│       │
│  └──────────────────┘  └──────────────────┘         │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │ <BarChart3/> Insights│ │ <Shield/> Enforcement│        │
│  └──────────────────┘  └──────────────────┘         │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │ <GitMerge/> Queue  │  │ <ScanSearch/> Review │        │
│  └──────────────────┘  └──────────────────┘         │
│                                                     │
├─────────────────────────────────────────────────────┤
│  ARCHITECTURE                                       │
│  [System diagram: GitHub → API → Workers → AI]      │
├─────────────────────────────────────────────────────┤
│  SCREENSHOTS (2-col gallery)                        │
│  [Dashboard]  [CI Healing]                          │
│  [AI Review]  [Audit Trail]                         │
├─────────────────────────────────────────────────────┤
│  GET STARTED (3 steps)                              │
│  1. Create GitHub App  2. docker compose up  3. Done│
├─────────────────────────────────────────────────────┤
│  FOOTER                                             │
│  [Logo]  Navigation  Resources  Legal               │
│  © 2026 Elephant Rock Lab. MIT License.             │
└─────────────────────────────────────────────────────┘
```

---

## 10. Design Rules

### Do
- Dark mode only — `#0D0D0F` or `#0A0A0B` backgrounds everywhere
- Sharp geometric lines, no rounded blobs
- High contrast: light text on dark, orange for emphasis
- Monospaced fonts for technical data (table names, API paths, code)
- Generous whitespace — 32-48 px between sections
- Consistent 8px spacing grid

### Don't
- No gradients, no glassmorphism, no soft shadows
- No stock photos of developers looking at screens
- No blue or purple as primary colors
- No rounded cartoon illustrations
- No animated hero backgrounds
