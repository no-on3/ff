import React, { useState } from 'react';

/** A value to copy, selectable when the browser refuses the clipboard; lines kept as they are. */
const Copyable: React.FC<{ value: string; label: string; testId?: string }> = ({ value, label, testId }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false); // the browser refused: the value stays selectable
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code data-testid={testId} className="min-w-0 flex-1 select-all break-all whitespace-pre-wrap rounded bg-gray-100 px-3 py-2 font-mono text-[13px]">
        {value}
      </code>
      <button type="button" className="btn btn-secondary" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
};

export default Copyable;
