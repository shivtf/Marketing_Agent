'use client';
// Replies Received on the History page. Read only: the connected inbox's emails, searchable with Gmail's own search:
// all of the inbox for admins, only mail from the people the agent emailed for employees. An email opens as plain
// text in a dialog. Admins connect and disconnect the inbox here. Data: app/api/gmail (core/gmail.js).
import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, EmptyBox, ErrorBox, MetaRow, SearchBox, Skeleton } from './ui';
import { Icon } from './Icon';
import { FormattedContent } from './FormattedContent';
import { useConfirm } from './ConfirmDialog';
import { useDrawer } from './DrawerProvider';
import { getSession, isAdmin } from '@/core/auth';
import { disconnectGmail, getGmailMessage, getGmailStatus, listGmail, startGmailConnect } from '@/core/gmail';
import { fmtDate } from '@/core/format';

const REFRESH_MS = 60_000;

// /history?gmail=<result> after Google's consent screen (app/api/gmail/callback) -> what to tell the admin.
const RESULTS = {
  connected: { text: 'Gmail is connected.', tone: 'ok' },
  denied: { text: 'Gmail was not connected: access was not allowed on Google’s screen.', tone: 'error' },
  noscope: { text: 'Gmail was not connected: tick the box that allows reading Gmail on Google’s screen, then try again.', tone: 'error' },
  expired: { text: 'That connect link expired or was opened in another browser. Click Connect Gmail again.', tone: 'error' },
  notadmin: { text: 'Only admins can connect Gmail.', tone: 'error' },
  notable: { text: 'Run dashboardbackend/migrations/006_gmail_connection.sql in the Supabase SQL editor, then connect again.', tone: 'error' },
  notconfigured: { text: 'Gmail is not set up on the server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).', tone: 'error' },
  api_disabled: { text: 'The Gmail API is not enabled in the Google Cloud project.', tone: 'error' },
  refused: { text: 'Google refused the sign-in. Check that the redirect URI in Google Cloud matches this site, then try again.', tone: 'error' },
  failed: { text: 'Gmail could not be connected. Try again.', tone: 'error' },
};

function useIsAdmin() {
  const [admin, setAdmin] = useState(null); // null until the session is read
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);
  return admin;
}

const sender = (m) => m.from.name || m.from.email || 'Unknown sender';
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export default function GmailInbox() {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const [confirmDialog, confirm] = useConfirm();
  const [note, setNote] = useState(null); // { text, tone }
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(['']); // page tokens so far; '' = the first page
  const [open, setOpen] = useState(null); // index of the email shown in the dialog

  const statusQ = useQuery({ queryKey: ['gmail', 'status'], queryFn: getGmailStatus, staleTime: 60_000 });
  const connected = !!statusQ.data?.connected;
  // Admins see the whole inbox; employees only mail from the people the agent emailed (the server enforces it too).
  const view = admin ? 'inbox' : 'leads';
  const pageToken = pages[pages.length - 1];
  const listQ = useQuery({
    queryKey: ['gmail', 'list', view, q, pageToken],
    queryFn: () => listGmail({ view, q, pageToken }),
    enabled: connected && admin !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // New mail shows by itself: the first page is read again every minute while the browser tab is on screen. Not on
    // later pages, and not while an email is open, so the rows never shift under the reader.
    refetchInterval: pages.length === 1 && open === null ? REFRESH_MS : false,
    retry: (n, err) => n < 1 && !(err.status >= 400 && err.status < 500),
  });

  // Back from Google's consent screen: say how it went, and take ?gmail= out of the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('gmail');
    if (!result) return;
    setNote(RESULTS[result] || RESULTS.failed);
    params.delete('gmail');
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  }, []);

  useEffect(() => {
    if (note?.tone !== 'ok') return undefined;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  // A new search starts again from the first page.
  const search = (text) => {
    setQ(text);
    setPages(['']);
  };

  async function connect() {
    setBusy(true);
    setNote(null);
    try {
      const { url } = await startGmailConnect();
      window.location.assign(url); // Google's consent screen; it sends the browser back to /history?gmail=...
    } catch (err) {
      setNote({ text: err.message, tone: 'error' });
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect Gmail?',
      message: `The dashboard stops reading ${statusQ.data.email}. Nothing in the inbox changes; an admin can connect it again any time.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await disconnectGmail();
      client.removeQueries({ queryKey: ['gmail'] });
      await statusQ.refetch();
      setNote({ text: 'Gmail is disconnected.', tone: 'ok' });
    } catch (err) {
      setNote({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const connectButton = (label = 'Connect Gmail') => (
    <button className="btn primary" type="button" disabled={busy} onClick={connect}><Icon name="mail" /> {busy ? 'Opening Google…' : label}</button>
  );
  const message = note && <div className="auth-msg gmail-msg" role="alert" aria-live="polite" data-tone={note.tone}>{note.text}</div>;

  if (statusQ.isPending) return <Skeleton rows={4} />;
  if (statusQ.isError) return <ErrorBox what="the Gmail connection" onRetry={() => statusQ.refetch()} />;
  const s = statusQ.data;
  if (!s.configured) {
    return (
      <div className="info-note warn" role="status">
        {admin ? 'Gmail is not set up on the server: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to its settings, then reload.' : 'Gmail is not set up yet.'}
      </div>
    );
  }
  if (!s.connected) {
    return (
      <>
        {message}
        <EmptyBox icon="mail">
          <div>No Gmail inbox is connected.</div>
          <div className="muted small gmail-empty-note">
            {admin ? 'Connect the inbox where leads reply. The dashboard only reads it: it never sends, deletes or changes mail.' : 'Ask an admin to connect it.'}
          </div>
          {admin && <div className="gmail-empty-action">{connectButton()}</div>}
        </EmptyBox>
      </>
    );
  }

  // The access ended (Google's 7-day Testing limit, a password change, removed access): offer to connect again.
  const ended = ['reconnect', 'not_connected'].includes(listQ.error?.data?.code);
  const data = listQ.data;
  const items = data?.items ?? [];
  let body;
  if (listQ.isPending) body = <Skeleton rows={5} />;
  else if (ended) {
    body = (
      <div className="notice gmail-ended" role="alert">
        <div>{listQ.error.message}</div>
        {admin && <div className="gmail-empty-action">{connectButton('Connect Gmail again')}</div>}
      </div>
    );
  } else if (listQ.isError && !data) {
    body = (
      <>
        <div className="notice">{listQ.error.message}</div>
        <ErrorBox what="the Gmail inbox" onRetry={() => listQ.refetch()} />
      </>
    );
  } else if (!items.length) {
    body = (
      <EmptyBox icon="mail">
        {q ? 'No emails match the search.' : view === 'leads' ? 'No emails from the people the agent emailed.' : 'The inbox is empty.'}
      </EmptyBox>
    );
  } else {
    body = (
      <div className={`table-wrap${listQ.isFetching ? ' busy' : ''}`} key={pageToken} aria-busy={listQ.isFetching || undefined}>
        <table>
          <thead><tr><th>From</th><th>Subject</th><th>Received</th><th className="view">View</th></tr></thead>
          <tbody>
            {items.map((m, i) => (
              <tr
                key={m.id} tabIndex={0} className={`click-row gmail-row${m.unread ? ' unread' : ''}`}
                onClick={() => setOpen(i)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(i); }}
              >
                <td>
                  <div className="name ellip" title={m.from.email}>{sender(m)}</div>
                  {m.lead ? <Badge text="Lead" tone="blue" title={m.lead.company || m.lead.name || 'A lead'} /> : <div className="muted small ellip">{m.from.email}</div>}
                </td>
                <td><div className="ellip">{m.subject || '(no subject)'}</div><div className="muted small ellip">{m.snippet}</div></td>
                <td className="muted when">{fmtDate(m.date, 'table')}</td>
                <td className="view"><span aria-label="View"><Icon name="eye" /></span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <div className="gmail-bar">
        <span className="muted small">
          Read only · <b>{s.email}</b>
          {listQ.dataUpdatedAt > 0 && ` · updated ${fmtTime(listQ.dataUpdatedAt)}`}
        </span>
        <div className="row">
          <button className="btn small-btn" type="button" disabled={listQ.isFetching} onClick={() => listQ.refetch()}>
            {listQ.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {admin && <button className="btn small-btn" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>}
        </div>
      </div>
      {message}
      <div className="history-tools">
        <SearchBox value={q} onSearch={search} placeholder="Search Gmail (e.g. from:name, subject:demo)" maxLength={200} />
      </div>
      {listQ.isError && data && <div className="notice">{listQ.error.message}</div>}
      {body}
      {data && (pages.length > 1 || data.nextPageToken) && (
        <nav className="pager" aria-label="Pages">
          <span className="muted small">Page {pages.length}</span>
          <div className="row">
            <button className="btn" type="button" disabled={pages.length <= 1 || listQ.isFetching} onClick={() => setPages(pages.slice(0, -1))}>
              <Icon name="chevL" /> Previous
            </button>
            <button className="btn" type="button" disabled={!data.nextPageToken || listQ.isFetching} onClick={() => setPages([...pages, data.nextPageToken])}>
              Next <Icon name="chevR" />
            </button>
          </div>
        </nav>
      )}
      {open !== null && items[open] && <GmailMessage items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
      {confirmDialog}
    </>
  );
}

// One email in a dialog, as plain text, with Previous / Next through the page on screen.
function GmailMessage({ items, index, onIndex, onClose }) {
  const ref = useRef(null);
  const { goto } = useDrawer();
  const m = items[index];
  const q = useQuery({ queryKey: ['gmail', 'message', m.id], queryFn: () => getGmailMessage(m.id), staleTime: 5 * 60_000 });
  useEffect(() => { ref.current?.showModal(); }, []);
  const d = q.data;
  const lead = d?.lead ?? m.lead;
  const openLead = () => { onClose(); goto('dashboard', 'lead', lead.id); };

  return (
    <dialog
      ref={ref}
      className="confirm file-view gmail-view"
      aria-labelledby="gmail-view-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} // click outside the card = backdrop
    >
      <div className="confirm-card">
        <div className="file-view-head">
          <h2 id="gmail-view-title" className="confirm-title">{m.subject || '(no subject)'}</h2>
          <div className="row">
            <button className="sq" type="button" aria-label="Previous email" disabled={index <= 0} onClick={() => onIndex(index - 1)}><Icon name="chevL" /></button>
            <button className="sq" type="button" aria-label="Next email" disabled={index >= items.length - 1} onClick={() => onIndex(index + 1)}><Icon name="chevR" /></button>
            <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" autoFocus><Icon name="close" /></button>
          </div>
        </div>
        <div className="meta">
          <MetaRow k="From">{sender(m)}{m.from.name && <div className="muted small">{m.from.email}</div>}</MetaRow>
          {d?.to && <MetaRow k="To">{d.to}</MetaRow>}
          {d?.cc && <MetaRow k="Cc">{d.cc}</MetaRow>}
          <MetaRow k="Received">{fmtDate(m.date)}</MetaRow>
          {lead && (
            <MetaRow k="Lead">
              {lead.company || lead.name || 'A lead'}{' '}
              <button className="btn small-btn" type="button" onClick={openLead}><Icon name="user" /> Open lead</button>
            </MetaRow>
          )}
          {d?.attachments?.length > 0 && (
            <MetaRow k="Attachments">
              {d.attachments.map((a) => a.name).join(', ')} <span className="muted small">(open them in Gmail)</span>
            </MetaRow>
          )}
        </div>
        <div className="file-view-body gmail-body">
          {q.isPending && <Skeleton rows={6} />}
          {q.isError && <div className="notice">{q.error.message}</div>}
          {d && (d.body ? <div className="content"><FormattedContent text={d.body} /></div> : <div className="muted">This email has no text.</div>)}
        </div>
      </div>
    </dialog>
  );
}
