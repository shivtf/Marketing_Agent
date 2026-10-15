'use client';
// One campaign with the Campaign Agent (docs/dashboard-integration (1).md, section 3): what it understood, its questions,
// the review and approval, and what the Marketing Agent does with the live version. Everything comes from one document,
// GET /api/campaigns/{id} (the agent's review_view); the page keeps no copy of its own and reads it again after every
// request. Requests go to POST /api/campaigns/{id}/requests (admins only); the agent works on them in minutes, so the page
// polls every 2 s while one is open or the agent is working.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge, ErrorBox, Skeleton } from './ui';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { useSection } from './DataProvider';
import { describeAgent } from './agent';
import { getCampaignView, sendRequest, shortHash } from '@/core/ca';
import { getSession, isAdmin } from '@/core/auth';
import { fmtDate, fmtDay, toneOf } from '@/core/format';

const WORKING = { INTERPRETING: 'Reading the campaign', RESEARCHING: 'Researching', VALIDATING: 'Checking the leadgen file' };
const STARTING = ['NEW', 'DRAFT'];
const OPEN = ['pending', 'processing'];
const POLL_MS = 2000;
const RETRY_MS = 15000; // the gateway could not be read: try again now and then

const STATE_LABEL = {
  NEW: 'Starting', DRAFT: 'Starting', INTERPRETING: 'Working', RESEARCHING: 'Working', VALIDATING: 'Working',
  CLARIFICATION_REQUIRED: 'Questions', MODEL_UNAVAILABLE: 'Model did not answer', AWAITING_REVIEW: 'Ready for review',
  VALIDATION_FAILED: 'Checks failed', PUBLISHED: 'Published', PUBLISH_FAILED: 'Publish failed', DISCARDED: 'Discarded',
};
const STATE_TONE = {
  CLARIFICATION_REQUIRED: 'amber', AWAITING_REVIEW: 'blue', VALIDATION_FAILED: 'red', MODEL_UNAVAILABLE: 'red',
  PUBLISHED: 'green', PUBLISH_FAILED: 'red', DISCARDED: 'gray',
};
const FIELD_TONE = { confirmed: 'green', inferred: 'blue', defaulted: 'gray' };
const LEVEL_TONE = { passed: 'green', failed: 'red', skipped: 'gray' };
const REQUEST_LABEL = {
  interpret: 'Start', answer: 'Answers', edit: 'Change', suggestion: 'Suggestion', approve: 'Approval',
  discard: 'Reject', rollback: 'Rollback', deactivate: 'Switch off',
};
// What to tell the user for a refused request, on top of the agent's own error_detail.
const ERROR_HINT = {
  stale_approval: 'The leadgen file changed after you looked at it. The new version is shown below: review it again.',
  stale_revision: 'The campaign changed in the meantime. It is reloaded below: try again.',
  wrong_state: 'That is not possible in the current state. The page is up to date now.',
  rate_limited: 'Too many requests in a minute. Wait a minute and try again.',
  model_unavailable: 'The language model did not answer. Try again.',
  publish_failed: 'Nothing was applied. You can approve again.',
};

const show = (v) => (Array.isArray(v) ? v.map(show).join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'));
const failedLevels = (c) => (c?.levels || []).filter((l) => l.status === 'failed');

// ---------- Small parts ----------

function Box({ title, icon, tone, children, aside }) {
  return (
    <section className={`card ca-box${tone ? ` ${tone}` : ''}`}>
      <div className="ca-box-head">
        <h2 className="panel-title">{icon && <Icon name={icon} />} {title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function AssistantStatus() {
  const { status, data } = useSection('agent');
  if (status !== 'ready' || !data) return null;
  const v = describeAgent(data);
  return (
    <div className={`ca-status ${toneOf(v.badge)}`} role="status">
      <span className={`agent-dot ${toneOf(v.badge)}`} aria-hidden="true" />
      <strong>Assistant: {v.badge}</strong>
      <span className="muted small">{v.note}</span>
    </div>
  );
}

function LastRequest({ req, paused }) {
  if (!req) return null;
  const what = REQUEST_LABEL[req.request_type] || req.request_type;
  if (OPEN.includes(req.status)) {
    return (
      <div className="info-note ca-working" role="status">
        <span className="ca-spinner" aria-hidden="true" />
        {paused ? `${what} sent. The assistant is paused: it runs this when it is resumed.` : `${what} sent. The assistant is working on it…`}
      </div>
    );
  }
  if (req.status === 'failed') {
    const issues = req.result?.issues || req.result?.errors || [];
    return (
      <div className="notice ca-failed" role="alert">
        <strong>{what} was not accepted.</strong> {req.error_detail}
        {ERROR_HINT[req.error_code] && <div>{ERROR_HINT[req.error_code]}</div>}
        {Array.isArray(issues) && issues.length > 0 && (
          <ul>{issues.map((i, n) => <li key={n}>{typeof i === 'string' ? i : i.message || show(i)}</li>)}</ul>
        )}
      </div>
    );
  }
  if (req.request_type === 'approve' && req.status === 'done') {
    const p = req.result?.pipeline;
    const ma = !p ? '' : p.restarted ? ' The Marketing Agent was restarted to take the new file.'
      : p.asked ? ' The Marketing Agent was asked to start on it.'
        : p.reason ? ` The Marketing Agent was not started (${p.reason}).` : '';
    return <div className="info-note" role="status">Approved: this campaign is live.{ma}</div>;
  }
  return null;
}

// ---------- What the agent understood ----------

function Fields({ sections }) {
  if (!sections?.length) return <p className="muted">Nothing read from the campaign yet.</p>;
  return (
    <div className="ca-sections">
      {sections.map((s) => (
        <div key={s.name} className="ca-section">
          <h3 className="ca-section-title">{s.title}</h3>
          <dl className="ca-fields">
            {s.fields.map((f) => (
              <div key={f.path} className="ca-field">
                <dt>{f.label}</dt>
                <dd>
                  <div className="ca-value">{show(f.value)}</div>
                  <div className="badges">
                    <Badge text={f.status} tone={FIELD_TONE[f.status] || 'gray'} title="Where the value came from" />
                    {f.mapping === 'proposed' && <Badge text="not applied yet" tone="amber" title="The Marketing Agent cannot use this yet" />}
                    {f.mapping === 'not_emitted' && <Badge text="for the record" tone="gray" title="Describes the campaign. It is not put in the file, and the Marketing Agent does not need it." />}
                  </div>
                  {f.evidence_quote && <blockquote className="ca-quote">“{f.evidence_quote}”</blockquote>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

// Always shown, prominently: what was asked for that the Marketing Agent cannot do yet.
function NotApplied({ items }) {
  return (
    <Box title={items?.length ? 'Could not be applied' : 'Everything asked for can be applied'} icon={items?.length ? 'alert' : 'check'} tone={items?.length ? 'warn' : undefined}>
      {items?.length ? (
        <ul className="ca-list">
          {items.map((n, i) => (
            <li key={i}>
              <strong>{n.request}</strong>: {n.reason}
              {n.proposal && <div className="muted small">Instead: {n.proposal}</div>}
            </li>
          ))}
        </ul>
      ) : <p className="muted small ca-empty">The Marketing Agent can do everything asked for.</p>}
    </Box>
  );
}

function Notices({ view }) {
  const notices = view.notices || [];
  const warnings = view.warnings || [];
  if (!notices.length && !warnings.length) return null;
  return (
    <Box title="Notices and warnings" icon="alert">
      <ul className="ca-list">
        {warnings.map((w, i) => <li key={`w${i}`} className="ca-warning">{w}</li>)}
        {notices.map((n, i) => <li key={`n${i}`}>{n.message} {n.path && <span className="muted small">({n.path})</span>}</li>)}
      </ul>
    </Box>
  );
}

function Suggestions({ items, can, busy, send }) {
  if (!items?.length) return null;
  return (
    <Box title="Web suggestions" icon="search">
      <ul className="ca-list">
        {items.map((s) => (
          <li key={s.id} className="ca-suggestion">
            <div><strong>{s.path}</strong>: {show(s.value)}</div>
            {s.rationale && <div className="muted small">{s.rationale}</div>}
            {s.sources?.length > 0 && (
              <div className="small">{s.sources.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="ca-source">{u}</a>)}</div>
            )}
            {can && (
              <div className="ca-actions">
                {['accept', 'reject'].map((d) => (
                  <button key={d} type="button" className={`btn small-btn${d === 'accept' ? ' soft' : ''}`} disabled={busy}
                    onClick={() => send({ request_type: 'suggestion', payload: { suggestion_id: s.id, decision: d }, idempotency_key: `suggestion-${s.id}-${d}` })}>
                    {d === 'accept' ? 'Accept' : 'Reject'}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Box>
  );
}

// The leadgen file (read only) and its checks L3 to L6. A fix the agent suggests can be applied as a direct change.
function LeadgenFile({ candidate, can, busy, onFix }) {
  if (!candidate) return null;
  return (
    <Box title={`Leadgen file${candidate.version != null ? ` · version ${candidate.version}` : ''}`} icon="doc">
      <div className="ca-levels">
        {candidate.levels.map((l) => (
          <div key={l.level} className={`ca-level ${l.status}`}>
            <div className="ca-level-head">
              <strong>L{l.level} {l.name}</strong>
              <Badge text={l.status} tone={LEVEL_TONE[l.status] || 'gray'} />
            </div>
            {l.status === 'skipped' && (
              <div className="small ca-skipped">{l.note || 'Not checked.'}{l.level === 6 && ' The Marketing Agent’s own loader did not check this file.'}</div>
            )}
            {l.issues?.length > 0 && (
              <ul className="ca-issues">
                {l.issues.map((i, n) => (
                  <li key={n}>
                    <Badge text={i.severity} tone={i.severity === 'error' ? 'red' : 'amber'} /> {i.message}
                    {i.path && <span className="muted small"> ({i.path})</span>}
                    {i.fix && (
                      <div className="small ca-fix">
                        Suggested fix: set <code>{i.fix.path}</code> to <code>{show(i.fix.value)}</code>{i.fix.note && ` (${i.fix.note})`}
                        {can && <button type="button" className="btn small-btn soft" disabled={busy} onClick={() => onFix(i.fix)}>Apply fix</button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <details className="ca-yaml-box">
        <summary>Show the file</summary>
        <pre className="ca-yaml">{candidate.yaml}</pre>
      </details>
    </Box>
  );
}

// ---------- Questions ----------

function Questions({ questions, revision, can, busy, send }) {
  const [answers, setAnswers] = useState({}); // question id -> { choice: id | [ids], text, skip }
  const set = (id, change) => setAnswers((a) => ({ ...a, [id]: { ...a[id], ...change } }));
  const list = questions.map((q) => {
    const a = answers[q.id] || {};
    if (a.skip) return { question_id: q.id, skip: true };
    const choice = q.multi ? (a.choice?.length ? a.choice : null) : a.choice;
    const text = (a.text || '').trim();
    if (choice) return { question_id: q.id, value: choice };
    if (text) return { question_id: q.id, value: text };
    return null;
  }).filter(Boolean);
  function submit(e) {
    e.preventDefault();
    send({ request_type: 'answer', payload: { answers: list }, idempotency_key: `answer-${revision}-${shortHash(JSON.stringify(list))}` });
  }
  return (
    <Box title="The assistant has questions" icon="chat">
      <form className="ca-questions" onSubmit={submit}>
        {questions.map((q) => {
          const a = answers[q.id] || {};
          return (
            <fieldset key={q.id} className="ca-question" disabled={!can || busy || a.skip}>
              <legend>{q.text}</legend>
              {q.choices?.map((c) => (
                <label key={c.id} className="ca-choice">
                  <input
                    type={q.multi ? 'checkbox' : 'radio'} name={q.id} value={c.id}
                    checked={q.multi ? (a.choice || []).includes(c.id) : a.choice === c.id}
                    onChange={(e) => set(q.id, {
                      choice: q.multi
                        ? (e.target.checked ? [...(a.choice || []), c.id] : (a.choice || []).filter((x) => x !== c.id))
                        : c.id,
                    })}
                  />
                  {c.label}
                </label>
              ))}
              {q.text_effect != null && (
                <input className="ca-text" placeholder={q.choices?.length ? 'Or type your own answer' : 'Your answer'} value={a.text || ''} onChange={(e) => set(q.id, { text: e.target.value })} maxLength={2000} />
              )}
              {q.skippable && can && (
                <label className="ca-choice ca-skip">
                  <input type="checkbox" checked={!!a.skip} disabled={busy} onChange={(e) => set(q.id, { skip: e.target.checked })} /> Skip this question
                </label>
              )}
            </fieldset>
          );
        })}
        {can && <button type="submit" className="btn primary" disabled={busy || !list.length}><Icon name="send" /> Send answers</button>}
      </form>
    </Box>
  );
}

// ---------- Changes ----------

function ChangeBox({ revision, busy, send, title = 'Request a change', hint }) {
  const [text, setText] = useState('');
  function submit(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    send({ request_type: 'edit', payload: { text: t }, base_revision: revision, idempotency_key: `edit-${revision}-${shortHash(t)}` })
      .then((ok) => ok && setText(''));
  }
  return (
    <form className="ca-change" onSubmit={submit}>
      <label className="field">
        <span>{title}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={5000} placeholder='For example: "also include Austria"' />
      </label>
      {hint && <p className="muted small">{hint}</p>}
      <button type="submit" className="btn" disabled={busy || !text.trim()}><Icon name="edit" /> Send change</button>
    </form>
  );
}

// ---------- After publishing: what is live and what the Marketing Agent does with it ----------

function Published({ view, can, busy, send, confirm }) {
  const blockers = (view.ma_events || []).filter((e) => e.kind === 'blocker');
  const others = (view.ma_events || []).filter((e) => e.kind !== 'blocker');
  const applied = view.applied === true ? ['Running it', 'green'] : view.applied === false ? ['Not yet', 'amber'] : ['Not known (offline)', 'gray'];
  async function rollback(v) {
    if (!(await confirm({ title: `Make version ${v} live again?`, message: 'It replaces the live version. The Marketing Agent takes it at its next pass.', confirmLabel: 'Make live' }))) return;
    send({ request_type: 'rollback', payload: { version: v }, idempotency_key: `rollback-${v}-${Date.now()}` });
  }
  async function deactivate() {
    if (!(await confirm({ title: 'Switch this campaign off?', message: 'Nothing of it stays live. Its versions are kept and can be made live again.', confirmLabel: 'Switch off', danger: true }))) return;
    send({ request_type: 'deactivate', payload: {}, idempotency_key: `deactivate-${Date.now()}` });
  }
  return (
    <>
      {blockers.map((b, i) => (
        <div key={i} className="notice ca-blocker" role="alert">
          <strong><Icon name="alert" /> The Marketing Agent needs a person</strong> <Badge text={b.severity} tone="red" />
          <div>{b.message}</div>
          <div className="small">Since {fmtDate(b.occurred_at)}{b.repeat_count > 1 && ` · reported ${b.repeat_count} times`}</div>
        </div>
      ))}
      <Box title="Live campaign" icon="bolt" aside={can && view.live && <button type="button" className="btn danger small-btn" disabled={busy} onClick={deactivate}>Switch off</button>}>
        <dl className="kv ca-kv">
          <div className="kv-row"><dt>Live</dt><dd>{view.live ? `Yes, version ${view.live_version}` : 'No (another campaign or none is live)'}</dd></div>
          <div className="kv-row"><dt>Marketing Agent</dt><dd><Badge text={applied[0]} tone={applied[1]} /></dd></div>
          {view.ma_error && <div className="kv-row"><dt>Refused because</dt><dd className="ca-ma-error">{view.ma_error}</dd></div>}
        </dl>
        {others.length > 0 && (
          <ul className="ca-list small">
            {others.map((e, i) => <li key={i}>{fmtDate(e.occurred_at)}: {e.message}</li>)}
          </ul>
        )}
        {view.versions?.length > 0 && (
          <table className="ca-versions">
            <thead><tr><th>Version</th><th>Approved by</th><th>When</th><th /></tr></thead>
            <tbody>
              {view.versions.map((v) => (
                <tr key={v.version}>
                  <td>{v.version} {v.live && <Badge text="live" tone="green" />}</td>
                  <td>{v.approved_by || '—'}</td>
                  <td>{v.approved_at ? fmtDate(v.approved_at) : 'Not approved'}</td>
                  <td>{can && v.approved_at && !v.live && <button type="button" className="btn small-btn" disabled={busy} onClick={() => rollback(v.version)}>Make live</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Box>
    </>
  );
}

// ---------- The review (AWAITING_REVIEW) ----------

function ReviewActions({ view, can, busy, send, confirm }) {
  const c = view.candidate;
  const failed = failedLevels(c);
  const canApprove = !!c && c.version != null && c.can_freeze && !failed.length;
  async function approve() {
    const ok = await confirm({
      title: `Approve version ${c.version}?`,
      message: 'It becomes the live campaign and the Marketing Agent starts on it. Every email is still approved by a person in Slack.',
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    send({
      request_type: 'approve',
      payload: { version: c.version, sha256: c.sha256, start_pipeline: true },
      idempotency_key: `approve-${c.version}-${c.sha256.slice(0, 12)}${view.state === 'PUBLISH_FAILED' ? `-retry-${Date.now()}` : ''}`,
    });
  }
  async function reject() {
    const ok = await confirm({ title: 'Reject this campaign?', message: 'The assistant closes it. This cannot be undone; make a new campaign to start again.', confirmLabel: 'Reject', danger: true });
    if (!ok) return;
    send({ request_type: 'discard', payload: {}, idempotency_key: `discard-${view.revision}` });
  }
  if (!can) return null;
  return (
    <Box title="Your decision" icon="check">
      <div className="ca-decide">
        <button type="button" className="btn primary" disabled={busy || !canApprove} onClick={approve}><Icon name="check" /> Approve</button>
        <button type="button" className="btn danger" disabled={busy} onClick={reject}>Reject</button>
      </div>
      {!canApprove && (
        <p className="muted small">
          {failed.length ? 'Approve is off: a check failed. Request a change to fix it.' : 'Approve is off: this file cannot be frozen yet.'}
        </p>
      )}
      <ChangeBox revision={view.revision} busy={busy} send={send} />
    </Box>
  );
}

// ---------- Page ----------

export default function CampaignReviewView({ id }) {
  const [data, setData] = useState(null); // { campaign, assistant, assistantError }
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [admin, setAdmin] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [confirmDialog, confirm] = useConfirm();
  const agent = useSection('agent');
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await getCampaignView(id));
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message);
      setStatus((s) => (s === 'ready' ? s : 'error')); // keep the last good data on screen while polling
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);

  const ca = data?.assistant;
  const view = ca?.review_view;
  const state = ca?.state || view?.state;
  const req = ca?.last_request;
  const working = !!WORKING[state] || STARTING.includes(state) || OPEN.includes(req?.status);

  // Poll while the agent works or a request is open; when the gateway could not be read, retry now and then.
  useEffect(() => {
    clearTimeout(timer.current);
    if (status !== 'ready') return undefined;
    const wait = working ? POLL_MS : !ca ? RETRY_MS : null;
    if (wait) timer.current = setTimeout(load, wait);
    return () => clearTimeout(timer.current);
  }, [data, status, working, ca, load]);

  // -> true when the request was recorded. The page then shows it as open and polls until it is done or failed.
  const send = useCallback(async (r) => {
    setSending(true);
    setSendError('');
    try {
      await sendRequest(id, r);
      await load();
      return true;
    } catch (err) {
      setSendError(err.message);
      return false;
    } finally {
      setSending(false);
    }
  }, [id, load]);

  if (status === 'loading') return <main className="page"><div className="card"><Skeleton rows={6} /></div></main>;
  if (status === 'error') {
    return (
      <main className="page">
        <BackLink />
        {loadError && <div className="notice">{loadError}</div>}
        <ErrorBox what="the campaign" onRetry={load} />
      </main>
    );
  }

  const c = data.campaign;
  const can = admin;
  const busy = sending || OPEN.includes(req?.status);
  const paused = agent.data?.actualState === 'paused';
  const failed = failedLevels(view?.candidate);
  const onFix = (fix) => send({
    request_type: 'edit', payload: { ops: [{ path: fix.path, value: fix.value }] }, base_revision: ca.revision ?? view?.revision,
    idempotency_key: `edit-${ca.revision ?? view?.revision}-${shortHash(JSON.stringify(fix))}`,
  });
  const revision = ca?.revision ?? view?.revision;

  let body;
  if (!ca) {
    body = <div className="info-note warn" role="status">{data.assistantError || 'The assistant has not answered yet.'}</div>;
  } else if (STARTING.includes(state) || WORKING[state]) {
    body = (
      <section className="card ca-working-card">
        <span className="ca-spinner big" aria-hidden="true" />
        <div>
          <strong>{WORKING[state] ? `${WORKING[state]}…` : 'Starting…'}</strong>
          <p className="muted small">
            {WORKING[state] ? 'This can take a few minutes on the office machine.' : 'The assistant has not read this campaign yet. It starts within about 30 seconds.'}
          </p>
          {STARTING.includes(state) && can && (
            <button type="button" className="btn small-btn" disabled={busy}
              onClick={() => send({ request_type: 'interpret', payload: {}, idempotency_key: `interpret-${id}` })}>Start now</button>
          )}
        </div>
      </section>
    );
  } else if (state === 'CLARIFICATION_REQUIRED') {
    body = (
      <>
        <Questions key={revision} questions={view?.questions || []} revision={revision} can={can} busy={busy} send={send} />
        {view && <Box title="What the assistant understood so far" icon="eye"><Fields sections={view.sections} /></Box>}
      </>
    );
  } else if (state === 'MODEL_UNAVAILABLE') {
    body = (
      <section className="card">
        <p><strong>The language model did not answer.</strong> The campaign is kept; nothing was lost.</p>
        {can && <button type="button" className="btn primary" disabled={busy} onClick={() => send({ request_type: 'interpret', payload: {}, idempotency_key: `interpret-retry-${Date.now()}` })}>Try again</button>}
      </section>
    );
  } else if (state === 'DISCARDED') {
    body = <section className="card"><p className="muted">This campaign was rejected and closed. Make a new campaign to start again.</p></section>;
  } else if (view) {
    const reviewing = state === 'AWAITING_REVIEW';
    body = (
      <>
        {state === 'PUBLISHED' && <Published view={view} can={can} busy={busy} send={send} confirm={confirm} />}
        {state === 'PUBLISH_FAILED' && (
          <div className="notice" role="alert"><strong>Could not publish.</strong> Nothing was applied. Approve again to retry.</div>
        )}
        {state === 'VALIDATION_FAILED' && (
          <div className="notice" role="alert">
            {failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed. Apply a suggested fix or request a change.` : 'The checks failed. Request a change.'}
          </div>
        )}
        <NotApplied items={view.not_applied} />
        <Box title="What the assistant understood" icon="eye"><Fields sections={view.sections} /></Box>
        <Notices view={view} />
        <Suggestions items={view.suggestions} can={can} busy={busy} send={send} />
        <LeadgenFile candidate={view.candidate} can={can && state === 'VALIDATION_FAILED'} busy={busy} onFix={onFix} />
        <div className="info-note ca-email" role="note"><Icon name="mail" /> {view.email_approval}</div>
        {(reviewing || state === 'PUBLISH_FAILED') && <ReviewActions view={{ ...view, state }} can={can} busy={busy} send={send} confirm={confirm} />}
        {(state === 'VALIDATION_FAILED' || state === 'PUBLISHED') && can && (
          <section className="card">
            <ChangeBox
              revision={revision} busy={busy} send={send}
              title={state === 'PUBLISHED' ? 'Change the live campaign' : 'Request a change'}
              hint={state === 'PUBLISHED' ? 'This makes a new version to review. The live version keeps running until you approve the new one.' : null}
            />
          </section>
        )}
      </>
    );
  } else {
    body = <div className="info-note warn">The assistant reports the state {state}, which this page does not know yet.</div>;
  }

  return (
    <main className="page ca-page">
      <div className="page-head">
        <BackLink />
        <div className="ca-title">
          <h1 className="page-title">{c.campaignName}</h1>
          {state && <Badge text={STATE_LABEL[state] || state} tone={STATE_TONE[state] || 'gray'} />}
        </div>
        <p className="muted">{fmtDay(c.startDate, 'long')} – {fmtDay(c.endDate, 'long')}{revision != null && ` · revision ${revision}`}</p>
      </div>
      <div className="ca-stack">
        <AssistantStatus />
        {!can && <p className="muted small">Only admins can answer, change or approve. You can follow along here.</p>}
        {sendError && <div className="notice" role="alert">{sendError}</div>}
        <LastRequest req={req} paused={paused} />
        {body}
      </div>
      {confirmDialog}
    </main>
  );
}

function BackLink() {
  return <Link href="/campaign" className="ca-back"><Icon name="left" /> All campaigns</Link>;
}
