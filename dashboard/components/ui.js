// Small presentational pieces shared by every page and the drawer.
import { Icon } from './Icon';
import { sourceLabel, toneOf } from '@/core/format';

export const Badge = ({ text, tone, title }) => <span className={`badge ${tone}`} title={title}>{text}</span>;
export const StatusBadge = ({ text }) => <Badge text={text} tone={toneOf(text)} />;

export const SourceCell = ({ source }) => <span className="src">{sourceLabel(source)}</span>;

export const SiteCell = ({ site }) => (
  site ? <span className="src"><Icon name={site} />{site}</span> : <span className="muted">—</span>
);

export const Skeleton = ({ rows = 5 }) => Array.from({ length: rows }, (_, i) => <div key={i} className="skel skel-line" />);

export const ErrorBox = ({ what, onRetry }) => (
  <div className="error">
    <Icon name="alert" />
    <div>Couldn&apos;t load {what}.</div>
    <button className="btn" onClick={onRetry}>Try again</button>
  </div>
);

export const EmptyBox = ({ icon, children }) => (
  <div className="empty">
    <div className="tile"><Icon name={icon} /></div>
    <div>{children}</div>
  </div>
);

export const CardHead = ({ icon, title, children }) => (
  <div className="card-head">
    <div className="tile"><Icon name={icon} /></div>
    <div className="card-title">{title}</div>
    {children}
  </div>
);

export const MetaRow = ({ k, children }) => (
  <div className="meta-row"><span className="k">{k}</span><span className="v">{children}</span></div>
);

export const ViewCell = () => <td className="view"><span aria-label="View"><Icon name="eye" /></span></td>;

export const ExtLink = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{children} <Icon name="ext" /></a>
);

// Row of stat cards. Each item: { label, icon, tone, value, status, onRetry }.
export function StatCards({ items }) {
  return (
    <div className="grid3">
      {items.map(({ label, icon, tone = '', value, status, onRetry }) => (
        <div key={label} className="card stat">
          <div className={`tile round ${tone}`}><Icon name={icon} /></div>
          <div>
            <div className="muted">{label}</div>
            {status === 'error' && <button className="btn" onClick={onRetry}>Retry</button>}
            {status === 'loading' && <div className="skel" style={{ height: 30, width: 90 }} />}
            {status === 'ready' && <div className="big">{value}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Table for a loadable section: skeleton / error / empty / table. `busy` dims it while another page loads;
// a new `scrollKey` (e.g. the page number) starts the table scrolled to the top.
export function DataTable({ status, head, rows, emptyIcon, emptyText, what, onRetry, busy, scrollKey }) {
  if (status === 'loading') return <Skeleton />;
  if (status === 'error') return <ErrorBox what={what} onRetry={onRetry} />;
  if (!rows.length) return <EmptyBox icon={emptyIcon}>{emptyText}</EmptyBox>;
  return (
    <div className={`table-wrap${busy ? ' busy' : ''}`} key={scrollKey} aria-busy={busy || undefined}>
      <table>
        <thead><tr>{head}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

// Previous / Next under a paged table: "51–100 of 248". Hidden when everything fits on one page.
export function Pager({ list }) {
  const { data, fetching, setPage, status } = list;
  const { total, page, limit } = data;
  if (status !== 'ready' || total <= limit) return null;
  const pages = Math.ceil(total / limit);
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small">{from}–{to} of {total}</span>
      <div className="row">
        <button className="btn" type="button" disabled={page <= 1 || fetching} onClick={() => setPage(page - 1)}>
          <Icon name="chevL" /> Previous
        </button>
        <span className="pager-page small">Page {page} of {pages}</span>
        <button className="btn" type="button" disabled={page >= pages || fetching} onClick={() => setPage(page + 1)}>
          Next <Icon name="chevR" />
        </button>
      </div>
    </nav>
  );
}
