import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessageDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { T } from '../i18n/fr.js';
import { fmtTime } from '../lib/format.js';

interface Props {
  projectId: string;
  messages: ChatMessageDto[];
  kind: 'cadrage' | 'deploy';
  disabled?: boolean;
  disabledHint?: string;
  headerActions?: React.ReactNode;
  emptyHint?: string;
}

export function ChatPanel({ projectId, messages, kind, disabled, disabledHint, headerActions, emptyHint }: Props) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const list = messages.filter((m) => m.sessionKind === kind);
  const lastAssistant = [...list].reverse().find((m) => m.role === 'assistant');
  const waitingReply = list.length > 0 && list[list.length - 1].role === 'user';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [list.length]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sending || disabled) return;
    setSending(true);
    setError(null);
    try {
      await api.chat(projectId, content);
      setInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card flex h-[calc(100vh-16rem)] min-h-96 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {list.length === 0 && <div className="py-8 text-center text-sm text-zinc-500">{emptyHint ?? T.emptyChat}</div>}
        {list.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'system' ? (
              <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-400">{m.content}</div>
            ) : (
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  m.role === 'user' ? 'bg-indigo-600/90 text-white' : 'border border-zinc-800 bg-zinc-900'
                }`}
              >
                <div className="prose-chat">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
                <div className={`mt-1 text-right text-[10px] ${m.role === 'user' ? 'text-indigo-200/70' : 'text-zinc-600'}`}>{fmtTime(m.createdAt)}</div>
              </div>
            )}
          </div>
        ))}
        {waitingReply && (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            {T.loading}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {lastAssistant?.structured?.open_questions && lastAssistant.structured.open_questions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-800 px-4 py-2">
          {lastAssistant.structured.open_questions.slice(0, 5).map((q, i) => (
            <button
              key={i}
              className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              onClick={() => setInput((cur) => (cur ? `${cur}\n${q} ` : `${q} `))}
              title="Insérer dans le champ de réponse"
            >
              {q.length > 60 ? `${q.slice(0, 60)}…` : q}
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-zinc-800 p-3">
        {disabled && disabledHint && <div className="mb-2 text-xs text-amber-300">{disabledHint}</div>}
        {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
        <div className="flex items-end gap-2">
          <textarea
            className="input max-h-40 min-h-[2.6rem] flex-1 resize-y"
            placeholder={T.chatPlaceholder}
            value={input}
            disabled={disabled || sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn-primary" onClick={() => void send()} disabled={disabled || sending || !input.trim()}>
            {T.send}
          </button>
          {headerActions}
        </div>
      </div>
    </div>
  );
}
