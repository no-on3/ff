import React from 'react';

/** The pills' tones: healthy in the direction's teal, under way in blue, failed in red, idle in grey. */
export type PillTone = 'ok' | 'busy' | 'failed' | 'idle';

const TONES: Record<PillTone, string> = {
  ok: 'bg-green-100 text-green-700',
  busy: 'bg-blue-50 text-blue-600',
  failed: 'bg-red-50 text-red-700',
  idle: 'bg-gray-100 text-gray-600',
};

/** A status in a word, in a round pill with a dot of its color. */
const StatusPill: React.FC<{ tone: PillTone; label: string; title?: string }> = ({ tone, label, title }) => (
  <span className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ${TONES[tone]}`} title={title}>
    <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
    {label}
  </span>
);

export default StatusPill;
