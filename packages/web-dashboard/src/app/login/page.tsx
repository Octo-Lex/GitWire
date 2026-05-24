"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }

      // Redirect to dashboard
      window.location.href = "/";
    } catch (_e) {
      setError("Network error");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0">
      <div className="w-full max-w-sm mx-4">
        <div className="card p-8">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00d97e"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            <span className="font-display text-xl font-bold text-text-primary tracking-tight">
              GitWire
            </span>
          </div>

          <h1 className="text-lg font-semibold text-text-primary text-center mb-1">
            Dashboard Login
          </h1>
          <p className="text-sm text-text-secondary text-center mb-6">
            Enter your API key to continue
          </p>

          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label
                htmlFor="password"
                className="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-2"
              >
                API Key
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter API key..."
                className="w-full px-3 py-2.5 rounded bg-gray-800 border border-border text-text-primary text-sm placeholder:text-text-tertiary focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green/30 transition-colors"
                autoFocus
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="mb-4 px-3 py-2 rounded bg-red-900/30 border border-red-800/50 text-red-300 text-xs">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2.5 rounded bg-accent-green text-gray-900 font-semibold text-sm hover:bg-accent-green/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="text-[11px] text-text-tertiary text-center mt-6">
            Self-hosted GitHub automation governance
          </p>
        </div>
      </div>
    </div>
  );
}
