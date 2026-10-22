import React from 'react';
import { Link } from 'react-router-dom';

/** A page's column: up to 1200 px wide, with the same margins on every page. */
export const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-9 lg:py-8 print:p-0">{children}</div>
);

export interface Crumb {
  label: string;
  to: string;
}

/** A page's top: where it sits, its title and what it is for, and its actions on the right. */
export const PageHeader: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  crumbs?: Crumb[];
  /** Beside the title: a status, a tag. */
  aside?: React.ReactNode;
}> = ({ title, description, actions, crumbs, aside }) => (
  <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
    <div className="min-w-0">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5 text-xs text-gray-500">
          {crumbs.map((crumb) => (
            <React.Fragment key={crumb.to}>
              <Link to={crumb.to} className="font-medium text-gray-500 hover:text-ink">
                {crumb.label}
              </Link>
              <span className="mx-1.5" aria-hidden="true">
                /
              </span>
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-all">{title}</h1>
        {aside}
      </div>
      {description && <p className="mt-1.5 max-w-2xl text-gray-600">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>
);
