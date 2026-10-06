'use client';
// In-app replacement for window.confirm() / window.prompt(), styled like the rest of the dashboard.
//   const [confirmDialog, confirm] = useConfirm();
//   if (!(await confirm({ title, message, confirmLabel, danger }))) return;          // -> true | false
//   const pw = await confirm({ title, confirmLabel, field: { label: 'New password' } }); // -> string | false
//   ...render {confirmDialog} once in the page.
// Built on <dialog>.showModal(), so the browser handles the backdrop, focus trapping and Esc.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const MIN_PASSWORD = 8;

export function useConfirm() {
  const [req, setReq] = useState(null); // { title, message, confirmLabel, danger, field, resolve }
  const [value, setValue] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    setValue('');
    setShowPw(false);
    setError('');
    setReq({ ...opts, resolve });
  }), []);

  useEffect(() => {
    const d = ref.current;
    if (req && d && !d.open) d.showModal();
  }, [req]);

  const finish = (result) => {
    ref.current?.close();
    req?.resolve(result);
    setReq(null);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!req.field) return finish(true);
    if (value.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    return finish(value);
  };

  const dialog = req && (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      onCancel={(e) => { e.preventDefault(); finish(false); }}
      onClick={(e) => { if (e.target === e.currentTarget) finish(false); }} // click outside the card = backdrop
    >
      <form className="confirm-card" noValidate onSubmit={onSubmit}>
        <div className="confirm-body">
          <div className={`tile round${req.danger ? ' red' : ''}`}><Icon name="alert" /></div>
          <h2 id="confirm-title" className="confirm-title">{req.title}</h2>
          {req.message && <p className="muted">{req.message}</p>}
        </div>
        {req.field && (
          <label className="field confirm-field">
            <span>{req.field.label}</span>
            <span className="pw-wrap">
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD} characters`}
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(''); }}
                aria-invalid={!!error}
                autoFocus
              />
              <button
                className="pw-toggle"
                type="button"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                aria-pressed={showPw}
                onClick={() => setShowPw(!showPw)}
              >
                <Icon name="eye" />
              </button>
            </span>
            {error && <span className="confirm-error" role="alert">{error}</span>}
          </label>
        )}
        <div className="confirm-actions">
          <button className="btn" type="button" onClick={() => finish(false)} autoFocus={!req.field}>Cancel</button>
          <button className={`btn ${req.danger ? 'danger-fill' : 'primary'}`} type="submit">
            {req.confirmLabel || 'Confirm'}
          </button>
        </div>
      </form>
    </dialog>
  );

  return [dialog, confirm];
}
