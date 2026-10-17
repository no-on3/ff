import React, { useEffect, useRef, useState } from 'react';
import { GRANT_KINDS, GrantKind, GrantRequest, amountProblem, confirms, decimalsOf, needsConfirmation, signedAmount, withDecimals } from '../lib/credits';
import { formatMoney } from '../lib/money';
import { REASON_LENGTH, reasonProblem } from '../lib/reason';
import { ErrorState } from './States';

/**
 * A grant of credit (P-74): promotional credit, or a correction either way,
 * with a reason for the audit log. Above the large-credit threshold, a second
 * step asks for the amount typed again (D12). The key is made once, when the
 * dialog opens: sending again after a failure grants once.
 */
const GrantDialog: React.FC<{
  accountName: string;
  currency: string;
  balance: string;
  threshold: string;
  onGrant: (request: GrantRequest) => Promise<void>;
  onCancel: () => void;
}> = ({ accountName, currency, balance, threshold, onGrant, onCancel }) => {
  const decimals = decimalsOf(threshold);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<GrantKind>('promo');
  const [takeAway, setTakeAway] = useState(false);
  const [amount, setAmount] = useState('');
  const [allowDebt, setAllowDebt] = useState(false);
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const againField = useRef<HTMLInputElement>(null);

  const away = kind === 'adjustment' && takeAway;
  const signed = signedAmount(amount, away);
  const problem = amountProblem(amount, decimals) ?? reasonProblem(reason);
  const large = !problem && needsConfirmation(signed, threshold);
  const money = (text: string) => formatMoney(text, currency);
  const typed = money(withDecimals(amount, decimals));
  const what = kind === 'promo' ? `${typed} of promotional credit` : `a correction: ${typed} ${away ? 'taken away' : 'added'}`;

  useEffect(() => (step === 'form' ? firstField : againField).current?.focus(), [step]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !sending && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, sending]);

  const send = async () => {
    setSending(true);
    setFailure(null);
    try {
      await onGrant({
        kind,
        amount: signed,
        reason: reason.trim(),
        idempotencyKey,
        ...(large ? { confirmAmount: signedAmount(again, away) } : {}),
        ...(away && allowDebt ? { allowDebt: true } : {}),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSending(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    if (step === 'form' && large) {
      setFailure(null);
      setStep('confirm');
      return;
    }
    if (step === 'confirm' && !confirms(again, amount, decimals)) {
      setFailure(`That isn't the amount: type ${typed} again to confirm.`);
      return;
    }
    void send();
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form role="dialog" aria-modal="true" aria-label={`Grant credit to ${accountName}`} onSubmit={submit} className="card max-h-full w-full max-w-lg space-y-4 overflow-y-auto">
        <h2 className="text-lg font-semibold">Grant credit to {accountName}</h2>
        {step === 'form' ? (
          <>
            <p className="text-sm text-gray-600">
              The balance is {money(balance)}. A grant comes from FF&apos;s promotional credit; the owners get an e-mail with your reason, and see it in their audit log.
            </p>
            <label className="block text-sm font-medium">
              Kind
              <select
                ref={firstField}
                name="kind"
                className="input mt-1"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as GrantKind);
                  setTakeAway(false);
                }}
              >
                {GRANT_KINDS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'adjustment' && (
              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Direction</legend>
                <label className="mr-4 inline-flex items-center gap-2">
                  <input type="radio" name="direction" checked={!takeAway} onChange={() => setTakeAway(false)} /> Add credit
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="radio" name="direction" checked={takeAway} onChange={() => setTakeAway(true)} /> Take credit away
                </label>
              </fieldset>
            )}
            <label className="block text-sm font-medium">
              Amount ({currency})
              <input name="amount" inputMode="decimal" autoComplete="off" className="input mt-1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={`25.${'0'.repeat(decimals)}`} />
            </label>
            {away && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="allowDebt" className="mt-1" checked={allowDebt} onChange={(event) => setAllowDebt(event.target.checked)} />
                <span>It may leave a debt: the balance below 0. Without it, a correction takes the credit left at most.</span>
              </label>
            )}
            <label className="block text-sm font-medium">
              Reason
              <textarea
                name="reason"
                value={reason}
                maxLength={REASON_LENGTH.max}
                rows={3}
                onChange={(event) => setReason(event.target.value)}
                className="input mt-1"
                placeholder="Why: the audit log and the owners' e-mail give it"
              />
            </label>
            {touched && problem && <p className="text-sm text-red-700">{problem}</p>}
          </>
        ) : (
          <>
            <p className="text-sm">
              {accountName} gets {what}. That is above the large-credit threshold, {money(threshold)}: type the amount again to confirm it (D12).
            </p>
            <label className="block text-sm font-medium">
              The amount again ({currency})
              <input ref={againField} name="confirmAmount" inputMode="decimal" autoComplete="off" className="input mt-1" value={again} onChange={(event) => setAgain(event.target.value)} />
            </label>
          </>
        )}
        {failure && <ErrorState message={failure} />}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={sending}
            onClick={() => {
              if (step === 'form') {
                onCancel();
                return;
              }
              setFailure(null);
              setStep('form');
            }}
          >
            {step === 'form' ? 'Cancel' : 'Back'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? 'Granting…' : step === 'confirm' ? 'Confirm the grant' : large ? 'Next' : 'Grant'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default GrantDialog;
