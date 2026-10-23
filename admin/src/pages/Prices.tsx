import React, { useCallback, useEffect, useState } from 'react';
import { pricesApi } from '../api';
import ReasonDialog from '../components/ReasonDialog';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import {
  DraftForm,
  PriceBook,
  PriceBookPreview,
  PriceDocument,
  STATUS_LABELS,
  StorageForm,
  draftDocument,
  earliestStart,
  formFrom,
  pricesStorage,
  sourceLabel,
  storageTierLabel,
  tierLabel,
} from '../lib/prices';
import { whenUtc } from '../lib/time';

const STATUS_COLORS: Record<PriceBook['status'], string> = {
  past: 'bg-gray-200 text-gray-800',
  active: 'bg-green-100 text-green-900',
  scheduled: 'bg-amber-100 text-amber-900',
};

/** A book's prices: each SKU in its currency, and in US$ where they are AWS's. */
const BookPrices: React.FC<{ document: PriceDocument }> = ({ document }) => {
  const { prices, freeTier, source, currency } = document;
  const usd = source.usdPrices;
  const rows: Array<[string, string, string]> = [
    ['Requests, per million', prices.requestsPerMillion, usd?.requestsPerMillion ?? ''],
    ...prices.gbSecond.map((tier, index): [string, string, string] => [`Duration, ${tierLabel(prices.gbSecond, index)}, per GB-s`, tier.price, usd?.gbSecond[index]?.price ?? '']),
    ['Provisioned concurrency (minInstances), per GB-s', prices.provisionedGbSecond, usd?.provisionedGbSecond ?? ''],
    ['Duration on provisioned concurrency, per GB-s', prices.provisionedDurationGbSecond, usd?.provisionedDurationGbSecond ?? ''],
    ['Free tier, a month', `${freeTier.requests.toLocaleString('en-US')} requests, ${freeTier.gbSeconds.toLocaleString('en-US')} GB-s`, ''],
    ['Minimum billed duration', `${prices.minimumBilledMs} ms`, ''],
    ['Idle instance time, per GB-s', prices.idleInstanceGbSecond, ''],
    ['Monthly fee', prices.monthlyPlanFee, ''],
  ];
  // Customers' databases and buckets, as AWS RDS and S3 price them, in a book that has them.
  if (prices.databaseStorageGbMonth !== undefined) rows.push(['Database storage, per GB-month', prices.databaseStorageGbMonth, usd?.databaseStorageGbMonth ?? '']);
  if (prices.databaseMonthlyFee !== undefined) rows.push(['Monthly fee per database', prices.databaseMonthlyFee, '']);
  for (const [index, tier] of (prices.bucketStorageGbMonth ?? []).entries()) {
    rows.push([`Bucket storage, ${storageTierLabel(prices.bucketStorageGbMonth ?? [], index)}, per GB-month`, tier.price, usd?.bucketStorageGbMonth?.[index]?.price ?? '']);
  }
  if (prices.requestsTier1PerThousand !== undefined) rows.push(['PUT, COPY, POST and LIST requests, per 1,000', prices.requestsTier1PerThousand, usd?.requestsTier1PerThousand ?? '']);
  if (prices.requestsTier2PerThousand !== undefined) rows.push(['GET and other requests, per 1,000', prices.requestsTier2PerThousand, usd?.requestsTier2PerThousand ?? '']);
  if (freeTier.databaseStorageGbMonths !== undefined) {
    rows.push([
      'Free tier of databases and buckets, a month',
      `${freeTier.databaseStorageGbMonths} GB-month of databases, ${freeTier.bucketStorageGbMonths ?? 0} of buckets, ${(freeTier.requestsTier1 ?? 0).toLocaleString('en-US')} PUT and ${(freeTier.requestsTier2 ?? 0).toLocaleString('en-US')} GET requests`,
      '',
    ]);
  }
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-4 py-2 font-medium">SKU</th>
            <th className="px-4 py-2 font-medium">{currency}</th>
            <th className="px-4 py-2 font-medium">{usd ? 'US$' : ''}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value, usdValue]) => (
            <tr key={label} className="border-t border-gray-200">
              <td className="px-4 py-2">{label}</td>
              <td className="px-4 py-2 font-mono">{value}</td>
              <td className="px-4 py-2 font-mono text-gray-600">{usdValue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Field: React.FC<{ id: string; label: string; value: string; onChange: (value: string) => void; unit?: string; type?: string }> = ({ id, label, value, onChange, unit, type }) => (
  <label htmlFor={id} className="block text-sm">
    <span className="block text-gray-600">{label}</span>
    <span className="flex items-center gap-2">
      <input id={id} type={type ?? 'text'} className="input max-w-xs font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
      {unit && <span className="text-gray-500">{unit}</span>}
    </span>
  </label>
);

/**
 * FF's price books (P-73, D8): AWS Lambda's prices in TND, and from the book
 * that brought them, customers' databases' and buckets' as AWS RDS and S3
 * price them; each from a whole hour until the next book's. A new one starts
 * from the latest one, scheduled or active, at AWS's US$ prices times a rate
 * or at TND prices as given, and can be tried on last month first.
 */
const Prices: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [books, setBooks] = useState<PriceBook[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [form, setForm] = useState<DraftForm | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<PriceBookPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState<{ kind: 'create'; validFrom: string; document: PriceDocument } | { kind: 'remove'; book: PriceBook } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    pricesApi.list().then(
      ({ data }) => {
        setBooks(data);
        setShown((current) => current ?? data.find((book) => book.status === 'active')?.id ?? null);
      },
      (error) => (notAnOperator(error) ? setRefused(true) : setFailure(apiErrorMessage(error))),
    );
  }, []);
  useEffect(load, [load]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  if (failure) return <ErrorState message={failure} />;
  if (!books) return <Loading />;

  // A new book starts from the latest: after it, a book without its SKUs would price what they price at nothing.
  const latest: PriceBook | undefined = books[books.length - 1];
  const book = books.find((candidate) => candidate.id === shown);
  const draft = form && latest ? draftDocument(form, latest.document, new Date()) : null;
  const setStorage = (change: Partial<StorageForm>) => setForm((current) => (current ? { ...current, storage: { ...current.storage, ...change } } : current));
  const set = (change: Partial<DraftForm>) => {
    setForm((current) => (current ? { ...current, ...change } : current));
    setPreview(null);
  };
  const tryOn = async () => {
    if (!draft || 'problems' in draft) return setProblems(draft && 'problems' in draft ? draft.problems : []);
    setProblems([]);
    setPreviewing(true);
    try {
      setPreview((await pricesApi.preview(draft.document)).data);
    } catch (error) {
      setProblems([apiErrorMessage(error)]);
    } finally {
      setPreviewing(false);
    }
  };
  const save = () => {
    if (!draft || 'problems' in draft) return setProblems(draft && 'problems' in draft ? draft.problems : []);
    setProblems([]);
    setNotice(null);
    setPending({ kind: 'create', validFrom: draft.validFrom, document: draft.document });
  };
  const confirm = async (reason: string) => {
    if (!pending) return;
    try {
      if (pending.kind === 'create') {
        const { data } = await pricesApi.create(pending.validFrom, pending.document, reason);
        setNotice(`Saved: the new book prices usage from ${whenUtc(data.validFrom)}.`);
        setForm(null);
        setPreview(null);
        setShown(data.id);
      } else {
        await pricesApi.remove(pending.book.id, reason);
        setNotice(`Removed the book that would have started ${whenUtc(pending.book.validFrom)}.`);
        setShown(null);
      }
      setPending(null);
      load();
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Prices</h1>
          <p className="text-gray-600">
            FF's price books: AWS Lambda's prices in TND, with its free tier (D8), and in the books that have them, customers' databases' and
            buckets' as AWS RDS and S3 price them. Each starts at a whole hour, UTC, and prices what happens until the next one starts. One that
            has started never changes: usage keeps the prices it had.
          </p>
        </div>
        {latest && !form && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setNotice(null);
              setForm(formFrom(latest.document, new Date()));
            }}
          >
            New price book
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-green-900">
          {notice}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">The books</h2>
        {books.length === 0 ? (
          <EmptyState>No price book.</EmptyState>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  {['Status', 'From', 'Prices', 'Made by', ''].map((label) => (
                    <th key={label} className="px-4 py-2 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {books.map((candidate) => (
                  <tr key={candidate.id} className={`border-t border-gray-200 align-top ${candidate.id === shown ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[candidate.status]}`}>{STATUS_LABELS[candidate.status]}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">{whenUtc(candidate.validFrom)}</td>
                    <td className="px-4 py-2">{sourceLabel(candidate.document)}</td>
                    <td className="px-4 py-2">{candidate.createdBy}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <button type="button" className="text-blue-700 hover:underline" onClick={() => setShown(candidate.id)}>
                        View
                      </button>
                      {candidate.status === 'scheduled' && (
                        <button type="button" className="ml-4 text-red-700 hover:underline" onClick={() => setPending({ kind: 'remove', book: candidate })}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {book && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            The book from {whenUtc(book.validFrom)} ({STATUS_LABELS[book.status].toLowerCase()})
          </h2>
          <BookPrices document={book.document} />
        </section>
      )}

      {form && latest && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">A new price book, from the latest one ({STATUS_LABELS[latest.status].toLowerCase()}, from {whenUtc(latest.validFrom)})</h2>
          <div className="card space-y-5">
            <div className="flex flex-wrap items-end gap-4">
              <Field id="startDay" label="Starts on (UTC)" type="date" value={form.day} onChange={(day) => set({ day })} />
              <label htmlFor="startHour" className="block text-sm">
                <span className="block text-gray-600">at</span>
                <select id="startHour" className="input" value={form.hour} onChange={(e) => set({ hour: e.target.value })}>
                  {Array.from({ length: 24 }, (_unused, hour) => (
                    <option key={hour} value={String(hour)}>
                      {String(hour).padStart(2, '0')}:00 UTC
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm text-gray-500">From {whenUtc(earliestStart(new Date()).toISOString())} on.</p>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm text-gray-600">Prices</legend>
              <label className="mr-6 text-sm">
                <input type="radio" name="mode" checked={form.mode === 'aws'} onChange={() => set({ mode: 'aws' })} /> AWS's US$ prices × a rate
              </label>
              <label className="text-sm">
                <input type="radio" name="mode" checked={form.mode === 'manual'} onChange={() => set({ mode: 'manual' })} /> TND prices as I set them
              </label>
            </fieldset>
            {form.mode === 'aws' && (
              <div className="flex flex-wrap gap-4">
                <Field id="rate" label="Rate" unit="TND per US$" value={form.rate} onChange={(rate) => set({ rate })} />
                <Field id="rateDate" label="Rate of" type="date" value={form.rateDate} onChange={(rateDate) => set({ rateDate })} />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['requestsPerMillion', 'Requests, per million'],
                  ['tiers', ''],
                  ['provisionedGbSecond', 'Provisioned concurrency, per GB-s'],
                  ['provisionedDurationGbSecond', 'Duration on provisioned concurrency, per GB-s'],
                ] as const
              ).map(([key, label]) => {
                const currency = form.mode === 'aws' ? 'US$' : 'TND';
                if (key === 'tiers') {
                  // The duration tiers, in the table's order: after the requests.
                  const tiers = form.mode === 'aws' ? form.usd.tiers : form.tnd.tiers;
                  return latest.document.prices.gbSecond.map((_tier, index) => {
                    const update = (value: string) => {
                      const next = tiers.map((price, at) => (at === index ? value : price));
                      if (form.mode === 'aws') set({ usd: { ...form.usd, tiers: next } });
                      else set({ tnd: { ...form.tnd, tiers: next } });
                    };
                    return (
                      <Field
                        key={`tier-${index}`}
                        id={`tier-${index}`}
                        label={`Duration, ${tierLabel(latest.document.prices.gbSecond, index)}, per GB-s, ${currency}`}
                        value={tiers[index] ?? ''}
                        onChange={update}
                      />
                    );
                  });
                }
                return form.mode === 'aws' ? (
                  <Field key={key} id={`usd-${key}`} label={`${label}, ${currency}`} value={form.usd[key]} onChange={(value) => set({ usd: { ...form.usd, [key]: value } })} />
                ) : (
                  <Field key={key} id={`tnd-${key}`} label={`${label}, ${currency}`} value={form.tnd[key]} onChange={(value) => set({ tnd: { ...form.tnd, [key]: value } })} />
                );
              })}
              <Field id="freeRequests" label="Free requests, a month" value={form.freeRequests} onChange={(freeRequests) => set({ freeRequests })} />
              <Field id="freeGbSeconds" label="Free GB-s, a month" value={form.freeGbSeconds} onChange={(freeGbSeconds) => set({ freeGbSeconds })} />
              <Field id="minimumBilledMs" label="Minimum billed duration" unit="ms" value={form.minimumBilledMs} onChange={(minimumBilledMs) => set({ minimumBilledMs })} />
              <Field id="idleInstanceGbSecond" label="Idle instance time, per GB-s, TND" value={form.idleInstanceGbSecond} onChange={(idleInstanceGbSecond) => set({ idleInstanceGbSecond })} />
              <Field id="monthlyPlanFee" label="Monthly fee, TND" value={form.monthlyPlanFee} onChange={(monthlyPlanFee) => set({ monthlyPlanFee })} />
            </div>
            {pricesStorage(latest.document) && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-gray-700">Customers' databases and buckets, as AWS RDS and S3 price them</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(() => {
                    const currency = form.mode === 'aws' ? 'US$' : 'TND';
                    const given = form.mode === 'aws' ? form.storage.usd : form.storage.tnd;
                    const change = (next: Partial<StorageForm['usd']>) => setStorage(form.mode === 'aws' ? { usd: { ...given, ...next } } : { tnd: { ...given, ...next } });
                    const tiers = latest.document.prices.bucketStorageGbMonth ?? [];
                    return (
                      <>
                        <Field id="databaseStorageGbMonth" label={`Database storage, per GB-month, ${currency}`} value={given.databaseStorageGbMonth} onChange={(databaseStorageGbMonth) => change({ databaseStorageGbMonth })} />
                        {tiers.map((_tier, index) => (
                          <Field
                            key={`bucket-tier-${index}`}
                            id={`bucket-tier-${index}`}
                            label={`Bucket storage, ${storageTierLabel(tiers, index)}, per GB-month, ${currency}`}
                            value={given.bucketTiers[index] ?? ''}
                            onChange={(value) => change({ bucketTiers: given.bucketTiers.map((price, at) => (at === index ? value : price)) })}
                          />
                        ))}
                        <Field id="requestsTier1" label={`PUT, COPY, POST and LIST requests, per 1,000, ${currency}`} value={given.requestsTier1PerThousand} onChange={(requestsTier1PerThousand) => change({ requestsTier1PerThousand })} />
                        <Field id="requestsTier2" label={`GET and other requests, per 1,000, ${currency}`} value={given.requestsTier2PerThousand} onChange={(requestsTier2PerThousand) => change({ requestsTier2PerThousand })} />
                      </>
                    );
                  })()}
                  <Field id="databaseMonthlyFee" label="Monthly fee per database, TND" value={form.storage.databaseMonthlyFee} onChange={(databaseMonthlyFee) => setStorage({ databaseMonthlyFee })} />
                  <Field id="freeDatabaseGbMonths" label="Free database GB-months, a month" value={form.storage.freeDatabaseGbMonths} onChange={(freeDatabaseGbMonths) => setStorage({ freeDatabaseGbMonths })} />
                  <Field id="freeBucketGbMonths" label="Free bucket GB-months, a month" value={form.storage.freeBucketGbMonths} onChange={(freeBucketGbMonths) => setStorage({ freeBucketGbMonths })} />
                  <Field id="freeRequestsTier1" label="Free PUT, COPY, POST and LIST requests, a month" value={form.storage.freeRequestsTier1} onChange={(freeRequestsTier1) => setStorage({ freeRequestsTier1 })} />
                  <Field id="freeRequestsTier2" label="Free GET and other requests, a month" value={form.storage.freeRequestsTier2} onChange={(freeRequestsTier2) => setStorage({ freeRequestsTier2 })} />
                </div>
              </fieldset>
            )}
            {draft && 'document' in draft && form.mode === 'aws' && (
              <div className="space-y-2">
                <p className="text-sm text-gray-600">In TND, each US$ price times {form.rate}, exactly:</p>
                <BookPrices document={draft.document} />
              </div>
            )}
            {problems.length > 0 && (
              <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-red-700">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-secondary" onClick={tryOn} disabled={previewing}>
                {previewing ? 'Pricing…' : 'Try it on last month'}
              </button>
              <button type="button" className="btn btn-primary" onClick={save}>
                Save…
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setForm(null);
                  setPreview(null);
                  setProblems([]);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
          {preview && (
            <div className="space-y-2" aria-label="Preview">
              <h3 className="font-semibold">
                {preview.month} (UTC) at this book, next to the books valid then and what was charged.
              </h3>
              <p className="text-sm text-gray-600">Charged: the hourly charges of the month, debited, or in shadow mode only rated; – before the month was rated.</p>
              {preview.accounts.length === 0 ? (
                <EmptyState>No account used anything in {preview.month}.</EmptyState>
              ) : (
                <div className="card overflow-x-auto p-0">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-4 py-2 font-medium">Account</th>
                        <th className="px-4 py-2 text-right font-medium">At the books then</th>
                        <th className="px-4 py-2 text-right font-medium">Charged</th>
                        <th className="px-4 py-2 text-right font-medium">At this book</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.accounts.map((account) => (
                        <tr key={account.accountId} className="border-t border-gray-200">
                          <td className="px-4 py-2">
                            {account.name} <span className="font-mono text-xs text-gray-500">{account.accountId}</span>
                          </td>
                          <td className="px-4 py-2 text-right font-mono">{account.current ?? '–'}</td>
                          <td className="px-4 py-2 text-right font-mono">{account.charged ?? '–'}</td>
                          <td className="px-4 py-2 text-right font-mono">{account.draft}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-gray-200 font-semibold">
                        <td className="px-4 py-2">All accounts ({preview.currency})</td>
                        <td className="px-4 py-2 text-right font-mono">{preview.totals.current}</td>
                        <td className="px-4 py-2 text-right font-mono">{preview.totals.charged ?? '–'}</td>
                        <td className="px-4 py-2 text-right font-mono">{preview.totals.draft}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {pending && (
        <ReasonDialog
          title={pending.kind === 'create' ? 'Save the new price book?' : 'Remove this price book?'}
          confirmLabel={pending.kind === 'create' ? 'Save' : 'Remove'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        >
          {pending.kind === 'create' ? (
            <p>
              It prices usage from {whenUtc(pending.validFrom)} until a later book starts: {sourceLabel(pending.document)}. Once it starts, it never
              changes.
            </p>
          ) : (
            <p>The book that would have started {whenUtc(pending.book.validFrom)} goes; the active one goes on pricing.</p>
          )}
        </ReasonDialog>
      )}
    </div>
  );
};

export default Prices;
