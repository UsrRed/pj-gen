import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useSse } from '../api/sse.js';
import { useStore } from '../store/useStore.js';
import { ProjectCard } from '../components/ProjectCard.js';
import { NewProjectModal } from '../components/NewProjectModal.js';
import { QuotaBanner } from '../components/QuotaBanner.js';
import { T } from '../i18n/fr.js';

export function DashboardPage() {
  const projects = useStore((s) => s.projects);
  const queue = useStore((s) => s.queue);
  const settings = useStore((s) => s.settings);
  const setProjects = useStore((s) => s.setProjects);
  const setQueue = useStore((s) => s.setQueue);
  const setQuota = useStore((s) => s.setQuota);
  const setSettings = useStore((s) => s.setSettings);
  const [showNew, setShowNew] = useState(false);
  useSse(null);

  useEffect(() => {
    void api.listProjects().then((r) => {
      setProjects(r.projects);
      setQueue(r.queue);
    });
    void api.quota().then(setQuota);
    void api.settings().then(setSettings);
  }, [setProjects, setQueue, setQuota, setSettings]);

  const all = useMemo(() => Object.values(projects).sort((a, b) => b.createdAt - a.createdAt), [projects]);
  const active = queue.activeIds.map((id) => projects[id]).filter(Boolean);
  const queued = queue.queuedIds.map((id) => projects[id]).filter(Boolean);
  const slots = settings?.maxConcurrentBuilds ?? 2;

  return (
    <div className="space-y-6">
      <QuotaBanner />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          {T.activeBuilds} ({active.length}/{slots})
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {active.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
          {Array.from({ length: Math.max(0, slots - active.length) }).map((_, i) => (
            <div key={i} className="card flex min-h-24 items-center justify-center border-dashed text-sm text-zinc-600">
              {T.emptySlot}
            </div>
          ))}
        </div>
      </section>

      {queued.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            {T.queue} ({queued.length})
          </h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {queued.map((p) => (
              <ProjectCard key={p.id} p={p} compact />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{T.allProjects}</h2>
          <button className="btn-primary" onClick={() => setShowNew(true)}>
            + {T.newProject}
          </button>
        </div>
        {all.length === 0 ? (
          <div className="card p-10 text-center text-zinc-500">{T.noProjects}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {all.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        )}
      </section>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
