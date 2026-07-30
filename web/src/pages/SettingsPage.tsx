import { useEffect, useState } from 'react';
import { MODEL_NAMES, type LanStatusDto, type ModelName, type SettingsDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import { ALL_STEP_LABELS, T } from '../i18n/fr.js';

export function SettingsPage() {
  const [form, setForm] = useState<SettingsDto | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notifyResult, setNotifyResult] = useState<string | null>(null);
  const [lan, setLan] = useState<LanStatusDto | null>(null);
  const setSettings = useStore((s) => s.setSettings);

  useEffect(() => {
    void api.settings().then(setForm);
    void api.lanStatus().then(setLan).catch(() => undefined);
  }, []);

  if (!form) return <div className="p-10 text-center text-zinc-500">{T.loading}</div>;

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patchSettings(form);
      setForm(updated);
      setSettings(updated);
      void api.lanStatus().then(setLan).catch(() => undefined);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-bold">{T.settingsTitle}</h1>

      <div className="card space-y-4 p-5">
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sConcurrency}</span>
          <input
            type="number"
            min={1}
            max={4}
            className="input !w-24"
            value={form.maxConcurrentBuilds}
            onChange={(e) => setForm({ ...form, maxConcurrentBuilds: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="flex items-start justify-between gap-4 text-sm">
          <span className="flex flex-col">
            {T.sMaxSessions}
            <span className="mt-0.5 text-xs text-zinc-500">{T.sMaxSessionsHint}</span>
          </span>
          <input
            type="number"
            min={1}
            max={8}
            className="input !w-24 shrink-0"
            value={form.maxConcurrentSessions}
            onChange={(e) => setForm({ ...form, maxConcurrentSessions: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="flex items-start justify-between gap-4 text-sm">
          <span className="flex flex-col">
            {T.sTaskParallelism}
            <span className="mt-0.5 text-xs text-zinc-500">{T.sTaskParallelismHint}</span>
          </span>
          <input
            type="number"
            min={1}
            max={4}
            className="input !w-24 shrink-0"
            value={form.taskParallelism}
            onChange={(e) => setForm({ ...form, taskParallelism: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sDefaultModel}</span>
          <select className="input !w-32" value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value as ModelName })}>
            {MODEL_NAMES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sAutoResume}</span>
          <input type="checkbox" className="h-4 w-4" checked={form.autoResumeOnBoot} onChange={(e) => setForm({ ...form, autoResumeOnBoot: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sSkipHardening}</span>
          <input type="checkbox" className="h-4 w-4" checked={form.skipTestHardening} onChange={(e) => setForm({ ...form, skipTestHardening: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span title={T.sDesignBenchmarkHint}>{T.sDesignBenchmark}</span>
          <input type="checkbox" className="h-4 w-4" checked={form.designBenchmark} onChange={(e) => setForm({ ...form, designBenchmark: e.target.checked })} />
        </label>
        <label className="flex items-start justify-between gap-4 text-sm">
          <span className="flex flex-col">
            {T.sBudget}
            <span className="mt-0.5 text-xs text-zinc-500">{T.sBudgetHint}</span>
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            className="input !w-24 shrink-0"
            value={form.maxBudgetUsdPerSession}
            onChange={(e) => setForm({ ...form, maxBudgetUsdPerSession: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-zinc-300">{T.sNotifySection}</h2>
        <div className="space-y-1.5">
          <label className="block text-sm">
            <span className="mb-1 block">{T.sNotifyUrl}</span>
            <input
              type="url"
              className="input w-full"
              placeholder="https://ntfy.sh/mon-topic"
              value={form.notifyUrl}
              onChange={(e) => setForm({ ...form, notifyUrl: e.target.value })}
            />
          </label>
          <p className="text-xs text-zinc-600">{T.sNotifyUrlHint}</p>
        </div>
        {(
          [
            ['deployReady', T.sNotifyDeployReady],
            ['buildFailed', T.sNotifyBuildFailed],
            ['quotaResumed', T.sNotifyQuotaResumed],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center justify-between gap-4 text-sm">
            <span>{label}</span>
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.notifyEvents[key]}
              onChange={(e) => setForm({ ...form, notifyEvents: { ...form.notifyEvents, [key]: e.target.checked } })}
            />
          </label>
        ))}
        <div className="flex items-center gap-3">
          <button
            className="btn-ghost"
            disabled={!form.notifyUrl.trim()}
            onClick={() => {
              setNotifyResult(null);
              void api
                .patchSettings({ notifyUrl: form.notifyUrl, notifyEvents: form.notifyEvents })
                .then(() => api.notifyTest())
                .then(() => setNotifyResult(T.sNotifyTestOk))
                .catch((err: Error) => setNotifyResult(`⚠️ ${err.message}`));
            }}
          >
            {T.sNotifyTest}
          </button>
          {notifyResult && <span className={`text-xs ${notifyResult.startsWith('⚠️') ? 'text-amber-400' : 'text-emerald-400'}`}>{notifyResult}</span>}
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-zinc-300">{T.sGithubSection}</h2>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sGithubDefaultPrivate}</span>
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.githubDefaultPrivate}
            onChange={(e) => setForm({ ...form, githubDefaultPrivate: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sIssuePoll}</span>
          <input
            type="number"
            min={1}
            max={120}
            className="input !w-24"
            value={form.issuePollMinutes}
            onChange={(e) => setForm({ ...form, issuePollMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 5)) })}
          />
        </label>
      </div>

      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-zinc-300">{T.sLanSection}</h2>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{T.sLanToggle}</span>
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.exposeLan}
            disabled={lan?.alreadyExposed}
            onChange={(e) => setForm({ ...form, exposeLan: e.target.checked })}
          />
        </label>
        <p className="text-xs text-zinc-600">{T.sLanHint}</p>
        <p className="text-xs text-amber-400/90">{T.sLanWarning}</p>
        {lan?.alreadyExposed && <p className="text-xs text-zinc-500">{T.sLanAlreadyExposed}</p>}
        {lan?.enabled && lan.urls.length > 0 && (
          <div className="text-xs text-emerald-400">
            {T.sLanUrls}{' '}
            {lan.urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="mr-2 underline">
                {u}
              </a>
            ))}
          </div>
        )}
        {lan?.enabled && !lan.alreadyExposed && lan.urls.length === 0 && <p className="text-xs text-amber-400">{T.sLanNoInterface}</p>}
        {lan && lan.errors.length > 0 && (
          <p className="text-xs text-red-400">
            {T.sLanErrors} {lan.errors.join(' · ')}
          </p>
        )}
      </div>

      <div className="card p-5">
        <h2 className="mb-1 text-sm font-semibold text-zinc-300">{T.sStepModels}</h2>
        <p className="mb-3 text-xs text-zinc-600">{T.sStepModelsHint}</p>
        <div className="space-y-2">
          {Object.entries(form.stepModels).map(([key, model]) => (
            <div key={key} className="flex items-center gap-3 text-sm">
              <span className="w-44 text-zinc-400">{ALL_STEP_LABELS[key] ?? key}</span>
              <select
                className="input !w-32"
                value={model}
                onChange={(e) => setForm({ ...form, stepModels: { ...form.stepModels, [key]: e.target.value as ModelName } })}
              >
                {MODEL_NAMES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">{T.sCaps}</h2>
        <div className="space-y-2">
          {Object.entries(form.stepCaps).map(([key, cap]) => (
            <div key={key} className="flex items-center gap-3 text-sm">
              <span className="w-44 text-zinc-400">{ALL_STEP_LABELS[key] ?? key}</span>
              <input
                type="number"
                min={1}
                className="input !w-20"
                title="tours max"
                value={cap.turns}
                onChange={(e) =>
                  setForm({ ...form, stepCaps: { ...form.stepCaps, [key]: { ...cap, turns: Math.max(1, Number(e.target.value) || 1) } } })
                }
              />
              <span className="text-xs text-zinc-600">{T.turns}</span>
              <input
                type="number"
                min={1}
                className="input !w-20"
                title="minutes max"
                value={cap.timeoutMin}
                onChange={(e) =>
                  setForm({ ...form, stepCaps: { ...form.stepCaps, [key]: { ...cap, timeoutMin: Math.max(1, Number(e.target.value) || 1) } } })
                }
              />
              <span className="text-xs text-zinc-600">min</span>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-emerald-400">{T.saved}</span>}
        <button className="btn-primary" onClick={() => void save()}>
          {T.save}
        </button>
      </div>
    </div>
  );
}
