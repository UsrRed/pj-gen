import { EVENT_TYPES, type EventType } from '@pjgen/shared';
import { useEffect } from 'react';
import { useStore } from '../store/useStore.js';
import { API_BASE } from './client.js';

/** Subscribes the store to an SSE channel (global or per-project) for the lifetime of the component. */
export function useSse(projectId: string | null): void {
  const applyEvent = useStore((s) => s.applyEvent);
  const setConnected = useStore((s) => s.setConnected);

  useEffect(() => {
    const url = projectId ? `${API_BASE}/api/projects/${projectId}/events` : `${API_BASE}/api/events`;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const handler = (type: EventType) => (e: MessageEvent) => {
      try {
        const { projectId: evtProjectId, payload } = JSON.parse(e.data as string) as { projectId: string | null; payload: unknown };
        applyEvent(type, evtProjectId, payload);
      } catch {
        /* malformed event */
      }
    };
    const handlers = new Map<EventType, (e: MessageEvent) => void>();
    for (const type of EVENT_TYPES) {
      const h = handler(type);
      handlers.set(type, h);
      es.addEventListener(type, h as EventListener);
    }
    return () => {
      for (const [type, h] of handlers) es.removeEventListener(type, h as EventListener);
      es.close();
      setConnected(false);
    };
  }, [projectId, applyEvent, setConnected]);
}
