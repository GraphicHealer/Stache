import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useApp } from '../../context';
import { IconBtn, useConfirm } from '../../components/Bits';
import { SettingsShell } from './SettingsShell';

/** Household & Account: members, invitations, password, sign out. */
export function HouseholdSettings() {
  const { toast, user, signOut } = useApp();
  const [askConfirm, confirmUi] = useConfirm();
  const qc = useQueryClient();
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const [member, setMember] = useState({ name: '', email: '', password: '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [confirmCapture, setConfirmCapture] = useState(
    () => localStorage.getItem('stache:confirm-capture') !== 'off',
  );
  const isAdmin = user?.role === 'admin';

  return (
    <SettingsShell title="Household & Account">
      <h2>Household</h2>
      <p className="muted">
        Items are shared with the household unless marked private on the item.
      </p>
      {(users?.users ?? []).map((u: any) => (
        <div key={u.id} className="row member-row">
          <span className="member-name">
            {u.name} <span className="muted">{u.email}</span>
            {u.role === 'admin' && <span className="badge warn">admin</span>}
          </span>
          {isAdmin && u.id !== user?.id && u.role !== 'admin' && (
            <IconBtn
              icon="trash"
              className="btn-small btn-ghost"
              label={`Remove ${u.name}`}
              onClick={async () => {
                if (!(await askConfirm(`Remove ${u.name}? Their private items become invisible to everyone.`, 'Remove'))) return;
                const r = await api.del(`/api/users/${u.id}`).catch((e) => (toast(e.message), null));
                if (!r) return;
                qc.invalidateQueries({ queryKey: ['users'] });
                toast('Member removed');
              }}
            />
          )}
        </div>
      ))}
      {isAdmin && (
        <>
          <input
            className="input"
            placeholder="Name"
            value={member.name}
            onChange={(e) => setMember({ ...member, name: e.target.value })}
          />
          <input
            className="input"
            type="email"
            placeholder="Email"
            value={member.email}
            onChange={(e) => setMember({ ...member, email: e.target.value })}
          />
          <input
            className="input"
            type="password"
            placeholder="Temporary password (8+ chars)"
            value={member.password}
            onChange={(e) => setMember({ ...member, password: e.target.value })}
          />
          <div className="row">
            <button
              className="btn"
              disabled={
                !member.name.trim() ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email) ||
                member.password.length < 8
              }
              onClick={async () => {
                try {
                  await api.post('/api/users', member);
                  setMember({ name: '', email: '', password: '' });
                  qc.invalidateQueries({ queryKey: ['users'] });
                  toast('Member added');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`);
                }
              }}
            >
              Add member
            </button>
          </div>
        </>
      )}

      <h2>Capture</h2>
      <label className="row">
        <input
          type="checkbox"
          checked={confirmCapture}
          onChange={(e) => {
            setConfirmCapture(e.target.checked);
            localStorage.setItem('stache:confirm-capture', e.target.checked ? 'on' : 'off');
          }}
        />
        <span>Confirm each photo before filing</span>
      </label>
      <p className="muted">
        Freeze the shot with a check/retake step. This device only.
      </p>

      <h2>Your password</h2>
      <input
        className="input"
        type="password"
        placeholder="Current password"
        value={pw.current}
        onChange={(e) => setPw({ ...pw, current: e.target.value })}
      />
      <input
        className="input"
        type="password"
        placeholder="New password (8+ chars)"
        value={pw.next}
        onChange={(e) => setPw({ ...pw, next: e.target.value })}
      />
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await api.post('/api/auth/change-password', {
                currentPassword: pw.current,
                newPassword: pw.next,
                revokeOtherSessions: true,
              });
              setPw({ current: '', next: '' });
              toast('Password changed - other sessions signed out');
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`);
            }
          }}
        >
          Change password
        </button>
        <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
      </div>
      {confirmUi}
    </SettingsShell>
  );
}
