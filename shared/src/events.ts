import type { ChatMessageDto, IssueDto, LogLineDto, MicroRequestDto, ProjectSummary, QueueSnapshot, QuotaDto, StepRunDto, TaskDto } from './types.js';

export const EVENT_TYPES = [
  'project.updated',
  'queue.updated',
  'quota.updated',
  'chat.message',
  'spec.status',
  'step.started',
  'step.log',
  'step.finished',
  'task.updated',
  'artifact.updated',
  'boot.notice',
  'app.status',
  'app.log',
  'micro.updated',
  'issue.updated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventPayloads {
  'project.updated': { project: ProjectSummary };
  'queue.updated': QueueSnapshot;
  'quota.updated': { quota: QuotaDto };
  'chat.message': { message: ChatMessageDto };
  'spec.status': { phase: 'started' | 'done' | 'failed' };
  'step.started': { run: StepRunDto };
  'step.log': { runId: number; lines: LogLineDto[] };
  'step.finished': { run: StepRunDto };
  'task.updated': { task: TaskDto };
  'artifact.updated': { path: string };
  'boot.notice': { level: 'info' | 'warn' | 'error'; message: string };
  'app.status': { running: boolean; url: string | null; startedAt: number | null };
  'app.log': { lines: string[] };
  'micro.updated': { request: MicroRequestDto };
  'issue.updated': { issue: IssueDto };
}

export interface BusEvent<T extends EventType = EventType> {
  id: number;
  type: T;
  projectId: string | null;
  payload: EventPayloads[T];
  createdAt: number;
}
