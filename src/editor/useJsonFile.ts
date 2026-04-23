import { useCallback, useEffect, useState } from "react";

export interface UseJsonFileResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  save: (next: T) => Promise<void>;
  saving: boolean;
  reload: () => void;
}

/**
 * Loads and saves a JSON file under src/game/data/ via the dev-only
 * endpoints in tools/editor-write-plugin.mjs. `relPath` is relative to
 * the repo root — e.g. "src/game/data/quests.json".
 */
export function useJsonFile<T>(relPath: string): UseJsonFileResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/__editor/read?path=${encodeURIComponent(relPath)}&t=${Date.now()}`)
      .then(async (res) => {
        const text = await res.text();
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const body = JSON.parse(text) as { error?: string };
            if (body.error) msg = body.error;
          } catch {
            // fall through
          }
          throw new Error(msg);
        }
        return text;
      })
      .then((text) => {
        if (cancelled) return;
        setData(JSON.parse(text) as T);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [relPath, nonce]);

  const save = useCallback(
    async (next: T) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/__editor/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: relPath,
            content: `${JSON.stringify(next, null, 2)}\n`,
          }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (!res.ok || !body.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        setData(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [relPath],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, save, saving, reload };
}
