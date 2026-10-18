import React from 'react';

/** A labelled value, in a page's list of facts. */
export const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-6">
    <dt className="font-medium">{label}</dt>
    <dd className="m-0 break-words">{children}</dd>
  </div>
);

/** A plain table of rows, each a list of cells. */
export const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div className="card overflow-x-auto p-0">
    <table className="w-full text-left text-sm">
      <thead className="bg-gray-50 text-gray-600">
        <tr>
          {head.map((label) => (
            <th key={label} className="px-4 py-2 font-medium">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, index) => (
          <tr key={index} className="border-t border-gray-200 align-top">
            {cells.map((cell, column) => (
              <td key={column} className="px-4 py-2">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
