import type { CoreDeps } from '../core/deps.js';
import type { GithubService } from './githubService.js';

/** Periodically fetches every published project and merges what it is behind on (see GithubService.pullIfBehind). */
export class RepoSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: CoreDeps,
    private readonly github: GithubService
  ) {}

  start(): void {
    const ms = this.deps.config.repoSyncMs;
    if (!(ms > 0) || this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), ms);
    this.timer.unref();
    setTimeout(() => void this.runOnce(), 15_000).unref(); // soon after boot, not only after one full period
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the projects; resolves to the outcome per project id (exposed for tests). */
  async runOnce(): Promise<Record<string, string>> {
    if (this.running) return {};
    this.running = true;
    const out: Record<string, string> = {};
    try {
      for (const p of this.deps.repos.projects.all()) {
        if (!p.github_repo) continue;
        out[p.id] = await this.github.pullIfBehind(p.id).catch(() => 'skipped');
      }
    } finally {
      this.running = false;
    }
    return out;
  }
}
