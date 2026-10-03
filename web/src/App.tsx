import React, { useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { api } from './api/client.js';
import { fmtTime } from './lib/format.js';
import { ConfirmButton } from './components/ConfirmButton.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { StatsPage } from './pages/StatsPage.js';
import { GithubPage } from './pages/GithubPage.js';
import { IssuePage } from './pages/IssuePage.js';
import { ConsolePage } from './pages/ConsolePage.js';
import { useStore } from './store/useStore.js';
import { T } from './i18n/fr.js';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto mt-16 max-w-xl rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <div className="font-semibold">Erreur d'affichage</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button className="btn-ghost mt-4" onClick={() => location.reload()}>
            Recharger
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  const connected = useStore((s) => s.connected);
  const quota = useStore((s) => s.quota);
  const setQuota = useStore((s) => s.setQuota);
  // SSE only runs on Dashboard/Project pages — seed the quota so the global buttons work everywhere.
  useEffect(() => {
    void api.quota().then(setQuota).catch(() => undefined);
  }, [setQuota]);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight text-indigo-400">⚡ {T.appName}</span>
            <span className="hidden text-xs text-zinc-500 sm:inline">{T.tagline}</span>
          </Link>
          <nav className="ml-auto flex items-center gap-3 text-sm">
            {quota?.scheduledCut && (
              <span
                className="hidden text-xs text-indigo-300 sm:inline"
                title={T.cutScheduled(new Date(quota.scheduledCut.targetAt).toLocaleString('fr-FR'))}
              >
                ✂ {fmtTime(quota.scheduledCut.targetAt)}
              </span>
            )}
            {quota?.globalPaused ? (
              <>
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                  {T.globalPausedPill}
                </span>
                <button
                  className="btn-primary !px-2.5 !py-1 text-xs"
                  onClick={() => void api.resumeAll().then(() => api.quota().then(setQuota)).catch(() => undefined)}
                >
                  {T.resumeAll}
                </button>
              </>
            ) : (
              <ConfirmButton
                label={T.pauseAll}
                confirmLabel={T.pauseAllConfirm}
                className="btn-ghost !px-2.5 !py-1 text-xs"
                onConfirm={() => void api.pauseAll().then(() => api.quota().then(setQuota)).catch(() => undefined)}
              />
            )}
            <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-amber-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`} />
              {connected ? T.connected : T.disconnected}
            </span>
            <Link to="/github" className="text-zinc-400 hover:text-zinc-100">
              🐙 {T.github}
            </Link>
            <Link to="/console" className="text-zinc-400 hover:text-zinc-100">
              ⌨ {T.console}
            </Link>
            <Link to="/stats" className="text-zinc-400 hover:text-zinc-100">
              📊 {T.stats}
            </Link>
            <Link to="/settings" className="text-zinc-400 hover:text-zinc-100">
              ⚙ {T.settings}
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/issues/:issueId" element={<IssuePage />} />
            <Route path="/github" element={<GithubPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/console" element={<ConsolePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </ErrorBoundary>
      </Shell>
    </BrowserRouter>
  );
}
