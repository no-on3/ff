import React from 'react';

export const Loading: React.FC = () => <p className="text-gray-500">Loading…</p>;

/** What went wrong, as the API said it. */
export const ErrorState: React.FC<{ message: string }> = ({ message }) => (
  <div role="alert" className="rounded border border-red-300 bg-red-50 px-4 py-3 text-red-800">
    {message}
  </div>
);

/** Nothing to show, and why. */
export const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="rounded border border-dashed border-gray-300 px-4 py-6 text-center text-gray-500">{children}</p>
);
