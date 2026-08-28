import { vi } from 'vitest';

/** Maps a URL substring to the JSON payload returned for it. */
export function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`Unstubbed fetch: ${url}`);
    return { ok: true, status: 200, json: async () => routes[key] };
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function fetchCallsMatching(mock: ReturnType<typeof vi.fn>, fragment: string) {
  return mock.mock.calls.filter(([url]) => String(url).includes(fragment));
}
