import type { Role } from '../services/api';
import { can } from './session';

/** The icons the sidebar draws (components/Icon.tsx). */
export type NavIcon = 'functions' | 'databases' | 'caches' | 'buckets' | 'queues' | 'email' | 'alarms' | 'usage' | 'billing' | 'settings' | 'notifications' | 'members' | 'keys';

export interface NavItem {
  to: string;
  label: string;
  icon: NavIcon;
  /** Open only on its own path, not on the paths under it: the account's settings, whose path the other account pages share. */
  end?: boolean;
  /** Also open on the console's home, which lists the functions. */
  home?: boolean;
}

export interface NavGroup {
  /** null: the first group, without a heading. */
  label: string | null;
  items: NavItem[];
}

/** The sidebar's pages for a role: the account's pages for every member; its members and API keys for those who may manage it (D4). */
export function consoleNav(role: Role): NavGroup[] {
  const account: NavItem[] = [
    { to: '/account', label: 'Settings', icon: 'settings', end: true },
    { to: '/account/notifications', label: 'Notifications', icon: 'notifications' },
  ];
  if (can(role, 'manage the account')) {
    account.push({ to: '/account/members', label: 'Members', icon: 'members' }, { to: '/account/api-keys', label: 'API keys', icon: 'keys' });
  }
  return [
    {
      label: null,
      items: [
        { to: '/functions', label: 'Functions', icon: 'functions', home: true },
        { to: '/databases', label: 'Databases', icon: 'databases' },
        { to: '/caches', label: 'Caches', icon: 'caches' },
        { to: '/buckets', label: 'Buckets', icon: 'buckets' },
        { to: '/queues', label: 'Queues', icon: 'queues' },
        { to: '/email', label: 'E-mail', icon: 'email' },
        { to: '/alarms', label: 'Alarms', icon: 'alarms' },
        { to: '/usage', label: 'Usage', icon: 'usage' },
        { to: '/billing', label: 'Billing', icon: 'billing' },
      ],
    },
    { label: 'Account', items: account },
  ];
}

/** Whether a page of the sidebar is the one open: its own path, a path under it unless `end`, or the home for `home`. */
export function isOpen(item: NavItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return item.home === true;
  return path === item.to || (!item.end && path.startsWith(`${item.to}/`));
}
