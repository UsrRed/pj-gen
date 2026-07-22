import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { T } from '../i18n/fr.js';
import { DesignFields, type DesignValue } from './DesignFields.js';

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<'default' | 'opus' | 'sonnet' | 'haiku'>('default');
  const [design, setDesign] = useState<DesignValue>({ designUrl: '', designContent: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async () => {
    if (!title.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        title: title.trim(),
        initialPrompt: prompt.trim(),
        model: model === 'default' ? null : model,
        designUrl: design.designUrl.trim() || undefined,
        designContent: design.designContent.trim() || undefined,
      });
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-xl border-zinc-700 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{T.newProject}</h2>
        <div className="mt-4 space-y-3">
          <input className="input" placeholder={T.createTitle} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <textarea
            className="input min-h-40 resize-y"
            placeholder={T.initialPrompt}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <DesignFields value={design} onChange={setDesign} />
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <label>{T.model} :</label>
            <select className="input !w-auto" value={model} onChange={(e) => setModel(e.target.value as never)}>
              <option value="default">{T.modelDefault}</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </select>
            <span className="text-xs text-zinc-600">{T.modelForceHint}</span>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={onClose}>
              {T.cancel}
            </button>
            <button className="btn-primary" onClick={() => void submit()} disabled={busy || !title.trim() || !prompt.trim()}>
              {busy ? T.loading : T.create}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
