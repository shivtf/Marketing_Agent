'use client';
// Page 2: History (emails sent + replies received), each searchable and filterable on the server.
import { useEffect, useState } from 'react';
import { OpenRow } from './OpenRow';
import { useList } from './DataProvider';
import { Badge, CardHead, ViewCell, DataTable, Pager } from './ui';
import { pad, fmtDate, replyLabel, toneOf } from '@/core/format';

// Search box that waits until typing pauses (300 ms) before asking the server.
function SearchBox({ value, onSearch, placeholder }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => { if (text.trim() !== value) onSearch(text.trim()); }, 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps -- only typing starts a search
  return (
    <input
      className="search-input" type="search" placeholder={placeholder} aria-label={placeholder}
      value={text} onChange={(e) => setText(e.target.value)} maxLength={100}
    />
  );
}

const SENT_FILTERS = [['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed']];
const REPLY_FILTERS = [
  ['all', 'All replies'], ['human', 'From people (no auto-replies)'], ['interested', 'Interested'], ['question', 'Question'],
  ['not_interested', 'Not interested'], ['unsubscribe', 'Unsubscribed'], ['ooo', 'Out of office'], ['bounce', 'Bounced'],
  ['unclassified', 'Not classified yet'],
];

function HistoryCard({ section, icon, title, totalLabel, extra, kind, emptyText, head, row, tools }) {
  const list = useList(section);
  const { status, data, reload, fetching, listFilter, setListFilter } = list;
  const filtered = !!listFilter && Object.entries(listFilter).some(([k, v]) => (k === 'q' ? v : v !== 'all'));
  return (
    <div className="card">
      <CardHead icon={icon} title={title} />
      {status === 'ready' && (
        <div className="total-block">
          <div className="muted small">{filtered ? 'Matching' : totalLabel}</div>
          <div className="big">{data.total}</div>
          {extra && <div className="muted small">{extra(data)}</div>}
        </div>
      )}
      <div className="history-tools">{tools(listFilter, setListFilter)}</div>
      <DataTable
        status={status}
        head={head}
        emptyIcon={icon}
        emptyText={filtered ? 'Nothing matches the search or filter' : emptyText}
        what={title.toLowerCase()}
        onRetry={reload}
        busy={fetching}
        scrollKey={data.page}
        rows={data.items.map((x) => <OpenRow key={x.id} kind={kind} id={x.id}>{row(x)}</OpenRow>)}
      />
      <Pager list={list} />
    </div>
  );
}

export default function HistoryView() {
  return (
    <main className="page">
      <div className="page-head"><h1 className="page-title">History</h1><p className="muted">All emails sent and replies received.</p></div>
      <div className="grid2 top">
        <HistoryCard
          section="sent" icon="send" title="Emails Sent" totalLabel="Total Emails Sent" kind="sent" emptyText="No emails sent yet"
          extra={(d) => (d.failed ? `${d.failed} failed (bounced)` : 'None failed')}
          tools={(f, set) => (
            <>
              <SearchBox value={f.q} onSearch={(q) => set({ q })} placeholder="Search recipient, company, subject" />
              <div className="chip-group" role="group" aria-label="Filter by status">
                {SENT_FILTERS.map(([k, label]) => (
                  <button key={k} type="button" className={`chip${f.status === k ? ' active' : ''}`} aria-pressed={f.status === k} onClick={() => set({ status: k })}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          head={<><th>#</th><th>Recipient</th><th>Subject</th><th>Status</th><th>Date/Time Sent</th><th className="view">View</th></>}
          row={(e) => (
            <>
              <td className="num">{pad(e.number)}</td>
              <td><div className="name ellip">{e.to}</div>{e.company && <div className="muted small ellip">{e.company}</div>}</td>
              <td><div className="ellip">{e.subject}</div></td>
              <td><Badge text={e.deliveryStatus} tone={toneOf(e.deliveryStatus)} /></td>
              <td className="muted when">{fmtDate(e.sentAt, 'table')}</td><ViewCell />
            </>
          )}
        />
        <HistoryCard
          section="replies" icon="chat" title="Replies Received" totalLabel="Total Replies Received" kind="reply" emptyText="No replies yet"
          tools={(f, set) => (
            <>
              <SearchBox value={f.q} onSearch={(q) => set({ q })} placeholder="Search sender, company, subject" />
              <select className="select" aria-label="Filter by reply type" value={f.label} onChange={(ev) => set({ label: ev.target.value })}>
                {REPLY_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </>
          )}
          head={<><th>#</th><th>Sender Name/Email</th><th>Reply</th><th>Date/Time Received</th><th className="view">View</th></>}
          row={(r) => (
            <>
              <td className="num">{pad(r.number)}</td>
              <td><div className="name ellip">{r.senderName || '—'}</div><div className="muted small ellip">{r.company || r.senderEmail}</div></td>
              <td>
                <Badge text={replyLabel(r.label)} tone={toneOf(replyLabel(r.label))} />
                <div className="muted small ellip">{r.subject}</div>
              </td>
              <td className="muted when">{fmtDate(r.receivedAt, 'table')}</td><ViewCell />
            </>
          )}
        />
      </div>
    </main>
  );
}
