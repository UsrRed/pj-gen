import { create } from 'zustand';
import type { AppStateDto, EventType, IssueDto, LogLineDto, ProjectDetail, ProjectSummary, QueueSnapshot, QuotaDto, SettingsDto } from '@pjgen/shared';

const LOG_CAP = 1500;
const APP_LOG_CAP = 500;
const EMPTY_APP: AppStateDto = { running: false, url: null, startedAt: null, lines: [] };

export interface Notice {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

interface StoreState {
  projects: Record<string, ProjectSummary>;
  queue: QueueSnapshot;
  quota: QuotaDto | null;
  settings: SettingsDto | null;
  detail: ProjectDetail | null;
  /** Issues of the project currently open (IssuePage), keyed by issue id. */
  issues: Record<number, IssueDto>;
  logs: Record<number, LogLineDto[]>;
  notices: Notice[];
  connected: boolean;
  artifactsVersion: number;
  /** Aperçu state of the project currently open in ProjectPage. */
  app: AppStateDto;

  setProjects(list: ProjectSummary[]): void;
  setQueue(q: QueueSnapshot): void;
  setDetail(d: ProjectDetail | null): void;
  setIssues(list: IssueDto[]): void;
  patchDetail(id: string, patch: Partial<ProjectDetail>): void;
  setApp(a: AppStateDto): void;
  setQuota(q: QuotaDto): void;
  setSettings(s: SettingsDto): void;
  setConnected(v: boolean): void;
  seedLogs(runId: number, lines: LogLineDto[]): void;
  applyEvent(type: EventType, projectId: string | null, payload: unknown): void;
}

export const useStore = create<StoreState>((set, get) => ({
  projects: {},
  queue: { activeIds: [], queuedIds: [] },
  quota: null,
  settings: null,
  detail: null,
  issues: {},
  logs: {},
  notices: [],
  connected: false,
  artifactsVersion: 0,
  app: EMPTY_APP,

  setProjects: (list) => set({ projects: Object.fromEntries(list.map((p) => [p.id, p])) }),
  setQueue: (q) => set({ queue: q }),
  setDetail: (d) => set({ detail: d, app: EMPTY_APP }),
  setIssues: (list) => set((s) => ({ issues: { ...s.issues, ...Object.fromEntries(list.map((i) => [i.id, i])) } })),
  setApp: (a) => set({ app: a }),
  patchDetail: (id, patch) => set((s) => (s.detail && s.detail.id === id ? { detail: { ...s.detail, ...patch } } : {})),
  setQuota: (q) => set({ quota: q }),
  setSettings: (s) => set({ settings: s }),
  setConnected: (v) => set({ connected: v }),

  seedLogs: (runId, lines) =>
    set((st) => {
      const existing = st.logs[runId] ?? [];
      const seen = new Set(existing.map((l) => l.seq));
      const merged = [...existing, ...lines.filter((l) => !seen.has(l.seq))].sort((a, b) => a.seq - b.seq).slice(-LOG_CAP);
      return { logs: { ...st.logs, [runId]: merged } };
    }),

  applyEvent: (type, projectId, payload) => {
    const st = get();
    const p = payload as never;
    switch (type) {
      case 'project.updated': {
        const { project } = p as { project: ProjectSummary };
        set((s) => ({
          projects: { ...s.projects, [project.id]: project },
          detail: s.detail && s.detail.id === project.id ? { ...s.detail, ...project } : s.detail,
        }));
        break;
      }
      case 'project.deleted': {
        const { id } = p as { id: string };
        set((s) => {
          const { [id]: _gone, ...rest } = s.projects;
          return { projects: rest, detail: s.detail && s.detail.id === id ? null : s.detail };
        });
        break;
      }
      case 'queue.updated':
        set({ queue: p as QueueSnapshot });
        break;
      case 'quota.updated':
        set({ quota: (p as { quota: QuotaDto }).quota });
        break;
      case 'chat.message': {
        const { message } = p as { message: ProjectDetail['messages'][number] };
        if (st.detail && st.detail.id === message.projectId && !st.detail.messages.some((m) => m.id === message.id)) {
          set((s) => ({ detail: s.detail ? { ...s.detail, messages: [...s.detail.messages, message] } : s.detail }));
        }
        break;
      }
      case 'spec.status': {
        const { phase } = p as { phase: 'started' | 'done' | 'failed' };
        if (st.detail && projectId === st.detail.id) {
          set((s) => (s.detail ? { detail: { ...s.detail, specGenerating: phase === 'started' } } : {}));
        }
        break;
      }
      case 'step.started':
      case 'step.finished': {
        const { run } = p as { run: ProjectDetail['stepRuns'][number] };
        if (st.detail && st.detail.id === run.projectId) {
          set((s) => {
            if (!s.detail) return {};
            const runs = s.detail.stepRuns.some((r) => r.id === run.id)
              ? s.detail.stepRuns.map((r) => (r.id === run.id ? run : r))
              : [...s.detail.stepRuns, run];
            return { detail: { ...s.detail, stepRuns: runs } };
          });
        }
        break;
      }
      case 'step.log': {
        const { runId, lines } = p as { runId: number; lines: LogLineDto[] };
        st.seedLogs(runId, lines);
        break;
      }
      case 'task.updated': {
        const { task } = p as { task: ProjectDetail['tasks'][number] };
        if (st.detail && projectId === st.detail.id) {
          set((s) => {
            if (!s.detail) return {};
            const tasks = s.detail.tasks.some((t) => t.taskKey === task.taskKey)
              ? s.detail.tasks.map((t) => (t.taskKey === task.taskKey ? task : t))
              : [...s.detail.tasks, task];
            return { detail: { ...s.detail, tasks } };
          });
        }
        break;
      }
      case 'artifact.updated':
        if (st.detail && projectId === st.detail.id) set((s) => ({ artifactsVersion: s.artifactsVersion + 1 }));
        break;
      case 'app.status': {
        const a = p as { running: boolean; url: string | null; startedAt: number | null };
        if (st.detail && projectId === st.detail.id) {
          set((s) => ({ app: { ...a, lines: a.running ? s.app.lines : [...s.app.lines] } }));
        }
        break;
      }
      case 'app.log': {
        const { lines } = p as { lines: string[] };
        if (st.detail && projectId === st.detail.id) {
          set((s) => ({ app: { ...s.app, lines: [...s.app.lines, ...lines].slice(-APP_LOG_CAP) } }));
        }
        break;
      }
      case 'micro.updated': {
        const { request } = p as { request: ProjectDetail['microRequests'][number] };
        if (st.detail && projectId === st.detail.id) {
          set((s) => {
            if (!s.detail) return {};
            const list = s.detail.microRequests.some((r) => r.id === request.id)
              ? s.detail.microRequests.map((r) => (r.id === request.id ? request : r))
              : [request, ...s.detail.microRequests];
            return { detail: { ...s.detail, microRequests: list } };
          });
        }
        break;
      }
      case 'issue.updated': {
        const { issue } = p as { issue: IssueDto };
        set((s) => ({ issues: { ...s.issues, [issue.id]: issue } }));
        break;
      }
      case 'boot.notice': {
        const n = p as { level: Notice['level']; message: string };
        set((s) => ({ notices: [...s.notices.slice(-4), { ...n, at: Date.now() }] }));
        break;
      }
    }
  },
}));
