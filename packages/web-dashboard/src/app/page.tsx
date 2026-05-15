import { api } from "@/lib/api";
import InsightsPanel from "@/components/InsightsPanel";
import TriagePanel from "@/components/TriagePanel";
import CIHealingPanel from "@/components/CIHealingPanel";
import ReposPanel from "@/components/ReposPanel";

export const revalidate = 30; // revalidate every 30s

export default async function Dashboard() {
  const [overview, reposData, issuesData, ciStats] = await Promise.all([
    api.insightsOverview(),
    api.repos(),
    api.issues(),
    api.ciStats().catch(() => null),
  ]);

  const repos = reposData.data || [];
  const issues = issuesData.data || [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Panel 1: Multi-Repo Insights */}
      <div className="lg:col-span-2">
        <InsightsPanel overview={overview} repos={repos} />
      </div>

      {/* Panel 2: Issue & PR Triage */}
      <TriagePanel issues={issues} />

      {/* Panel 3: Self-Healing CI */}
      <CIHealingPanel ciStats={ciStats} />

      {/* Panel 4: Maintainer / Repos */}
      <ReposPanel repos={repos} />
    </div>
  );
}
