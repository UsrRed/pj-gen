import type { AccessDto, AppStateDto, ArtifactNode, GithubRepoView, GithubStatusDto, IssueDto, LanStatusDto, LogLineDto, ModelName, ProjectDetail, ProjectSize, ProjectSummary, QueueSnapshot, QuotaDto, SettingsDto, StatsDto, StepRunDto } from '@pjgen/shared';

export const API_BASE = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  listProjects: () => req<{ projects: ProjectSummary[]; queue: QueueSnapshot }>('/api/projects'),
  getProject: (id: string) => req<ProjectDetail>(`/api/projects/${id}`),
  patchProject: (id: string, body: { designBenchmark?: boolean | null; size?: ProjectSize | null }) =>
    req<ProjectDetail>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createProject: (body: {
    title: string;
    initialPrompt: string;
    model?: ModelName | null;
    size?: ProjectSize | null;
    designContent?: string;
    designUrl?: string;
  }) => req<ProjectDetail>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  chat: (id: string, content: string) => req<{ accepted: boolean }>(`/api/projects/${id}/chat`, { method: 'POST', body: JSON.stringify({ content }) }),
  generateSpec: (id: string) => req<{ accepted: boolean }>(`/api/projects/${id}/generate-spec`, { method: 'POST', body: '{}' }),
  validateSpec: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/validate-spec`, { method: 'POST', body: '{}' }),
  pause: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/pause`, { method: 'POST', body: '{}' }),
  resume: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/resume`, { method: 'POST', body: '{}' }),
  cancel: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/cancel`, { method: 'POST', body: '{}' }),
  retry: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/retry`, { method: 'POST', body: '{}' }),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE', body: '{}' }),
  micro: (id: string, request: string) =>
    req<{ status: 'appended' | 'queued' | 'needs_clarification' | 'failed'; taskKey?: string; question?: string; message?: string }>(
      `/api/projects/${id}/micro`,
      { method: 'POST', body: JSON.stringify({ request }) }
    ),
  reopen: (id: string, request: string, design?: { designContent?: string; designUrl?: string }) =>
    req<{ ok: boolean }>(`/api/projects/${id}/reopen`, { method: 'POST', body: JSON.stringify({ request, ...design }) }),
  approveDeploy: (id: string, notes: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/approve-deploy`, { method: 'POST', body: JSON.stringify({ notes }) }),
  markDeployed: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/mark-deployed`, { method: 'POST', body: '{}' }),
  artifacts: (id: string) => req<{ tree: ArtifactNode[] }>(`/api/projects/${id}/artifacts`),
  openFolder: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/open-folder`, { method: 'POST', body: '{}' }),
  artifactFile: (id: string, path: string) =>
    req<{ path: string; content: string; truncated: boolean }>(`/api/projects/${id}/artifacts/file?path=${encodeURIComponent(path)}`),
  runLogs: (runId: number, afterSeq = -1) => req<{ run: StepRunDto; lines: LogLineDto[] }>(`/api/steps/${runId}/logs?afterSeq=${afterSeq}`),
  settings: () => req<SettingsDto>('/api/settings'),
  patchSettings: (body: Partial<SettingsDto>) => req<SettingsDto>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),
  quota: () => req<QuotaDto>('/api/quota'),
  quotaProbe: () => req<{ ok: boolean }>('/api/quota/probe', { method: 'POST', body: '{}' }),
  pauseAll: () => req<{ ok: boolean }>('/api/control/pause-all', { method: 'POST', body: '{}' }),
  resumeAll: () => req<{ ok: boolean; resumed: number }>('/api/control/resume-all', { method: 'POST', body: '{}' }),
  setCut: (body: { targetAt: number; reservePct: number }) =>
    req<{ ok: boolean; quota: QuotaDto }>('/api/control/cut', { method: 'POST', body: JSON.stringify(body) }),
  deleteCut: () => req<{ ok: boolean }>('/api/control/cut', { method: 'DELETE', body: '{}' }),
  access: (id: string) => req<{ items: AccessDto[]; secretsPresent: string[] }>(`/api/projects/${id}/access`),
  patchAccess: (id: string, accessId: number, body: { fields?: Record<string, string>; status?: 'needed' | 'provided' | 'skipped' }) =>
    req<{ item: AccessDto }>(`/api/projects/${id}/access/${accessId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addAccess: (id: string, body: { key: string; kind: string; label: string; required?: boolean; why?: string; secretEnvVars?: string[] }) =>
    req<{ items: AccessDto[] }>(`/api/projects/${id}/access`, { method: 'POST', body: JSON.stringify(body) }),
  deleteAccess: (id: string, accessId: number) => req<{ ok: boolean }>(`/api/projects/${id}/access/${accessId}`, { method: 'DELETE', body: '{}' }),
  /** Secret values go one way only: written to the workspace .env, never read back. */
  putAccessSecrets: (id: string, accessId: number, values: Record<string, string>) =>
    req<{ ok: boolean; written: string[] }>(`/api/projects/${id}/access/${accessId}/secrets`, { method: 'POST', body: JSON.stringify({ values }) }),
  testAccess: (id: string, accessId: number) =>
    req<{ ok: boolean; detail: string; at: number }>(`/api/projects/${id}/access/${accessId}/test`, { method: 'POST', body: '{}' }),
  stats: () => req<StatsDto>('/api/stats'),
  notifyTest: () => req<{ ok: boolean }>('/api/settings/notify-test', { method: 'POST', body: '{}' }),
  lanStatus: () => req<LanStatusDto>('/api/lan'),
  appState: (id: string) => req<AppStateDto>(`/api/projects/${id}/app`),
  appStart: (id: string) => req<AppStateDto>(`/api/projects/${id}/app/start`, { method: 'POST', body: '{}' }),
  appStop: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/app/stop`, { method: 'POST', body: '{}' }),
  githubStatus: (force = false) => req<GithubStatusDto>(`/api/github/status${force ? '?force=1' : ''}`),
  githubRepos: () => req<{ status: GithubStatusDto; repos: GithubRepoView[] }>('/api/github/repos'),
  githubClone: (nameWithOwner: string) =>
    req<ProjectSummary>('/api/github/clone', { method: 'POST', body: JSON.stringify({ nameWithOwner }) }),
  githubLink: (id: string, isPrivate?: boolean) =>
    req<ProjectSummary>(`/api/projects/${id}/github/link`, { method: 'POST', body: JSON.stringify({ private: isPrivate }) }),
  githubPush: (id: string, message?: string) =>
    req<ProjectSummary>(`/api/projects/${id}/github/push`, { method: 'POST', body: JSON.stringify({ message }) }),
  githubGenerateCi: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/github/generate-ci`, { method: 'POST', body: '{}' }),
  githubAutoMode: (id: string, enabled: boolean) =>
    req<ProjectSummary>(`/api/projects/${id}/github/auto-mode`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  issues: (projectId?: string) => req<{ issues: IssueDto[] }>(`/api/issues${projectId ? `?projectId=${projectId}` : ''}`),
  issueDecision: (id: number, decision: 'skipped' | 'queued') =>
    req<IssueDto>(`/api/issues/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  trustedUsers: () => req<{ users: string[] }>('/api/github/trusted-users'),
  addTrustedUser: (login: string) => req<{ users: string[] }>('/api/github/trusted-users', { method: 'POST', body: JSON.stringify({ login }) }),
  removeTrustedUser: (login: string) =>
    req<{ users: string[] }>(`/api/github/trusted-users/${encodeURIComponent(login)}`, { method: 'DELETE', body: '{}' }),
};
