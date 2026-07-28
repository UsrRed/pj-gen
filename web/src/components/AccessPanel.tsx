import { useEffect, useState } from 'react';
import { ACCESS_FIELD_SPECS, type AccessDto, type AccessStatus } from '@pjgen/shared';
import { api } from '../api/client.js';
import { ACCESS_KIND_LABELS, ACCESS_STATUS_STYLE, T } from '../i18n/fr.js';

const TESTABLE = new Set(['ssh', 'domain']);

function StatusChip({ status }: { status: AccessStatus }) {
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ACCESS_STATUS_STYLE[status]}`}>{T.accessStatus[status]}</span>;
}

function AccessCard({
  item,
  secretsPresent,
  onChanged,
}: {
  item: AccessDto;
  secretsPresent: string[];
  onChanged: () => void;
}) {
  const [fields, setFields] = useState<Record<string, string>>(item.fields);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => setFields(item.fields), [item.fields]);

  const run = (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    void fn()
      .then(() => onChanged())
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const specs = ACCESS_FIELD_SPECS[item.kind] ?? [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-200">{item.label}</span>
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">{ACCESS_KIND_LABELS[item.kind]}</span>
        {item.required && <span className="text-[11px] text-amber-400">{T.accessRequired}</span>}
        <StatusChip status={item.status} />
        <span className="ml-auto font-mono text-[11px] text-zinc-600">{item.key}</span>
      </div>
      {item.why && <p className="mt-1 text-xs text-zinc-500">{item.why}</p>}

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {specs.map((s) => (
          <label key={s.name} className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-500">{s.label}</span>
            <input
              className="input !py-1 text-xs"
              placeholder={s.placeholder}
              value={fields[s.name] ?? ''}
              onChange={(e) => setFields({ ...fields, [s.name]: e.target.value })}
            />
          </label>
        ))}
      </div>

      {item.secretEnvVars.length > 0 && (
        <div className="mt-3 border-t border-zinc-800 pt-2">
          <p className="text-xs text-zinc-500">{T.accessSecretsTitle}</p>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {item.secretEnvVars.map((name) => (
              <label key={name} className="flex flex-col gap-1 text-xs">
                <span className="flex items-center gap-1.5 font-mono text-zinc-400">
                  {name}
                  {secretsPresent.includes(name) && <span className="text-emerald-400">{T.accessSecretPresent}</span>}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  className="input !py-1 text-xs"
                  placeholder={secretsPresent.includes(name) ? T.accessSecretReplace : T.accessSecretPlaceholder}
                  value={secrets[name] ?? ''}
                  onChange={(e) => setSecrets({ ...secrets, [name]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-400">⚠️ {error}</div>}
      {testResult && <div className={`mt-2 text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>{testResult.ok ? '✓' : '✗'} {testResult.detail}</div>}
      {!testResult && item.lastTestAt !== null && (
        <div className={`mt-2 text-xs ${item.lastTestOk ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
          {item.lastTestOk ? '✓' : '✗'} {item.lastTestDetail}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn-ghost !px-2 !py-1 text-xs" disabled={busy !== null} onClick={() => run('save', () => api.patchAccess(item.projectId, item.id, { fields }))}>
          {busy === 'save' ? T.loading : T.accessSave}
        </button>
        {Object.values(secrets).some((v) => v.trim()) && (
          <button
            className="btn-primary !px-2 !py-1 text-xs"
            disabled={busy !== null}
            onClick={() =>
              run('secret', async () => {
                const values = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
                await api.putAccessSecrets(item.projectId, item.id, values);
                setSecrets({}); // never keep a secret in component state
              })
            }
          >
            {busy === 'secret' ? T.loading : T.accessSaveSecret}
          </button>
        )}
        {TESTABLE.has(item.kind) && (
          <button
            className="btn-ghost !px-2 !py-1 text-xs"
            disabled={busy !== null}
            onClick={() => run('test', () => api.testAccess(item.projectId, item.id).then(setTestResult))}
          >
            {busy === 'test' ? T.loading : T.accessTest}
          </button>
        )}
        {item.status !== 'skipped' ? (
          <button className="btn-ghost !px-2 !py-1 text-xs text-zinc-500" disabled={busy !== null} onClick={() => run('skip', () => api.patchAccess(item.projectId, item.id, { status: 'skipped' }))}>
            {T.accessSkip}
          </button>
        ) : (
          <button className="btn-ghost !px-2 !py-1 text-xs text-zinc-500" disabled={busy !== null} onClick={() => run('unskip', () => api.patchAccess(item.projectId, item.id, { status: 'needed' }))}>
            {T.accessUnskip}
          </button>
        )}
      </div>
    </div>
  );
}

export function AccessPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<AccessDto[]>([]);
  const [secretsPresent, setSecretsPresent] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => {
    void api
      .access(projectId)
      .then((r) => {
        setItems(r.items);
        setSecretsPresent(r.secretsPresent);
      })
      .finally(() => setLoaded(true));
  };

  useEffect(refresh, [projectId]);

  if (!loaded) return null;

  const missing = items.filter((i) => i.required && i.status === 'needed').length;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-300">🔐 {T.accessTitle}</h3>
        {items.length > 0 && (
          <span className="text-xs text-zinc-500">
            {items.length - missing}/{items.length} {T.accessProvidedCount}
          </span>
        )}
        <button className="btn-ghost ml-auto !px-2 !py-1 text-xs" onClick={refresh}>
          {T.refresh}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{T.accessSecurityNote}</p>

      {items.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-600">{T.accessEmpty}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map((item) => (
            <AccessCard key={item.id} item={item} secretsPresent={secretsPresent} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
