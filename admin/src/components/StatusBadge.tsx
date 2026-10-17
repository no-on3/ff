import React from 'react';
import { AccountStatus, statusLabel } from '../lib/accounts';

const COLORS: Record<AccountStatus, string> = {
  pending: 'bg-amber-100 text-amber-900',
  active: 'bg-green-100 text-green-900',
  rejected: 'bg-gray-200 text-gray-800',
  suspended: 'bg-red-100 text-red-900',
  closed: 'bg-gray-700 text-white',
};

/** An account's status, in words and color. */
const StatusBadge: React.FC<{ status: AccountStatus }> = ({ status }) => (
  <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? 'bg-gray-200 text-gray-800'}`}>
    {statusLabel(status)}
  </span>
);

export default StatusBadge;
