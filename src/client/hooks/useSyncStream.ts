import { useState, useEffect, useRef } from 'react';
import type { SyncEvent } from '../../types/sync';

type SyncProgressEvent = Extract<SyncEvent, { type: 'progress' }>;

export function useSyncStream(runId: string | null): {
  events: SyncEvent[];
  latestProgress: SyncProgressEvent | null;
  done: boolean;
} {
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [latestProgress, setLatestProgress] = useState<SyncProgressEvent | null>(null);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;

    setEvents([]);
    setLatestProgress(null);
    setDone(false);

    const es = new EventSource(`/api/sync/runs/${runId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as SyncEvent;
        setEvents(prev => [...prev, event]);
        if (event.type === 'progress') setLatestProgress(event);
        if (event.type === 'done') {
          setDone(true);
          es.close();
        }
      } catch {}
    };

    es.onerror = () => es.close();

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [runId]);

  return { events, latestProgress, done };
}
