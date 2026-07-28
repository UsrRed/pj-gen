import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GithubRepoView, GithubStatusDto, IssueDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Spinner } from '../components/ConfirmButton.js';
import { T } from '../i18n/fr.js';
import { DECISION_STYLE } from '../components/badges.js';

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.getElementById('pjgen-gh-setup-cmd');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs opacity-80">{T.ghSetupHint}</p>
      <div className="relative">
        <pre id="pjgen-gh-setup-cmd" className="max-w-full select-all overflow-x-auto rounded bg-zinc-950 px-3 py-2 pr-20 font-mono text-xs leading-relaxed text-zinc-300">
          {command}
        </pre>
        <button className="btn-ghost !absolute !right-1.5 !top-1.5 !px-2 !py-0.5 !text-xs" onClick={() => void copy()}>
          {copied ? T.copied : `📋 ${T.ghCopyCmd}`}
        </button>
      </div>
    </div>
  );
}

function LinkedRepoCard({ repo, onAction, busy }: { repo: GithubRepoView; onAction: (name: string, fn: () => Promise<unknown>) => void; busy: string | null }) {
  const [message, setMessage] = useState('');
  const stable = repo.projectStatus !== 'building' && repo.projectStatus !== 'deploying';
  const sync =
    repo.ahead === null || repo.ahead === undefined
      ? T.ghSyncUnknown
      : repo.ahead === 0 && (repo.behind ?? 0) === 0
        ? T.ghUpToDate
        : [repo.ahead > 0 ? T.ghAhead(repo.ahead) : '', (repo.behind ?? 0) > 0 ? T.ghBehind(repo.behind!) : ''].filter(Boolean).join(' · ');
  const key = repo.projectId!;
  return (
    <div className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/projects/${repo.projectId}`} className="font-semibold text-zinc-100 hover:text-indigo-300">
          {repo.title}
        </Link>
        {repo.projectStatus && <StatusBadge status={repo.projectStatus} />}
        <a href={repo.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-zinc-500 underline hover:text-zinc-300">
          {repo.nameWithOwner}
        </a>
        <span className="text-xs text-zinc-600">{repo.visibility?.toLowerCase()}</span>
        <span className={`ml-auto text-xs ${repo.ahead ? 'text-amber-300' : 'text-zinc-500'}`}>{sync}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input !w-72 text-xs"
          placeholder={T.ghPushMessage}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={!stable}
        />
        <button
          className="btn-ghost text-xs"
          disabled={!stable || busy !== null}
          title={stable ? undefined : T.ghBusy}
          onClick={() => onAction(`push:${key}`, () => api.githubPush(key, message.trim() || undefined).then(() => setMessage('')))}
        >
          {busy === `push:${key}` ? <Spinner /> : '⬆'} {T.ghPushBtn}
        </button>
        <button
          className="btn-ghost text-xs"
          disabled={!stable || busy !== null}
          title={T.ghGenerateCiHint}
          onClick={() => onAction(`ci:${key}`, () => api.githubGenerateCi(key))}
        >
          {busy === `ci:${key}` ? <Spinner /> : '🔁'} {T.ghGenerateCi}
        </button>
        <label
          className={`ml-auto flex items-center gap-1.5 text-xs ${repo.visibility?.toLowerCase() === 'private' ? 'text-zinc-300' : 'text-zinc-600'}`}
          title={repo.visibility?.toLowerCase() === 'private' ? T.ghAutoModeHint : T.ghAutoModePublic}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={repo.autoMode ?? false}
            disabled={repo.visibility?.toLowerCase() !== 'private' || busy !== null}
            onChange={(e) => onAction(`auto:${key}`, () => api.githubAutoMode(key, e.target.checked))}
          />
          🤖 {T.ghAutoMode}
        </label>
      </div>
    </div>
  );
}

function IssuesSection({ issues, onDecision, busy }: { issues: IssueDto[]; onDecision: (id: number, d: 'skipped' | 'queued') => void; busy: string | null }) {
  if (!issues.length) return <p className="text-sm text-zinc-500">{T.ghNoIssues}</p>;
  return (
    <div className="space-y-1.5">
      {issues.map((i) => (
        <div key={i.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
          <span className="shrink-0 font-mono text-zinc-500">#{i.number}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${DECISION_STYLE[i.decision]}`}>{T.ghIssueDecision[i.decision]}</span>
          {i.ghState === 'closed' && <span className="shrink-0 text-zinc-600">(fermée)</span>}
          <span className="truncate text-zinc-300" title={i.body}>
            {i.title}
          </span>
          <span className="shrink-0 text-zinc-600">@{i.author}</span>
          {['fixing', 'ci_running', 'fixed', 'failed', 'needs_clarification'].includes(i.decision) && (
            <Link to={`/projects/${i.projectId}/issues/${i.id}`} className="btn-ghost !px-2 !py-0.5 text-xs">
              📋 {T.issueTrack}
            </Link>
          )}
          {(i.decision === 'pending' || i.decision === 'skipped' || i.decision === 'failed') && i.ghState === 'open' && (
            <button className="btn-ghost !px-2 !py-0.5 text-xs" disabled={busy !== null} onClick={() => onDecision(i.id, 'queued')}>
              ▶ {T.ghIssueDo}
            </button>
          )}
          {i.decision === 'pending' && (
            <button className="btn-ghost !px-2 !py-0.5 text-xs !text-zinc-500" disabled={busy !== null} onClick={() => onDecision(i.id, 'skipped')}>
              ✕ {T.ghIssueSkip}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function GithubPage() {
  const [status, setStatus] = useState<GithubStatusDto | null>(null);
  const [repos, setRepos] = useState<GithubRepoView[] | null>(null);
  const [issues, setIssues] = useState<IssueDto[]>([]);
  const [trusted, setTrusted] = useState<string[]>([]);
  const [newTrusted, setNewTrusted] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    void Promise.all([api.githubRepos(), api.issues().catch(() => ({ issues: [] })), api.trustedUsers().catch(() => ({ users: [] }))])
      .then(([r, i, t]) => {
        setStatus(r.status);
        setRepos(r.repos);
        setIssues(i.issues);
        setTrusted(t.users);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (name: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    void fn()
      .then(() => refresh())
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const decide = (id: number, decision: 'skipped' | 'queued') =>
    act(`issue:${id}`, () => api.issueDecision(id, decision).then((updated) => setIssues((list) => list.map((i) => (i.id === updated.id ? updated : i)))));

  if (loading && !repos) return <div className="p-10 text-center text-zinc-500">{T.loading}</div>;

  const linked = (repos ?? []).filter((r) => r.category === 'linked');
  const unpublished = (repos ?? []).filter((r) => r.category === 'local_unpublished');
  const remoteOnly = (repos ?? []).filter((r) => r.category === 'remote_only');
  const issuesByProject = new Map<string, IssueDto[]>();
  for (const i of issues) issuesByProject.set(i.projectId, [...(issuesByProject.get(i.projectId) ?? []), i]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">🐙 {T.ghTitle}</h1>
        {status?.authOk && status.login && <span className="text-xs text-emerald-400">{T.ghConnectedAs(status.login)}</span>}
        <button className="btn-ghost ml-auto text-xs" onClick={refresh} disabled={loading}>
          {loading ? <Spinner /> : '↻'} {T.ghRefresh}
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">{error}</div>}

      {status && !status.authOk && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {status.installed ? T.ghNotAuth : T.ghNotInstalled}
          {status.detail && <div className="mt-1 text-xs opacity-70">{status.detail}</div>}
          <CommandBlock command={status.installed ? T.ghSetupAuthCmd : T.ghSetupInstallCmd} />
        </div>
      )}

      {status?.authOk && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-300">{T.ghLinked}</h2>
            {linked.length ? (
              linked.map((r) => (
                <div key={r.projectId} className="space-y-2">
                  <LinkedRepoCard repo={r} onAction={act} busy={busy} />
                  {(issuesByProject.get(r.projectId!) ?? []).length > 0 && (
                    <div className="ml-4">
                      <h3 className="mb-1 text-xs font-semibold text-zinc-500">{T.ghIssues}</h3>
                      <IssuesSection issues={issuesByProject.get(r.projectId!) ?? []} onDecision={decide} busy={busy} />
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm text-zinc-500">—</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-300">{T.ghLocalUnpublished}</h2>
            {unpublished.length ? (
              unpublished.map((r) => (
                <div key={r.projectId} className="card flex flex-wrap items-center gap-2 p-4">
                  <Link to={`/projects/${r.projectId}`} className="font-semibold text-zinc-100 hover:text-indigo-300">
                    {r.title}
                  </Link>
                  {r.projectStatus && <StatusBadge status={r.projectStatus} />}
                  <span className="font-mono text-xs text-zinc-600">{r.slug}</span>
                  <button
                    className="btn-primary ml-auto text-xs"
                    disabled={busy !== null || r.projectStatus === 'building' || r.projectStatus === 'deploying'}
                    title={r.projectStatus === 'building' ? T.ghBusy : undefined}
                    onClick={() => act(`link:${r.projectId}`, () => api.githubLink(r.projectId!))}
                  >
                    {busy === `link:${r.projectId}` ? <Spinner /> : '🔒'} {T.ghPublishPrivate}
                  </button>
                </div>
              ))
            ) : (
              <p className="text-sm text-zinc-500">—</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-300">{T.ghRemoteOnly}</h2>
            {remoteOnly.length ? (
              <div className="space-y-1.5">
                {remoteOnly.map((r) => (
                  <div key={r.nameWithOwner} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                    <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-zinc-300 underline hover:text-indigo-300">
                      {r.nameWithOwner}
                    </a>
                    <span className="text-zinc-600">{r.visibility?.toLowerCase()}</span>
                    {r.updatedAt && <span className="ml-auto text-zinc-600">{new Date(r.updatedAt).toLocaleDateString('fr-FR')}</span>}
                    <button
                      className="btn-ghost !px-2 !py-0.5 text-xs"
                      disabled={busy !== null}
                      title={T.ghCloneHint}
                      onClick={() => act(`clone:${r.nameWithOwner}`, () => api.githubClone(r.nameWithOwner!))}
                    >
                      {busy === `clone:${r.nameWithOwner}` ? <Spinner /> : '⬇'} {T.ghClone}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">—</p>
            )}
          </section>

          <section className="card space-y-2 p-4">
            <h2 className="text-sm font-semibold text-zinc-300">{T.ghTrustedUsers}</h2>
            <p className="text-xs text-zinc-500">{T.ghTrustedHint}</p>
            <div className="flex flex-wrap items-center gap-2">
              {trusted.map((login) => (
                <span key={login} className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-0.5 text-xs">
                  @{login}
                  <button
                    className="text-zinc-500 hover:text-red-400"
                    onClick={() => act(`untrust:${login}`, () => api.removeTrustedUser(login).then((r) => setTrusted(r.users)))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                className="input !w-44 text-xs"
                placeholder={T.ghTrustedPlaceholder}
                value={newTrusted}
                onChange={(e) => setNewTrusted(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTrusted.trim()) {
                    act('trust', () => api.addTrustedUser(newTrusted.trim()).then((r) => {
                      setTrusted(r.users);
                      setNewTrusted('');
                    }));
                  }
                }}
              />
              <button
                className="btn-ghost text-xs"
                disabled={!newTrusted.trim() || busy !== null}
                onClick={() =>
                  act('trust', () => api.addTrustedUser(newTrusted.trim()).then((r) => {
                    setTrusted(r.users);
                    setNewTrusted('');
                  }))
                }
              >
                {T.ghTrustedAdd}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
