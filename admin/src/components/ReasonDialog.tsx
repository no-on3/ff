import React, { useEffect, useRef, useState } from 'react';
import { REASON_LENGTH, reasonProblem } from '../lib/reason';
import { ErrorState } from './States';

/**
 * Every change an operator makes is confirmed here, with a reason that the
 * audit log keeps (D12). `onConfirm` sends the change; a failure is shown in
 * the dialog, which stays open to try again.
 */
const ReasonDialog: React.FC<{
  title: string;
  /** What will change. */
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
  /** The button's words while it works: a change saves, a look opens. */
  busyLabel?: string;
}> = ({ title, children, confirmLabel, onConfirm, onCancel, busyLabel = 'Saving…' }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const problem = reasonProblem(reason);

  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !sending && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, sending]);

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    setSending(true);
    setFailure(null);
    try {
      await onConfirm(reason.trim());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form role="dialog" aria-modal="true" aria-label={title} onSubmit={confirm} className="card w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="text-sm">{children}</div>
        <label className="block text-sm font-medium">
          Reason
          <textarea
            ref={field}
            name="reason"
            value={reason}
            maxLength={REASON_LENGTH.max}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            className="input mt-1"
            placeholder="Why: the audit log keeps it with the change"
          />
        </label>
        {touched && problem && <p className="text-sm text-red-700">{problem}</p>}
        {failure && <ErrorState message={failure} />}
        <div className="flex justify-end gap-3">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? busyLabel : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ReasonDialog;
