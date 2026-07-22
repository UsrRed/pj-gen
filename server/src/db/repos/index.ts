import type { DB } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { SessionsRepo } from './sessions.js';
import { StepRunsRepo } from './stepRuns.js';
import { TasksRepo } from './tasks.js';
import { MessagesRepo } from './messages.js';
import { EventsRepo } from './events.js';
import { LogsRepo } from './logs.js';
import { SettingsRepo } from './settings.js';
import { QuotaRepo } from './quota.js';
import { UsageRepo } from './usage.js';
import { AppRunsRepo } from './appRuns.js';
import { MicroRepo } from './micro.js';
import { IssuesRepo } from './issues.js';

export interface Repos {
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  stepRuns: StepRunsRepo;
  tasks: TasksRepo;
  messages: MessagesRepo;
  events: EventsRepo;
  logs: LogsRepo;
  settings: SettingsRepo;
  quota: QuotaRepo;
  usage: UsageRepo;
  appRuns: AppRunsRepo;
  micro: MicroRepo;
  issues: IssuesRepo;
}

export function createRepos(db: DB): Repos {
  return {
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    stepRuns: new StepRunsRepo(db),
    tasks: new TasksRepo(db),
    messages: new MessagesRepo(db),
    events: new EventsRepo(db),
    logs: new LogsRepo(db),
    settings: new SettingsRepo(db),
    quota: new QuotaRepo(db),
    usage: new UsageRepo(db),
    appRuns: new AppRunsRepo(db),
    micro: new MicroRepo(db),
    issues: new IssuesRepo(db),
  };
}

export { ProjectsRepo, SessionsRepo, StepRunsRepo, TasksRepo, MessagesRepo, EventsRepo, LogsRepo, SettingsRepo, QuotaRepo, UsageRepo, AppRunsRepo };
export { toStepRunDto } from './stepRuns.js';
export { toTaskDto } from './tasks.js';
export { toMessageDto } from './messages.js';
export { MicroRepo, toMicroDto } from './micro.js';
export { IssuesRepo, toIssueDto } from './issues.js';
export type { IssueRow } from './issues.js';
export type { ProjectRow } from './projects.js';
export type { MicroRequestRow } from './micro.js';
export type { StepRunRow } from './stepRuns.js';
export type { TaskRow } from './tasks.js';
export type { MessageRow } from './messages.js';
