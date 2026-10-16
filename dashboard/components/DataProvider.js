'use client';
// Data for every page, cached by TanStack Query: each section is fetched on first use, shared between pages,
// and refetched in the background when it goes stale (window refocus, reconnect). Also holds the leads filter,
// the page each list is on and the Positive Leads search/sort, so they survive tab switches and the drawer can
// step through exactly what is shown.
import { createContext, useCallback, useContext, useState } from 'react';
import {
  QueryClient, QueryClientProvider, keepPreviousData, skipToken, useQuery, useQueryClient,
} from '@tanstack/react-query';
import * as api from '@/core/api';

const FETCHERS = {
  agent: api.getAgent,
  stats: api.getLeadStats,
  positive: api.getPositiveLeads,
};

// Paged lists: one page at a time from the backend -> { items, total, page, limit }.
export const PAGE_SIZE = 50;
const LISTS = {
  leads: (page, filter) => api.getLeads({
    page, limit: PAGE_SIZE,
    status: filter.status === 'all' ? undefined : filter.status,
    source: filter.source === 'all' ? undefined : filter.source,
  }),
  sent: (page, f) => api.getSentEmails({ page, limit: PAGE_SIZE, q: f.q, status: f.status === 'all' ? undefined : f.status }),
  replies: (page, f) => api.getReplies({ page, limit: PAGE_SIZE, q: f.q, label: f.label === 'all' ? undefined : f.label }),
  blogs: (page) => api.getBlogs({ page, limit: PAGE_SIZE }),
};
const EMPTY_PAGE = { items: [], total: 0, page: 1, limit: PAGE_SIZE };
// History search + filters, per list. The search text is already debounced by the page.
const LIST_FILTERS = { sent: { q: '', status: 'all' }, replies: { q: '', label: 'all' } };
// Agent status: poll every 3 s while a pause/resume is being applied, otherwise every 5 s (dashboard-integration
// section 3.5: an offline assistant shows within seconds, never as an endless spinner).
const OPTIONS = {
  agent: { refetchInterval: (q) => (q.state.data && !q.state.data.inSync ? 3000 : 5000) },
};
const EMPTY = {
  agent: null, stats: null,
  positive: { positive: [], review: [], questions: [], notInterested: [], repliedLeads: 0 },
};

// Positive Leads search + sort ({ q, sort }), applied to one group. 'followup' keeps the backend order
// (waiting for our answer first, longest-waiting on top).
const SORTS = {
  newest: (a, b) => b.repliedAt.localeCompare(a.repliedAt),
  oldest: (a, b) => a.repliedAt.localeCompare(b.repliedAt),
  name: (a, b) => (a.name || '').localeCompare(b.name || ''),
};
export function visiblePositive(items, { q, sort }) {
  const needle = q.trim().toLowerCase();
  const found = needle
    ? items.filter((l) => [l.name, l.company, l.preview].some((v) => v?.toLowerCase().includes(needle)))
    : items;
  return SORTS[sort] ? [...found].sort(SORTS[sort]) : found;
}

// A query as the pages see it: { status: 'loading' | 'ready' | 'error', data, reload }.
// Data already on screen stays 'ready' even if a background refetch fails.
export function toSection(query, empty) {
  const status = query.data !== undefined ? 'ready' : query.isError ? 'error' : 'loading';
  return { status, data: query.data ?? empty, reload: () => query.refetch(), fetching: query.isFetching };
}

const FilterCtx = createContext(null);
export const useLeadsFilter = () => useContext(FilterCtx);

export function DataProvider({ children }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [filter, setLeadsFilter] = useState({ status: 'all', source: 'all' });
  const [pages, setPages] = useState({ leads: 1, sent: 1, replies: 1, blogs: 1 });
  const [positiveView, setPositiveView] = useState({ q: '', sort: 'followup' });
  const [listFilters, setListFilters] = useState(LIST_FILTERS);
  // A new lead filter starts again from page 1 (the old page may not exist in the filtered list).
  const setFilter = useCallback((fn) => {
    setLeadsFilter(fn);
    setPages((p) => ({ ...p, leads: 1 }));
  }, []);
  const setPage = useCallback((key, page) => setPages((p) => ({ ...p, [key]: page })), []);
  // A History list's search / filter (`changes` merged in); a new filter starts again from page 1.
  const setListFilter = useCallback((key, changes) => {
    setListFilters((f) => ({ ...f, [key]: { ...f[key], ...changes } }));
    setPages((p) => ({ ...p, [key]: 1 }));
  }, []);
  return (
    <QueryClientProvider client={client}>
      <FilterCtx.Provider value={{ filter, setFilter, pages, setPage, positiveView, setPositiveView, listFilters, setListFilter }}>
        {children}
      </FilterCtx.Provider>
    </QueryClientProvider>
  );
}

// A section's data, loaded on first use. `key` may be null (nothing to load yet).
export function useSection(key) {
  const query = useQuery({ queryKey: ['section', key], queryFn: key ? FETCHERS[key] : skipToken, ...OPTIONS[key] });
  return toSection(query, key ? EMPTY[key] : []);
}

// The current page of a paged list (leads use the leads filter, History lists their own): { status, data: { items,
// total, page, limit }, reload, fetching, setPage, listFilter, setListFilter }. While the next page loads, the current
// one stays on screen. `key` may be null.
export function useList(key) {
  const { filter, pages, setPage, listFilters, setListFilter } = useContext(FilterCtx);
  const page = key ? pages[key] : 1;
  const listFilter = key === 'leads' ? filter : listFilters[key] ?? null;
  const query = useQuery({
    queryKey: ['list', key, page, listFilter],
    queryFn: key ? () => LISTS[key](page, listFilter) : skipToken,
    placeholderData: keepPreviousData,
  });
  return {
    ...toSection(query, EMPTY_PAGE), setPage: (n) => setPage(key, n),
    listFilter, setListFilter: (changes) => setListFilter(key, changes),
  };
}

// Replace a section's cached data locally (optimistic updates). Cancels in-flight fetches so they can't overwrite it.
export function useUpdateSection() {
  const client = useQueryClient();
  return (key, fn) => {
    client.cancelQueries({ queryKey: ['section', key] });
    client.setQueryData(['section', key], (data) => fn(data ?? EMPTY[key]));
  };
}
