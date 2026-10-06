'use client';
// Data for every page, cached by TanStack Query: each section is fetched on first use, shared between pages,
// and refetched in the background when it goes stale (window refocus, reconnect). Also holds the leads filter.
import { createContext, useContext, useState } from 'react';
import { QueryClient, QueryClientProvider, skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/core/api';

const FETCHERS = {
  pipelines: api.getPipelines,
  stats: api.getLeadStats,
  leads: () => api.getLeads(),
  sent: api.getSentEmails,
  replies: api.getReplies,
  blogs: api.getBlogs,
  positive: api.getPositiveLeads,
};
const EMPTY = { pipelines: [], stats: null, leads: [], sent: [], replies: [], blogs: [], positive: [] };

export const visibleLeads = (leads, filter) => leads.filter((l) =>
  (filter.status === 'all' || l.status.toLowerCase() === filter.status)
  && (filter.source === 'all' || l.source === filter.source));

// A query as the pages see it: { status: 'loading' | 'ready' | 'error', data, reload }.
// Data already on screen stays 'ready' even if a background refetch fails.
export function toSection(query, empty) {
  const status = query.data !== undefined ? 'ready' : query.isError ? 'error' : 'loading';
  return { status, data: query.data ?? empty, reload: () => query.refetch() };
}

// Combined status of several sections: any error wins, then any loading.
export function combinedStatus(...sections) {
  if (sections.some((s) => s.status === 'error')) return 'error';
  if (sections.some((s) => s.status === 'loading')) return 'loading';
  return 'ready';
}

const FilterCtx = createContext(null);
export const useLeadsFilter = () => useContext(FilterCtx);

export function DataProvider({ children }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [filter, setFilter] = useState({ status: 'all', source: 'all' });
  return (
    <QueryClientProvider client={client}>
      <FilterCtx.Provider value={{ filter, setFilter }}>{children}</FilterCtx.Provider>
    </QueryClientProvider>
  );
}

// A section's data, loaded on first use. `key` may be null (nothing to load yet).
export function useSection(key) {
  const query = useQuery({ queryKey: ['section', key], queryFn: key ? FETCHERS[key] : skipToken });
  return toSection(query, key ? EMPTY[key] : []);
}

// Replace a section's cached data locally (optimistic updates). Cancels in-flight fetches so they can't overwrite it.
export function useUpdateSection() {
  const client = useQueryClient();
  return (key, fn) => {
    client.cancelQueries({ queryKey: ['section', key] });
    client.setQueryData(['section', key], (data) => fn(data ?? EMPTY[key]));
  };
}
