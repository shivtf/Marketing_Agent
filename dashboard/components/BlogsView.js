'use client';
// Page 3: Blogs. Weekly Blog Files (the week's JSON, stored as is in Supabase Storage for the publishing backend), the
// Blog Plan (briefs uploaded as JSON, scheduled by date; dashboardbackend/BLOG_PLAN.md), and the Blog Tracker
// (blogs written so far).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OpenRow } from './OpenRow';
import { useList, useSection } from './DataProvider';
import { Badge, CardHead, StatusBadge, SiteCell, ViewCell, DataTable, Pager, Skeleton, ErrorBox, EmptyBox } from './ui';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import * as api from '@/core/api';
import { getSession, isAdmin } from '@/core/auth';
import { pad, fmtDate, fmtDay, weekOf, PLAN_STATUS } from '@/core/format';
import { listWeeklyFiles, getWeeklyFile, uploadWeeklyFile, weekChoices } from '@/core/blogFiles';

const StatBox = ({ label, value, color }) => (
  <div className="stat-box">
    <div className="muted small"><span className="dot" style={{ background: color }} />{label}</div>
    <div className="big">{value}</div>
  </div>
);

function useIsAdmin() {
  const [admin, setAdmin] = useState(false);
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);
  return admin;
}

// ---------- Upload: choose a file -> check it (dry run) -> preview -> Import ----------

const ACTIONS = { new: ['New', 'blue'], update: ['Update', 'amber'], skipped: ['Skipped (posted)', 'gray'] };

function PlanPreview({ report, busy, onImport, onCancel }) {
  const { items, errors, warnings } = report;
  return (
    <div className="plan-preview">
      <div className="plan-preview-head">
        <b>Check the plan before importing</b>
        <span className="muted small">
          {items.length} ready{errors.length ? ` · ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix` : ''}
        </span>
      </div>
      {errors.length > 0 && (
        <ul className="plan-issues error-list">
          {errors.map((e, i) => <li key={i}><b>{e.id || 'File'}</b>{e.field && ` · ${e.field}`}: {e.message}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="plan-issues warn-list">
          {warnings.map((w, i) => <li key={i}>{w.id && <b>{w.id}: </b>}{w.message}</li>)}
        </ul>
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>ID</th><th>Topic</th><th>Category</th><th>Will be</th></tr></thead>
            <tbody>
              {items.map((it) => {
                const [label, tone] = ACTIONS[it.action];
                return (
                  <tr key={it.id}>
                    <td className="nowrap">{fmtDay(it.publishDate)}</td><td className="mono">{it.id}</td>
                    <td><div className="ellip wide">{it.topic}</div></td><td>{it.category}</td>
                    <td><Badge text={label} tone={tone} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row plan-actions">
        <button className="btn primary" type="button" disabled={busy || errors.length > 0 || !items.length} onClick={onImport}>
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        {errors.length > 0 && <span className="muted small">Fix the problems in the file and upload it again.</span>}
      </div>
    </div>
  );
}

function PlanUpload() {
  const client = useQueryClient();
  const input = useRef(null);
  const [preview, setPreview] = useState(null); // { text, report }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still triggers a check
    if (!file) return;
    setMsg({ text: '', tone: 'error' });
    setPreview(null);
    const text = await file.text();
    try {
      JSON.parse(text);
    } catch {
      setMsg({ text: `${file.name} is not valid JSON. Check for a missing comma or bracket.`, tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      setPreview({ text, report: await api.importBlogPlan(text, { dryRun: true }) });
    } catch (err) {
      setMsg({ text: `Couldn't check the file: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    setBusy(true);
    try {
      const r = await api.importBlogPlan(preview.text);
      setPreview(null);
      const parts = [`${r.created} new`, `${r.updated} updated`, r.skipped && `${r.skipped} skipped (already posted)`];
      setMsg({ text: `Imported: ${parts.filter(Boolean).join(', ')}.`, tone: 'ok' });
      client.invalidateQueries({ queryKey: ['section', 'plan'] });
    } catch (err) {
      setMsg({ text: `Couldn't import: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plan-upload">
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={onFile} />
      <button className="btn outline" type="button" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="doc" /> {busy && !preview ? 'Checking…' : 'Upload blog plan'}
      </button>
      {msg.text && <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>}
      {preview && (
        <PlanPreview report={preview.report} busy={busy} onImport={onImport} onCancel={() => setPreview(null)} />
      )}
    </div>
  );
}

// ---------- Weekly Blog Files: pick the week -> choose the JSON -> saved in Supabase Storage as <week>.json ----------

function WeeklyFilesCard({ admin }) {
  const weeks = weekChoices();
  const [week, setWeek] = useState(weeks[1].week); // next week
  const [files, setFiles] = useState({ status: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [confirmDialog, confirm] = useConfirm();
  const input = useRef(null);
  const chosen = weeks.find((w) => w.week === week);

  const load = () => listWeeklyFiles()
    .then((items) => setFiles({ status: 'ready', items }))
    .catch(() => setFiles({ status: 'error', items: [] }));
  useEffect(() => { load(); }, []);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still triggers an upload
    if (!file) return;
    setMsg({ text: '', tone: 'error' });
    const text = await file.text();
    try {
      JSON.parse(text);
    } catch {
      setMsg({ text: `${file.name} is not valid JSON. Check for a missing comma or bracket.`, tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      let r;
      try {
        r = await uploadWeeklyFile(week, text);
      } catch (err) {
        if (err.status !== 409) throw err;
        const ok = await confirm({
          title: `Replace ${chosen.fileName}?`,
          message: `There is already a file for ${chosen.label.replace(/ \(.*/, '')}. The new one replaces it.`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok) return;
        r = await uploadWeeklyFile(week, text, true);
      }
      setMsg({ text: `${r.replaced ? 'Replaced' : 'Saved'} ${r.name} in Supabase Storage.`, tone: 'ok' });
      load();
    } catch (err) {
      setMsg({ text: `Couldn't upload: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(name) {
    try {
      const { text } = await getWeeklyFile(name);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMsg({ text: `Couldn't download ${name}: ${err.message}`, tone: 'error' });
    }
  }

  let body;
  if (files.status === 'loading') body = <Skeleton rows={3} />;
  else if (files.status === 'error') body = <ErrorBox what="the weekly blog files" onRetry={load} />;
  else if (!files.items.length) body = <EmptyBox icon="doc">No weekly blog files yet.{admin ? ' Pick a week and upload its JSON.' : ''}</EmptyBox>;
  else {
    body = (
      <div className="table-wrap">
        <table>
          <thead><tr><th>File</th><th>Uploaded</th><th>Size</th><th className="view" /></tr></thead>
          <tbody>
            {files.items.map((f) => (
              <tr key={f.name}>
                <td className="mono">{f.name}</td>
                <td className="nowrap">{fmtDate(f.updatedAt)}</td>
                <td className="muted">{f.size == null ? '—' : `${Math.max(1, Math.round(f.size / 1024))} KB`}</td>
                <td className="view"><button className="btn small-btn" type="button" onClick={() => onDownload(f.name)}>Download</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="card">
      <CardHead icon="calendar" title="Weekly Blog Files" />
      {admin && (
        <div className="plan-upload">
          <div className="row week-pick">
            <select className="select" value={week} onChange={(e) => setWeek(e.target.value)} disabled={busy} aria-label="Week">
              {weeks.map((w) => <option key={w.week} value={w.week}>{w.label}</option>)}
            </select>
            <input ref={input} type="file" accept="application/json,.json" hidden onChange={onFile} />
            <button className="btn outline" type="button" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="doc" /> {busy ? 'Uploading…' : 'Upload week JSON'}
            </button>
          </div>
          <div className="muted small">Saved in Supabase Storage as <span className="mono">{chosen.fileName}</span></div>
          {msg.text && <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>}
        </div>
      )}
      {body}
      {confirmDialog}
    </div>
  );
}

// ---------- Blog Plan: counts + schedule by week ----------

function BlogPlanCard({ admin }) {
  const { status, data, reload } = useSection('plan');
  const client = useQueryClient();
  const [confirmDialog, confirm] = useConfirm();
  const [error, setError] = useState('');

  async function onCancel(e, item) {
    e.stopPropagation(); // the row itself opens the drawer
    const ok = await confirm({
      title: `Cancel "${item.topic}"?`,
      message: `It comes off the schedule for ${fmtDay(item.publishDate)}. Uploading it again puts it back.`,
      confirmLabel: 'Cancel blog',
      danger: true,
    });
    if (!ok) return;
    setError('');
    try {
      await api.cancelBlogPlanEntry(item.id);
      client.invalidateQueries({ queryKey: ['section', 'plan'] });
    } catch (err) {
      setError(`Couldn't cancel: ${err.message}`);
    }
  }

  let body;
  if (status === 'loading') body = <Skeleton rows={4} />;
  else if (status === 'error') body = <ErrorBox what="the blog plan" onRetry={reload} />;
  else if (!data.items.length) {
    body = <EmptyBox icon="calendar">No blog plan yet.{admin ? ' Upload a JSON file to schedule blogs.' : ''}</EmptyBox>;
  } else {
    const rows = [];
    let week = null;
    for (const item of data.items) {
      const w = weekOf(item.publishDate);
      if (w !== week) {
        week = w;
        rows.push(<tr key={`w-${w}`} className="week-row"><th colSpan={admin ? 5 : 4}>Week of {fmtDay(w).replace(/^\w+, /, '')}</th></tr>);
      }
      const label = PLAN_STATUS[item.status] || item.status;
      const canCancel = admin && !['posted', 'cancelled'].includes(item.status);
      rows.push(
        <OpenRow key={item.id} kind="plan" id={item.id}>
          <td className="nowrap">{fmtDay(item.publishDate)}</td>
          <td className="name"><div className={`ellip wide${item.status === 'cancelled' ? ' struck' : ''}`}>{item.topic}</div></td>
          <td className="muted">{item.category}</td>
          <td><StatusBadge text={label} /></td>
          {admin && (
            <td className="view">
              {canCancel && <button className="btn danger small-btn" type="button" onClick={(e) => onCancel(e, item)}>Cancel</button>}
            </td>
          )}
        </OpenRow>,
      );
    }
    body = (
      <DataTable
        status="ready" rows={rows} what="the blog plan" emptyIcon="calendar" emptyText=""
        head={<><th>Date</th><th>Blog</th><th>Category</th><th>Status</th>{admin && <th className="view" />}</>}
      />
    );
  }

  const posted = data?.byStatus?.posted ?? 0;
  const next = data?.next;
  return (
    <div className="card">
      <div className="blog-top">
        <CardHead icon="calendar" title="Blog Plan" />
        {status === 'ready' && data.items.length > 0 && (
          <div className="stats plan-stats">
            <StatBox label="Planned blogs" value={data.total} color="var(--accent)" />
            <StatBox label="This week" value={data.thisWeek} color="var(--amber)" />
            <StatBox label="Posted" value={posted} color="var(--green)" />
            <div className="stat-box next-box">
              <div className="muted small"><span className="dot" style={{ background: 'var(--muted)' }} />Next blog</div>
              {next ? <div><b>{fmtDay(next.publishDate)}</b><div className="small ellip wide">{next.topic}</div></div> : <div className="muted">None scheduled</div>}
            </div>
          </div>
        )}
      </div>
      {admin && <PlanUpload />}
      {error && <div className="notice">{error}</div>}
      {body}
      {confirmDialog}
    </div>
  );
}

// ---------- Page ----------

export default function BlogsView() {
  const admin = useIsAdmin();
  const list = useList('blogs');
  const { status, data, reload, fetching } = list;
  const ready = status === 'ready';
  const posted = data.posted ?? 0; // across all posts, not just this page
  return (
    <main className="page">
      <div className="page-head"><h1 className="page-title">Blogs</h1><p className="muted">The blog plan by date, and every blog written so far.</p></div>
      <div className="stack-v">
        <WeeklyFilesCard admin={admin} />
        <BlogPlanCard admin={admin} />
        <div className="card">
          <div className="blog-top">
            <div>
              <CardHead icon="doc" title="Blog Tracker" />
              {ready && <div className="total-block"><div className="muted small">Total Blogs</div><div className="big">{data.total}</div></div>}
            </div>
            {ready && (
              <div className="stats">
                <StatBox label="Posted" value={posted} color="var(--green)" />
                <StatBox label="Not Posted" value={data.total - posted} color="var(--amber)" />
              </div>
            )}
          </div>
          <DataTable
            status={status} emptyIcon="doc" emptyText="No blogs yet" what="blogs" onRetry={reload}
            head={<><th>#</th><th>Blog Topic/Title</th><th>Status</th><th>Posted On</th><th className="view">View</th></>}
            busy={fetching} scrollKey={data.page}
            rows={data.items.map((b) => (
              <OpenRow key={b.id} kind="blog" id={b.id}>
                <td className="num">{pad(b.number)}</td><td className="name"><div className="ellip wide">{b.title}</div></td>
                <td><StatusBadge text={b.status} /></td><td><SiteCell site={b.site} /></td><ViewCell />
              </OpenRow>
            ))}
          />
          <Pager list={list} />
        </div>
      </div>
    </main>
  );
}
