// Small presentational pieces shared by every page and the drawer.
import { Icon } from './Icon';
import { SOURCES, toneOf } from '@/core/format';

export const Badge = ({ text, tone }) => <span className={`badge ${tone}`}>{text}</span>;
export const StatusBadge = ({ text }) => <Badge text={text} tone={toneOf(text)} />;

export const SourceCell = ({ source }) => (
  <span className="src"><Icon name={SOURCES[source].icon} />{SOURCES[source].label}</span>
);

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

// Table for a loadable section: skeleton / error / empty / table.
export function DataTable({ status, head, rows, emptyIcon, emptyText, what, onRetry }) {
  if (status === 'loading') return <Skeleton />;
  if (status === 'error') return <ErrorBox what={what} onRetry={onRetry} />;
  if (!rows.length) return <EmptyBox icon={emptyIcon}>{emptyText}</EmptyBox>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{head}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
