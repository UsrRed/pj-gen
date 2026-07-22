import type { Config } from './config.js';
import { openDb, type DB } from './db/db.js';
import { createRepos, type Repos } from './db/repos/index.js';
import { Bus } from './core/bus.js';
import { KeyedMutex } from './core/mutex.js';
import type { CoreDeps, SchedulerHooks } from './core/deps.js';
import { WorkspaceManager } from './pipeline/workspace.js';
import { FAKE_CAPABILITIES, probeCapabilities, type Capabilities } from './claude/capabilities.js';
import { createRealRunner } from './claude/runner.js';
import { createFakeRunner } from './claude/fakeRunner.js';
import type { RunnerFn } from './claude/types.js';
import { Engine } from './pipeline/engine.js';
import { Scheduler } from './pipeline/scheduler.js';
import { ChatService } from './cadrage/chatService.js';
import { SpecService } from './cadrage/specService.js';
import { DeployService } from './deploy/deployService.js';
import { MicroService } from './micro/microService.js';
import { GithubService } from './github/githubService.js';
import { IssuePoller } from './github/issuePoller.js';
import { Notifier, type SendFn } from './core/notifier.js';
import { AppRunner } from './preview/appRunner.js';
import { LanExposure } from './core/lanExposure.js';

export interface Container extends CoreDeps {
  db: DB;
  caps: Capabilities;
  engine: Engine;
  scheduler: Scheduler;
  chat: ChatService;
  spec: SpecService;
  deploy: DeployService;
  micro: MicroService;
  github: GithubService;
  issuePoller: IssuePoller;
  notifier: Notifier;
  appRunner: AppRunner;
  lan: LanExposure;
  close(): void;
}

export interface ContainerOverrides {
  runner?: RunnerFn;
  caps?: Capabilities;
  notifySend?: SendFn;
}

export async function buildContainer(config: Config, overrides: ContainerOverrides = {}): Promise<Container> {
  const db = openDb(config.dbPath);
  const repos: Repos = createRepos(db);
  const bus = new Bus(repos.events);
  const mutex = new KeyedMutex();
  const ws = new WorkspaceManager(config);

  const caps = overrides.caps ?? (config.fakeCli ? FAKE_CAPABILITIES : await probeCapabilities(config.claudeBin));
  const runner = overrides.runner ?? (config.fakeCli ? createFakeRunner() : createRealRunner(config, caps));

  // The scheduler needs deps and deps need the scheduler — late-bound proxy breaks the cycle.
  let scheduler: Scheduler | null = null;
  const schedProxy: SchedulerHooks = {
    poke: () => scheduler?.poke(),
    notifyQuotaLimit: (resetAt, pattern) => scheduler?.notifyQuotaLimit(resetAt, pattern),
    notifyQuotaCleared: () => scheduler?.notifyQuotaCleared(),
    emitQuota: () => scheduler?.emitQuota(),
  };

  const deps: CoreDeps = { config, repos, bus, runner, mutex, ws, sched: schedProxy };
  const engine = new Engine(deps);
  scheduler = new Scheduler(deps, engine);
  const chat = new ChatService(deps);
  const spec = new SpecService(deps, chat);
  const deploy = new DeployService(deps, chat);
  const micro = new MicroService(deps);
  const github = new GithubService(deps);
  const issuePoller = new IssuePoller(deps, github, micro);
  const notifier = new Notifier(repos, overrides.notifySend);
  notifier.attach(bus);
  const appRunner = new AppRunner(deps);
  appRunner.sweepOrphans();
  const lan = new LanExposure(config.port, config.host);

  return {
    ...deps,
    db,
    caps,
    engine,
    scheduler,
    chat,
    spec,
    deploy,
    micro,
    github,
    issuePoller,
    notifier,
    appRunner,
    lan,
    close: () => {
      issuePoller.stop();
      scheduler?.stop();
      appRunner.stopAll();
      void lan.disable();
      db.close();
    },
  };
}
