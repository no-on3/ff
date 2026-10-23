import React from 'react';

/** A white panel on the page: an optional header with its title and actions, then its content. */
export const Panel: React.FC<{
  title?: React.ReactNode;
  /** Under the title, in the header. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** The content touches the panel's edges: a table, a list. */
  flush?: boolean;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
}> = ({ title, description, actions, flush, className = '', children, 'aria-label': label }) => (
  <section aria-label={label} className={`min-w-0 overflow-hidden rounded-lg border border-line bg-white shadow-sm ${className}`}>
    {(title || actions) && (
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          {title && <h2 className="text-[15px] leading-6 font-semibold text-ink">{title}</h2>}
          {description && <p className="mt-0.5 text-[13px] text-gray-600">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
    )}
    <div className={flush ? '' : 'p-5'}>{children}</div>
  </section>
);

export type CalloutTone = 'neutral' | 'info' | 'warning' | 'danger';

const CALLOUT_TONES: Record<CalloutTone, string> = {
  neutral: 'border-line bg-gray-50 text-gray-700',
  info: 'border-blue-100 bg-blue-50 text-blue-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-900',
};

/** A notice in a page or a panel: what to know, in the tone of how much it matters. */
export const Callout: React.FC<{ tone: CalloutTone; title?: React.ReactNode; role?: 'alert' | 'status'; children?: React.ReactNode; className?: string }> = ({
  tone,
  title,
  role,
  children,
  className = '',
}) => (
  <div role={role} className={`rounded-lg border px-4 py-3 ${CALLOUT_TONES[tone]} ${className}`}>
    {title && <p className="font-medium">{title}</p>}
    {children && <div className={title ? 'mt-1 text-[13px]' : ''}>{children}</div>}
  </div>
);
