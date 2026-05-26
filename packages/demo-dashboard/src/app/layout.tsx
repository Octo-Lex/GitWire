import Sidebar from "@/components/Sidebar";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>GitWire Demo — Governance for GitHub Automation</title>
        <meta name="description" content="Self-hosted AI that decides, executes, and proves GitHub operations." />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>◈</text></svg>" />
      </head>
      <body className="bg-surface-0 text-text-primary antialiased">
        <Sidebar />
        <main className="ml-56 min-h-screen">{children}</main>
        <div className="fixed bottom-0 left-56 right-0 bg-surface-0/80 backdrop-blur border-t border-border px-6 py-2 z-50">
          <p className="text-xs text-text-tertiary text-center">
            🎭 <strong>Demo Dashboard</strong> — All data is fictional. No real repositories or events.{" "}
            <a href="https://github.com/Elephant-Rock-Lab/GitWire" target="_blank" className="text-accent-green hover:underline">View on GitHub →</a>
          </p>
        </div>
      </body>
    </html>
  );
}
