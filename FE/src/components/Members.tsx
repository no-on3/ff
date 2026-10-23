import React, { useCallback, useEffect, useState } from 'react';
import { formatWhen } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Members as MembersList, Role, membersApi } from '../services/api';
import { useSession } from '../session/session';

const ROLES: ReadonlyArray<{ role: Role; what: string }> = [
  { role: 'owner', what: 'everything: members, API keys and the account' },
  { role: 'developer', what: 'creates, changes and invokes functions' },
  { role: 'viewer', what: 'reads functions and their history' },
];

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="page max-w-5xl">
    <h1 className="mb-6">Members</h1>
    {children}
  </div>
);

/**
 * The account's members and invitations (P-16): its owners invite people by
 * e-mail, change roles and remove members. An invited person joins at their
 * next login with that address, within seven days.
 */
const Members: React.FC = () => {
  const { account, me, login } = useSession();
  const [list, setList] = useState<MembersList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [busy, setBusy] = useState(false);

  const owner = account !== null && can(account.role, 'manage the account');
  const load = useCallback(async () => {
    try {
      setList((await membersApi.listMembers()).data);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  const accountId = account?.id;
  const loggedIn = login !== null;
  useEffect(() => {
    if (accountId && loggedIn && owner) void load();
  }, [accountId, loggedIn, owner, load]);

  if (!account) return null;
  if (!login) {
    return (
      <Page>
        <div className="card">
          Development mode acts as one account without a user, so it has no members: log in to manage them (see "Log in with
          Keycloak" in the getting-started guide).
        </div>
      </Page>
    );
  }
  if (!owner) {
    return (
      <Page>
        <div className="card">Only the account's owners manage its members.</div>
      </Page>
    );
  }

  /** Runs a change, shows the API's reason when it is refused, and reads the list again. True when it was made. */
  const act = async (change: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await change();
    } catch (failure) {
      setError(apiErrorMessage(failure));
      setBusy(false);
      return false;
    }
    await load(); // the list as it is now, then the notice: they change together
    setNotice(done);
    setBusy(false);
    return true;
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    await act(() => membersApi.invite(address, role), `Invitation sent to ${address.toLowerCase()}.`);
    setEmail('');
  };

  const handleRemove = async (userId: string, who: string) => {
    const leaving = userId === me.user?.id;
    const question = leaving ? `Leave "${account.name}"? You lose access at once.` : `Remove ${who}? Their API keys stop working at once.`;
    if (!window.confirm(question)) return;
    const removed = await act(() => membersApi.removeMember(userId), `${who} was removed.`);
    if (removed && leaving) window.location.assign('/'); // this account is no longer yours: start again
  };

  return (
    <Page>
      <p className="mb-6 text-gray-600">
        Invite someone by e-mail: they join "{account.name}" the next time they log in to the console with that address, within
        seven days. Without a login yet, they sign up with it.
      </p>
      {notice && (
        <div role="status" className="mb-4 text-green-700">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="mb-4 text-red-600">
          {error}
        </div>
      )}

      <form onSubmit={handleInvite} className="card mb-6 space-y-4">
        <h2 className="text-[15px] leading-6 font-semibold text-ink">Invite</h2>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <div>
            <label htmlFor="invite-email" className="block text-sm font-medium text-gray-700 mb-1">
              E-mail address
            </label>
            <input id="invite-email" type="email" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="invite-role" className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <select id="invite-role" className="input bg-white" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.role}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Invite
          </button>
        </div>
        <ul className="text-sm text-gray-500">
          {ROLES.map((r) => (
            <li key={r.role}>
              <strong>{r.role}</strong>: {r.what}
            </li>
          ))}
        </ul>
      </form>

      <div className="card mb-6 overflow-x-auto">
        <h2 className="text-[15px] leading-6 font-semibold text-ink mb-4">Members</h2>
        {list === null ? (
          <p>Loading…</p>
        ) : (
          <table className="data-table">
            <thead className="text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">E-mail</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Joined</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {list.members.map((member) => (
                <tr key={member.userId} data-member={member.email} className="border-t border-gray-200">
                  <td className="py-2 pr-4">
                    {member.email}
                    {member.userId === me.user?.id && <span className="text-gray-500"> (you)</span>}
                  </td>
                  <td className="py-2 pr-4">{member.name ?? '—'}</td>
                  <td className="py-2 pr-4">
                    <select
                      aria-label={`Role of ${member.email}`}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1"
                      value={member.role}
                      disabled={busy}
                      onChange={(e) =>
                        void act(() => membersApi.changeRole(member.userId, e.target.value as Role), `${member.email} is now ${e.target.value}.`)
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r.role} value={r.role}>
                          {r.role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(member.joinedAt)}</td>
                  <td className="py-2 text-right">
                    <button type="button" className="text-red-600 hover:text-red-800" disabled={busy} onClick={() => void handleRemove(member.userId, member.email)}>
                      {member.userId === me.user?.id ? 'Leave' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {list && list.invitations.length > 0 && (
        <div className="card overflow-x-auto">
          <h2 className="text-[15px] leading-6 font-semibold text-ink mb-4">Invitations</h2>
          <table className="data-table">
            <thead className="text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">E-mail</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {list.invitations.map((invitation) => (
                <tr key={invitation.id} data-invitation={invitation.email} className="border-t border-gray-200">
                  <td className="py-2 pr-4">{invitation.email}</td>
                  <td className="py-2 pr-4">{invitation.role}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {invitation.expired ? 'Expired: invite again to renew it' : formatWhen(invitation.expiresAt)}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      className="text-red-600 hover:text-red-800"
                      disabled={busy}
                      onClick={() => void act(() => membersApi.cancelInvitation(invitation.id), `The invitation to ${invitation.email} was cancelled.`)}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
};

export default Members;
