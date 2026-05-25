import { useCallback, useEffect, useState } from 'react';
import type { DependencyList } from 'react';

export function useAsyncData<T>(loader: () => Promise<T>, deps: DependencyList, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
