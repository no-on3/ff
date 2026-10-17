import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { frenchDate, frenchMoney, proFormaState } from '../lib/billing';
import { apiErrorMessage } from '../lib/functions';
import { formatMoney } from '../lib/usage';
import { ProForma, billingApi } from '../services/api';
import { useSession } from '../session/session';

const Line: React.FC<{ label: string; value: string; strong?: boolean }> = ({ label, value, strong }) => (
  <div className={`flex justify-between gap-6 py-1 ${strong ? 'font-bold border-t border-gray-400 pt-2' : ''}`}>
    <dt>{label}</dt>
    <dd className="tabular-nums text-right">{value}</dd>
  </div>
);

/** The document itself, in French, as Tunisian buyers file it: it prints alone, without the console around it. */
const Document: React.FC<{ proForma: ProForma; accountId: string }> = ({ proForma, accountId }) => {
  const { seller, buyer, bank, currency } = proForma;
  const money = (amount: string) => frenchMoney(amount, currency);
  return (
    <article lang="fr" aria-label="Pro-forma" className="card max-w-3xl space-y-8 print:max-w-none print:p-0 print:shadow-none">
      <header className="flex flex-wrap justify-between gap-6">
        <div>
          <h2 className="text-2xl font-bold">Facture pro forma</h2>
          <div className="mt-1">
            N°&nbsp;<span className="font-mono">{proForma.reference}</span>
          </div>
          <div>Date&nbsp;: {frenchDate(proForma.createdAt)}</div>
        </div>
        <div className="text-right">
          <div className="font-semibold">{seller.name}</div>
          <div>{seller.address}</div>
          {seller.taxId && <div>Matricule fiscal&nbsp;: {seller.taxId}</div>}
        </div>
      </header>

      <section>
        <h3 className="text-sm uppercase tracking-wide text-gray-600">Client</h3>
        <div className="font-semibold">{buyer.name}</div>
        {buyer.taxId && <div>Matricule fiscal&nbsp;: {buyer.taxId}</div>}
        <div>
          Compte FF&nbsp;: <span className="font-mono">{accountId}</span>
        </div>
      </section>

      <section>
        <table className="w-full text-left">
          <thead className="border-b border-gray-400">
            <tr>
              <th className="py-1 font-semibold">Désignation</th>
              <th className="py-1 text-right font-semibold">Montant HT</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-2">Crédit prépayé pour les services FF</td>
              <td className="py-2 text-right tabular-nums">{money(proForma.credit)}</td>
            </tr>
          </tbody>
        </table>
        <dl className="ml-auto mt-4 max-w-xs">
          <Line label="Total HT" value={money(proForma.credit)} />
          <Line label={`TVA ${proForma.vatPercent}\u00a0%`} value={money(proForma.vat)} />
          <Line label="Total TTC" value={money(proForma.total)} strong />
        </dl>
      </section>

      <section className="space-y-1">
        <h3 className="text-sm uppercase tracking-wide text-gray-600">Règlement par virement bancaire</h3>
        <div>Banque&nbsp;: {bank.name}</div>
        <div>
          IBAN&nbsp;: <span className="font-mono">{bank.iban}</span>
        </div>
        {bank.bic && (
          <div>
            BIC&nbsp;: <span className="font-mono">{bank.bic}</span>
          </div>
        )}
        <div className="pt-2">
          Libellé du virement&nbsp;: <strong className="font-mono">{proForma.reference}</strong>, indispensable pour identifier votre paiement.
        </div>
      </section>

      <footer className="space-y-1 text-sm text-gray-700">
        <p>Le crédit est ajouté à votre compte FF à réception du virement. En cas de retenue à la source, la part retenue est créditée à réception du certificat de retenue.</p>
        <p>Ce document n'est pas une facture&nbsp;: la facture est établie après réception du paiement.</p>
      </footer>
    </article>
  );
};

/**
 * A pro-forma (P-35, D9), to print or save as PDF from the browser, and above
 * it, in the console's language, where it stands: what to transfer, or what
 * FF received and credited.
 */
const ProFormaPage: React.FC = () => {
  const { id = '' } = useParams();
  const { account } = useSession();
  const [proForma, setProForma] = useState<ProForma | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    billingApi
      .getProForma(id)
      .then(({ data }) => setProForma(data))
      .catch((failure) => setError(apiErrorMessage(failure)));
  }, [id]);

  if (!account) return null;
  const state = proForma && proFormaState(proForma);
  return (
    <div className="container mx-auto px-4 space-y-6 print:px-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h1 className="text-2xl font-bold">Pro-forma {proForma?.reference}</h1>
        <div className="flex gap-3">
          <Link to="/billing" className="btn btn-secondary">
            Billing
          </Link>
          {proForma && (
            <button type="button" className="btn btn-primary" onClick={() => window.print()}>
              Print or save as PDF
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-red-700 print:hidden">
          {error}
        </p>
      )}
      {proForma && state && (
        <>
          <div role="status" className="rounded bg-blue-50 px-3 py-2 text-blue-900 print:hidden">
            {proForma.transfer ? (
              <>
                {state.label}.{state.note && ` ${state.note}.`}
              </>
            ) : (
              <>
                Transfer {formatMoney(proForma.total, proForma.currency)} to the account below, with <strong className="font-mono">{proForma.reference}</strong> in the transfer's label: FF
                adds {formatMoney(proForma.credit, proForma.currency)} of credit when it arrives.
              </>
            )}
          </div>
          <Document proForma={proForma} accountId={account.id} />
        </>
      )}
    </div>
  );
};

export default ProFormaPage;
