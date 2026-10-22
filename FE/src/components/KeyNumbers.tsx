import React from 'react';

/** A strip of key numbers in cells joined by hairlines, as the direction borrows from Column's figures row. */
export const KeyNumbers: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({ label, className = 'grid-cols-2 lg:grid-cols-4', children }) => (
  <section aria-label={label} className={`grid gap-px overflow-hidden rounded-lg border border-line bg-line shadow-sm ${className}`}>
    {children}
  </section>
);

/** One key number: its label, the number, and a line under it. */
export const KeyNumber: React.FC<{ label: string; value: React.ReactNode; note?: React.ReactNode }> = ({ label, value, note }) => (
  <div className="flex min-w-0 flex-col gap-1 bg-white px-4 py-3.5">
    <span className="text-xs font-medium text-gray-500">{label}</span>
    <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</span>
    <span className="flex min-h-5 items-center justify-between gap-2 text-xs text-gray-600">{note}</span>
  </div>
);
