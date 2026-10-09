'use client';
// Campaign page: summary (running now, upcoming, total), filters + search, and one card per campaign (status, dates,
// progress while it runs, details). Everyone signed in can see them; admins add and edit in a dialog, switch active
// on or off, and delete. Data: app/api/campaigns -> Supabase table public.campaign.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatCards, Badge, Skeleton, ErrorBox, EmptyBox } from './ui';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import * as campaigns from '@/core/campaigns';
import { getSession, isAdmin } from '@/core/auth';

const EMPTY = { campaignName: '', campaignDetail: '', startDate: '', endDate: '', isActive: true };
const DAY = 86400000;

// Calendar dates ('YYYY-MM-DD') as whole days, so time zones never shift them.
const dayNo = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY);
const todayYmd = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const fmt = (ymd, withYear) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear && { year: 'numeric' }) });
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Where a campaign stands today: key (for the filters), badge, a short note and, while it runs, how far along it is.
function stateOf(c, today) {
  const days = dayNo(c.endDate) - dayNo(c.startDate) + 1;
  const t = dayNo(today);
  if (!c.isActive) return { key: 'inactive', label: 'Inactive', tone: 'gray', note: 'Switched off', days };
  if (t > dayNo(c.endDate)) {
    const ago = t - dayNo(c.endDate);
    const note = ago === 1 ? 'Ended yesterday' : ago <= 30 ? `Ended ${plural(ago, 'day')} ago` : `Ended ${fmt(c.endDate, true)}`;
    return { key: 'ended', label: 'Ended', tone: 'gray', note, days };
  }
  if (t < dayNo(c.startDate)) {
    const wait = dayNo(c.startDate) - t;
    return { key: 'upcoming', label: 'Upcoming', tone: 'blue', note: wait === 1 ? 'Starts tomorrow' : `Starts in ${plural(wait, 'day')}`, days };
  }
  const day = t - dayNo(c.startDate) + 1;
  const left = days - day;
  return {
    key: 'running', label: 'Running', tone: 'green', days, progress: day / days,
    note: `Day ${day} of ${days} · ${left === 0 ? 'last day' : `${plural(left, 'day')} left`}`,
  };
}

const FILTERS = [['all', 'All'], ['running', 'Running'], ['upcoming', 'Upcoming'], ['ended', 'Ended'], ['inactive', 'Inactive']];

// ---------- Add / edit dialog ----------

function CampaignDialog({ initial, onClose, onSaved }) {
  const ref = useRef(null);
  const [form, setForm] = useState(initial ? { ...initial } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);

  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setError(''); };
  const valid = form.startDate && form.endDate && form.endDate >= form.startDate;
  const days = valid ? dayNo(form.endDate) - dayNo(form.startDate) + 1 : 0;

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.campaignName.trim()) return setError('Enter the campaign name.');
    if (!form.startDate || !form.endDate) return setError('Pick the start and end dates.');
    if (form.endDate < form.startDate) return setError('The end date must be on or after the start date.');
    setBusy(true);
    try {
      const fields = { campaignName: form.campaignName, campaignDetail: form.campaignDetail, startDate: form.startDate, endDate: form.endDate, isActive: form.isActive };
      onSaved(initial ? await campaigns.updateCampaign(initial.id, fields) : await campaigns.createCampaign(fields), !initial);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirm campaign-dialog"
      aria-labelledby="campaign-dialog-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} // click outside the card = backdrop
    >
      <form className="confirm-card campaign-form" noValidate onSubmit={onSubmit}>
        <div className="campaign-dialog-head">
          <h2 id="campaign-dialog-title" className="confirm-title">{initial ? 'Edit campaign' : 'New campaign'}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" disabled={busy}><Icon name="close" /></button>
        </div>
        <label className="field">
          <span>Campaign name</span>
          <input value={form.campaignName} onChange={set('campaignName')} maxLength={200} autoComplete="off" placeholder="e.g. Diwali AOSP services push" autoFocus required />
        </label>
        <div className="campaign-dates">
          <label className="field"><span>Start date</span><input type="date" value={form.startDate} onChange={set('startDate')} required /></label>
          <label className="field"><span>End date</span><input type="date" value={form.endDate} min={form.startDate || undefined} onChange={set('endDate')} required /></label>
        </div>
        <div className="muted small campaign-length">{days ? `Runs for ${plural(days, 'day')}` : ' '}</div>
        <label className="field">
          <span>Details <span className="muted small">(optional)</span></span>
          <textarea value={form.campaignDetail} onChange={set('campaignDetail')} maxLength={5000} rows={5} placeholder="Goal, audience, channels…" />
          <span className="muted small campaign-count">{form.campaignDetail.length}/5000</span>
        </label>
        <div className="campaign-switch-row">
          <div>
            <div className="campaign-switch-label">Active</div>
            <div className="muted small">Inactive campaigns stay in the list but are switched off.</div>
          </div>
          <Switch on={form.isActive} label="Active" onChange={() => setForm({ ...form, isActive: !form.isActive })} />
        </div>
        {error && <div className="confirm-error" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn primary${busy ? ' loading' : ''}`} type="submit" disabled={busy}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const Switch = ({ on, label, disabled, onChange }) => (
  <button
    type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
    className={`switch${on ? ' on' : ''}`} onClick={onChange}
  >
    <span />
  </button>
);

// ---------- One campaign ----------

function CampaignCard({ c, state, admin, working, onToggle, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  const long = c.campaignDetail.length > 180 || c.campaignDetail.split('\n').length > 3;
  const sameYear = c.startDate.slice(0, 4) === c.endDate.slice(0, 4);
  return (
    <article className={`campaign-card ${state.key}`}>
      <div className="campaign-top">
        <h3 className="campaign-name">{c.campaignName}</h3>
        <Badge text={state.label} tone={state.tone} />
      </div>
      <div className="campaign-when">
        <Icon name="calendar" />
        <span>{fmt(c.startDate, !sameYear)} – {fmt(c.endDate, true)}</span>
        <span className="muted">· {plural(state.days, 'day')}</span>
      </div>
      {state.key === 'running' && (
        <div className="campaign-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} aria-label="Campaign progress">
          <span style={{ width: `${Math.max(4, state.progress * 100)}%` }} />
        </div>
      )}
      <div className="muted small campaign-note">{state.note}</div>
      {c.campaignDetail ? (
        <div className="campaign-detail-box">
          <p className={`campaign-detail${open ? ' open' : ''}`}>{c.campaignDetail}</p>
          {long && <button className="detail-toggle" type="button" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
        </div>
      ) : <p className="muted small campaign-detail-empty">No details.</p>}
      {admin && (
        <div className="campaign-foot">
          <label className="campaign-toggle">
            <Switch on={c.isActive} label={`${c.campaignName} active`} disabled={working} onChange={() => onToggle(c)} />
            <span className="small">{c.isActive ? 'Active' : 'Inactive'}</span>
          </label>
          <div className="campaign-actions">
            <button className="btn small-btn" type="button" onClick={() => onEdit(c)}><Icon name="edit" /> Edit</button>
            <button className="btn danger small-btn" type="button" disabled={working} onClick={() => onDelete(c)} aria-label={`Delete ${c.campaignName}`}><Icon name="trash" /></button>
          </div>
        </div>
      )}
    </article>
  );
}

// ---------- Page ----------

export default function CampaignsView() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [items, setItems] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [admin, setAdmin] = useState(false);
  const [dialog, setDialog] = useState(null); // null | { campaign } (campaign null = new)
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [working, setWorking] = useState(null); // id of the card being switched or deleted
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [confirmDialog, confirm] = useConfirm();
  const today = todayYmd();

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setItems(await campaigns.listCampaigns());
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message);
      setStatus('error');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);

  // Success messages clear themselves after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (msg.tone !== 'ok' || !msg.text) return undefined;
    const t = setTimeout(() => setMsg({ text: '', tone: 'error' }), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  // Running first (ending soonest), then upcoming (starting soonest), then ended (latest first), then inactive.
  const withState = useMemo(() => {
    const rank = { running: 0, upcoming: 1, ended: 2, inactive: 3 };
    return items
      .map((c) => ({ c, s: stateOf(c, today) }))
      .sort((a, b) => rank[a.s.key] - rank[b.s.key]
        || (a.s.key === 'running' ? a.c.endDate.localeCompare(b.c.endDate)
          : a.s.key === 'upcoming' ? a.c.startDate.localeCompare(b.c.startDate)
            : b.c.endDate.localeCompare(a.c.endDate)));
  }, [items, today]);

  const counts = useMemo(() => {
    const out = { all: withState.length, running: 0, upcoming: 0, ended: 0, inactive: 0 };
    for (const { s } of withState) out[s.key] += 1;
    return out;
  }, [withState]);

  const q = query.trim().toLowerCase();
  const shown = withState.filter(({ c, s }) => (filter === 'all' || s.key === filter)
    && (!q || c.campaignName.toLowerCase().includes(q) || c.campaignDetail.toLowerCase().includes(q)));

  function onSaved(saved, isNew) {
    setDialog(null);
    setItems((list) => (isNew ? [saved, ...list] : list.map((c) => (c.id === saved.id ? saved : c))));
    setMsg({ text: `${isNew ? 'Created' : 'Saved'} "${saved.campaignName}".`, tone: 'ok' });
  }

  async function onToggle(c) {
    setWorking(c.id);
    setMsg({ text: '', tone: 'error' });
    try {
      const saved = await campaigns.updateCampaign(c.id, { isActive: !c.isActive });
      setItems((list) => list.map((x) => (x.id === saved.id ? saved : x)));
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setWorking(null);
    }
  }

  async function onDelete(c) {
    const ok = await confirm({
      title: `Delete "${c.campaignName}"?`,
      message: 'It is removed from Supabase for good. To keep it but switch it off, make it inactive instead.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setWorking(c.id);
    setMsg({ text: '', tone: 'error' });
    try {
      await campaigns.deleteCampaign(c.id);
      setItems((list) => list.filter((x) => x.id !== c.id));
      setMsg({ text: `Deleted "${c.campaignName}".`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setWorking(null);
    }
  }

  let body;
  if (status === 'loading') body = <div className="campaign-grid">{[0, 1, 2].map((i) => <div key={i} className="campaign-card"><Skeleton rows={4} /></div>)}</div>;
  else if (status === 'error') {
    body = (
      <>
        {loadError && <div className="notice">{loadError}</div>}
        <ErrorBox what="the campaigns" onRetry={load} />
      </>
    );
  } else if (!items.length) {
    body = (
      <EmptyBox icon="bolt">
        No campaigns yet.
        {admin && <div className="campaign-empty-cta"><button className="btn primary" type="button" onClick={() => setDialog({ campaign: null })}><Icon name="plus" /> Create the first campaign</button></div>}
      </EmptyBox>
    );
  } else if (!shown.length) {
    body = <EmptyBox icon="bolt">No campaigns match{q ? ` "${query.trim()}"` : ''}{filter !== 'all' ? ` in ${FILTERS.find(([k]) => k === filter)[1]}` : ''}.</EmptyBox>;
  } else {
    body = (
      <div className="campaign-grid">
        {shown.map(({ c, s }) => (
          <CampaignCard
            key={c.id} c={c} state={s} admin={admin} working={working === c.id}
            onToggle={onToggle} onEdit={(x) => setDialog({ campaign: x })} onDelete={onDelete}
          />
        ))}
      </div>
    );
  }

  const ready = status === 'ready';
  return (
    <main className="page">
      <div className="page-head campaign-head">
        <div>
          <h1 className="page-title">Campaign</h1>
          <p className="muted">What is running now, what is coming up, and everything that ran before.</p>
        </div>
        {admin && <button className="btn primary" type="button" onClick={() => setDialog({ campaign: null })}><Icon name="plus" /> New campaign</button>}
      </div>
      <div className="stack-v">
        <StatCards
          items={[
            { label: 'Running now', icon: 'play', tone: 'green', value: counts.running, status: ready ? 'ready' : status, onRetry: load },
            { label: 'Upcoming', icon: 'clock', tone: 'amber', value: counts.upcoming, status: ready ? 'ready' : status, onRetry: load },
            { label: 'Total campaigns', icon: 'bolt', value: counts.all, status: ready ? 'ready' : status, onRetry: load },
          ]}
        />
        <section className="card">
          <div className="campaign-toolbar">
            <div className="chip-group" role="tablist" aria-label="Filter campaigns">
              {FILTERS.map(([k, label]) => (
                <button
                  key={k} type="button" role="tab" aria-selected={filter === k}
                  className={`chip${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}
                >
                  {label}{ready && <span className="chip-count">{counts[k]}</span>}
                </button>
              ))}
            </div>
            <input
              className="search-input" type="search" placeholder="Search campaigns" aria-label="Search campaigns"
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {msg.text && <div className="auth-msg campaign-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>}
          {body}
        </section>
      </div>
      {dialog && (
        <CampaignDialog
          initial={dialog.campaign}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}
      {confirmDialog}
    </main>
  );
}
