'use client';
// Campaign page: every campaign (name, details, start and end date, active or not). Everyone signed in can see them;
// admins add, edit, switch active on or off, and delete. Data: app/api/campaigns -> Supabase table public.campaign.
import { useCallback, useEffect, useState } from 'react';
import { CardHead, DataTable, Badge } from './ui';
import { useConfirm } from './ConfirmDialog';
import * as campaigns from '@/core/campaigns';
import { getSession, isAdmin } from '@/core/auth';
import { fmtDay } from '@/core/format';

const EMPTY = { campaignName: '', campaignDetail: '', startDate: '', endDate: '', isActive: true };

export default function CampaignsView() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [items, setItems] = useState([]);
  const [admin, setAdmin] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // id of the campaign in the form, or null when adding
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(null); // id of the row being switched or deleted
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [confirmDialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setItems(await campaigns.listCampaigns());
      setStatus('ready');
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
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

  const set = (k) => (e) => setForm({ ...form, [k]: k === 'isActive' ? e.target.checked : e.target.value });
  const stopEditing = () => { setEditing(null); setForm(EMPTY); };

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.campaignName.trim()) return setMsg({ text: 'Enter the campaign name.', tone: 'error' });
    if (!form.startDate || !form.endDate) return setMsg({ text: 'Pick the start and end dates.', tone: 'error' });
    if (form.endDate < form.startDate) return setMsg({ text: 'The end date must be on or after the start date.', tone: 'error' });
    setBusy(true);
    setMsg({ text: '', tone: 'error' });
    try {
      if (editing) {
        const saved = await campaigns.updateCampaign(editing, form);
        setItems((list) => list.map((c) => (c.id === saved.id ? saved : c)));
        setMsg({ text: `Saved "${saved.campaignName}".`, tone: 'ok' });
      } else {
        const created = await campaigns.createCampaign(form);
        setMsg({ text: `Added "${created.campaignName}".`, tone: 'ok' });
        await load();
      }
      stopEditing();
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function onEdit(c) {
    setEditing(c.id);
    setForm({ campaignName: c.campaignName, campaignDetail: c.campaignDetail, startDate: c.startDate, endDate: c.endDate, isActive: c.isActive });
    setMsg({ text: '', tone: 'error' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      message: 'It is removed from Supabase for good.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setWorking(c.id);
    setMsg({ text: '', tone: 'error' });
    try {
      await campaigns.deleteCampaign(c.id);
      setItems((list) => list.filter((x) => x.id !== c.id));
      if (editing === c.id) stopEditing();
      setMsg({ text: `Deleted "${c.campaignName}".`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setWorking(null);
    }
  }

  const rows = items.map((c) => (
    <tr key={c.id} className={editing === c.id ? 'selected' : undefined}>
      <td className="name">
        <b>{c.campaignName}</b>
        {c.campaignDetail && <div className="muted small campaign-detail">{c.campaignDetail}</div>}
      </td>
      <td className="nowrap">{fmtDay(c.startDate)}</td>
      <td className="nowrap">{fmtDay(c.endDate)}</td>
      <td>{c.isActive ? <Badge text="Active" tone="green" /> : <Badge text="Inactive" tone="gray" />}</td>
      {admin && (
        <td>
          <div className="user-actions">
            <button className="btn" type="button" disabled={working === c.id} onClick={() => onToggle(c)}>
              {c.isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button className="btn" type="button" onClick={() => onEdit(c)}>Edit</button>
            <button className="btn danger" type="button" disabled={working === c.id} onClick={() => onDelete(c)}>Delete</button>
          </div>
        </td>
      )}
    </tr>
  ));

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Campaign</h1>
        <p className="muted">Every campaign with its dates and whether it is active.{admin ? '' : ' Only admins can add or change campaigns.'}</p>
      </div>
      {admin && (
        <section className="card">
          <CardHead icon="bolt" title={editing ? 'Edit campaign' : 'Add campaign'} />
          <form className="campaign-form" noValidate onSubmit={onSubmit}>
            <label className="field name-field">
              <span>Campaign name</span>
              <input value={form.campaignName} onChange={set('campaignName')} maxLength={200} autoComplete="off" required />
            </label>
            <label className="field"><span>Start date</span><input type="date" value={form.startDate} onChange={set('startDate')} required /></label>
            <label className="field"><span>End date</span><input type="date" value={form.endDate} min={form.startDate || undefined} onChange={set('endDate')} required /></label>
            <label className="field detail-field">
              <span>Campaign details</span>
              <textarea value={form.campaignDetail} onChange={set('campaignDetail')} maxLength={5000} rows={3} />
            </label>
            <label className="check-field"><input type="checkbox" checked={form.isActive} onChange={set('isActive')} /> Active</label>
            <div className="row campaign-buttons">
              <button className={`btn primary${busy ? ' loading' : ''}`} type="submit" disabled={busy}>
                {editing ? 'Save changes' : 'Add campaign'}
              </button>
              {editing && <button className="btn" type="button" disabled={busy} onClick={stopEditing}>Cancel</button>}
            </div>
          </form>
          <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>
        </section>
      )}
      {!admin && msg.text && <div className="notice">{msg.text}</div>}
      <section className="card">
        <CardHead icon="bolt" title="All campaigns" />
        <DataTable
          status={status} what="campaigns" onRetry={load} rows={rows} emptyIcon="bolt" emptyText="No campaigns yet."
          head={['Campaign', 'Start', 'End', 'Status', ...(admin ? [''] : [])].map((h, i) => <th key={i}>{h}</th>)}
        />
      </section>
      {confirmDialog}
    </main>
  );
}
