'use client';
// Page 2: History: emails sent (searchable and filterable on the server) and the replies received in Gmail.
import { memo, useMemo } from 'react';
import { OpenRow } from './OpenRow';
import { useList } from './DataProvider';
import { Badge, CardHead, ViewCell, DataTable, Pager, SearchBox } from './ui';
import GmailInbox from './GmailInbox';
import { pad, fmtDate, toneOf } from '@/core/format';

const SENT_FILTERS = [['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed']];

// One row; unchanged items keep their element, so a page turn or filter only renders what changed.
const HistoryRow = memo(function HistoryRow({ kind, item, row }) {
  return <OpenRow kind={kind} id={item.id}>{row(item)}</OpenRow>;
});

function HistoryCard({ section, icon, title, totalLabel, extra, kind, emptyText, head, row, tools }) {
  const list = useList(section);
  const { status, data, reload, fetching, listFilter, setListFilter } = list;
  const filtered = !!listFilter && Object.entries(listFilter).some(([k, v]) => (k === 'q' ? v : v !== 'all'));
  const rows = useMemo(
    () => data.items.map((x) => <HistoryRow key={x.id} kind={kind} item={x} row={row} />),
    [data.items, kind, row],
  );
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
        rows={rows}
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
        <RepliesCard />
      </div>
    </main>
  );
}

// Replies Received: the connected Gmail inbox, read only. The dashboard backend reads every reply from it (Positive
// Leads); here it is shown as it is.
function RepliesCard() {
  return (
    <div className="card">
      <CardHead icon="chat" title="Replies Received" />
      <GmailInbox />
    </div>
  );
}
