'use client';
// The ONE drawer used for leads, sent emails, replies and blogs. Pages call open(kind, id) (or goto(page, kind, id)
// to switch page first); what each kind shows lives in drawerKinds.js.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Icon } from './Icon';
import { Skeleton, ErrorBox } from './ui';
import { FormattedContent } from './FormattedContent';
import { Markdown } from './LazyMarkdown';
import { toSection, useLeadsFilter, useList, usePositiveView, useSection } from './DataProvider';
import { getKinds } from './drawerKinds';
import { neighbours } from '@/core/listStep';

const DrawerCtx = createContext(null);

// Which item is open ('kind:id' or null), outside React state so a row can subscribe to just its own answer.
function createSelection() {
  let current = null;
  const subs = new Set();
  return {
    get: () => current,
    set(next) { if (next !== current) { current = next; subs.forEach((f) => f()); } },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}
export const useDrawer = () => useContext(DrawerCtx);

export function DrawerProvider({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const { filter } = useLeadsFilter();
  const { positiveView } = usePositiveView();
  const selection = useMemo(createSelection, []);
  const [s, setS] = useState({ open: false, kind: null, id: null });

  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  const returnTo = useRef(null); // element to refocus on close; set while the drawer is open
  const pending = useRef(null); // drawer item to open once the target page has mounted
  const lastIndex = useRef(-1); // where the open item was in the list behind Previous/Next (see below)

  const open = useCallback((kind, id) => {
    if (!returnTo.current) returnTo.current = document.activeElement;
    lastIndex.current = -1;
    setS({ open: true, kind, id });
  }, []);

  const close = useCallback(() => {
    setS((p) => (p.open ? { ...p, open: false } : p));
    if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
    returnTo.current = null;
  }, []);

  // "page, kind, id" -> switch to that page (if needed) and open the item.
  const goto = useCallback((page, kind, id) => {
    if (pathname === `/${page}`) { open(kind, id); return; }
    pending.current = { kind, id };
    router.push(`/${page}`);
  }, [pathname, router, open]);

  // On navigation: open the pending item, otherwise close the drawer.
  useEffect(() => {
    const p = pending.current;
    pending.current = null;
    if (p) open(p.kind, p.id); else close();
  }, [pathname, open, close]);

  const kinds = useMemo(() => getKinds(goto), [goto]);
  const k = s.kind ? kinds[s.kind] : null;

  // The item's detail (cached per item, so stepping back is instant) and the list behind Previous/Next.
  const detailQuery = useQuery({
    queryKey: ['detail', s.kind, s.id],
    queryFn: () => k.load(s.id),
    enabled: s.open && !!k,
  });
  const detail = toSection(detailQuery, null);
  const section = useSection(k?.section ?? null);
  const paged = useList(k?.paged ?? null);

  // Not worked out while the drawer is closed (e.g. on every Positive Leads keystroke).
  const items = useMemo(
    () => (!s.open || !k ? [] : k.paged ? paged.data.items : k.list(section.data, filter, positiveView)),
    [s.open, k, paged.data.items, section.data, filter, positiveView],
  );
  // If the open item leaves the list (e.g. relabelled), Previous/Next carry on from where it was (core/listStep.js).
  const { index, prev: prevItem, next: nextItem } = neighbours(items, s.id, lastIndex.current);
  useEffect(() => { if (index >= 0) lastIndex.current = index; }, [index]);
  const step = useCallback((item) => { if (item) open(s.kind, item.id); }, [open, s.kind]);

  useEffect(() => {
    if (!s.open) return undefined;
    const onKey = (e) => {
      const root = rootRef.current;
      if (e.key === 'Escape') close();
      else if (e.key === 'Tab') { // keep focus inside the open drawer
        const f = [...root.querySelectorAll('button:not(:disabled), a[href]')];
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [s.open, close]);

  // Keep keyboard focus inside the drawer when content swaps (e.g. the focused Previous/Next just became disabled).
  useEffect(() => {
    const root = rootRef.current;
    if (!s.open || !root) return;
    const a = document.activeElement;
    if (!root.contains(a)) root.focus({ preventScroll: true });
    else if (a.disabled) root.querySelector('[aria-label="Close"]')?.focus();
  }, [s.open, detail.status, s.id]);

  useEffect(() => { bodyRef.current?.scrollTo(0, 0); }, [detail.status, s.id]);

  useEffect(() => { selection.set(s.open ? `${s.kind}:${s.id}` : null); }, [selection, s.open, s.kind, s.id]);
  const ctx = useMemo(() => ({ open, close, goto, selection }), [open, close, goto, selection]);

  const v = useMemo(() => (k && detail.status === 'ready' ? k.describe(detail.data) : null), [k, detail.status, detail.data]);

  return (
    <DrawerCtx.Provider value={ctx}>
      {children}
      <div className={`overlay${s.open ? ' open' : ''}`} onClick={close} />
      <aside
        className={`drawer${s.open ? ' open' : ''}`}
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Details"
        aria-hidden={!s.open}
        tabIndex={-1}
        inert={!s.open}
      >
        {k && (
          <>
            <div className="drawer-head">
              <h2>{k.heading}</h2>
              <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="drawer-body" ref={bodyRef}>
              <div className="title-row">
                <div>
                  {v ? (
                    <>
                      <div className="item-title">{v.title}</div>
                      <div className="item-meta"><span className="mono">ID: {detail.data.id}</span>{v.badge}</div>
                    </>
                  ) : (
                    <>
                      <div className="skel" style={{ height: 28, width: 150 }} />
                      <div className="skel" style={{ height: 14, width: 110, marginTop: 8 }} />
                    </>
                  )}
                </div>
                <div className="steppers">
                  <button className="sq" onClick={() => step(prevItem)} aria-label="Previous" disabled={!prevItem}>
                    <Icon name="chevL" />
                  </button>
                  <button
                    className="sq"
                    onClick={() => step(nextItem)}
                    aria-label="Next"
                    disabled={!nextItem}
                  >
                    <Icon name="chevR" />
                  </button>
                </div>
              </div>
              <hr />
              {detail.status === 'loading' && <Skeleton rows={8} />}
              {detail.status === 'error' && <ErrorBox what="details" onRetry={detail.reload} />}
              {v && (
                <>
                  <div className="meta">{v.rows}</div>
                  {v.action && <div className="action">{v.action}</div>}
                  {v.body != null && (
                    <>
                      <h3 className="body-title">{v.bodyTitle}</h3>
                      {v.bodyBox && <div className="notes">{v.body}</div>}
                      {!v.bodyBox && v.markdown && (v.body.trim()
                        ? <div className="content"><Markdown text={v.body} /></div>
                        : <div className="muted">No content.</div>)}
                      {!v.bodyBox && !v.markdown && <div className="content"><FormattedContent text={v.body} /></div>}
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </DrawerCtx.Provider>
  );
}
