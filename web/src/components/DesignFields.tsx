import { useState } from 'react';
import { T } from '../i18n/fr.js';

export interface DesignValue {
  designUrl: string;
  designContent: string;
}

/** Collapsible mockup hand-off fields (e.g. an export from Claude Design — claude.ai/design). */
export function DesignFields({ value, onChange }: { value: DesignValue; onChange: (v: DesignValue) => void }) {
  const [open, setOpen] = useState(Boolean(value.designUrl || value.designContent));
  return (
    <div className="rounded-lg border border-zinc-800">
      <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50" onClick={() => setOpen(!open)}>
        <span>{T.designSection}</span>
        <span className="text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-500">{T.designHint}</p>
          <input
            className="input"
            placeholder={T.designUrlPlaceholder}
            value={value.designUrl}
            onChange={(e) => onChange({ ...value, designUrl: e.target.value })}
          />
          <textarea
            className="input min-h-28 font-mono !text-xs"
            placeholder={T.designContentPlaceholder}
            value={value.designContent}
            onChange={(e) => onChange({ ...value, designContent: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
