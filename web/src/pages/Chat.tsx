import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, del, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { Avatar, Confirm, Empty, Field, Modal, useAction } from '../components/ui';
import { ChatView, useChannels } from '../modules/ChatView';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { PresenceDot, presenceLine } from '../components/Presence';

interface GroupDetail { id: string; name: string; icon: string; members: { userId: string; role: string; displayName: string }[] }

export default function ChatPage() {
  useCrumbs([{ label: 'Chat' }]);
  const [params, setParams] = useSearchParams();
  const { users, me } = useSession();
  const { data: channels, reload } = useChannels();
  const [newDm, setNewDm] = useState(false);
  const [groupEdit, setGroupEdit] = useState<GroupDetail | 'new' | null>(null);
  const [leave, setLeave] = useState<string | null>(null);
  const act = useAction();
  const active = params.get('channel');

  // /chat?user=<id> öffnet die Direktnachricht
  useEffect(() => {
    const uid = params.get('user');
    if (uid && uid !== me?.id) post('/chat/direct', { userId: uid }).then((c) => { invalidate('/chat/channels'); setParams({ channel: c.id }); });
  }, [params.get('user')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active && channels?.length && !params.get('user')) setParams({ channel: channels[0].id }, { replace: true }); }, [channels, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections: [string, string][] = [['group', 'Gruppen'], ['project', 'Projekte'], ['team', 'Abteilungen & Teams'], ['direct', 'Direktnachrichten']];
  const current = channels?.find((c) => c.id === active);
  const otherUser = current?.kind === 'direct' ? users.find((u) => u.id === current.otherUserId) : null;
  const openGroup = async (id: string) => setGroupEdit(await get<GroupDetail>(`/chat/groups/${id}`));

  return (
    <div className="chat">
      <div className="chat-list">
        {sections.map(([kind, label]) => {
          const list = channels?.filter((c) => c.kind === kind) ?? [];
          if (kind === 'group' && !list.length) return (
            <div key={kind} style={{ marginBottom: 12 }}>
              <div className="nav-title">{label}<button className="btn ghost sm" title="Gruppe anlegen" onClick={() => setGroupEdit('new')}><Icon name="plus" /></button></div>
            </div>
          );
          return (
            <div key={kind} style={{ marginBottom: 12 }}>
              <div className="nav-title">{label}
                {kind === 'direct' && <button className="btn ghost sm" title="Neue Direktnachricht" onClick={() => setNewDm(!newDm)}><Icon name="plus" /></button>}
                {kind === 'group' && <button className="btn ghost sm" title="Gruppe anlegen" onClick={() => setGroupEdit('new')}><Icon name="plus" /></button>}
              </div>
              {kind === 'direct' && newDm && (
                <select autoFocus onChange={(e) => { if (e.target.value) { setNewDm(false); setParams({ user: e.target.value }); } }} style={{ marginBottom: 6 }}>
                  <option value="">Mitarbeiter wählen …</option>
                  {users.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              )}
              {list.map((c) => {
                const other = users.find((u) => u.id === c.otherUserId);
                return (
                  <div key={c.id} className={`nav-item ${active === c.id ? 'active' : ''}`} onClick={() => setParams({ channel: c.id })}>
                    <span className="ico">{kind === 'direct' ? <Avatar id={c.otherUserId} name={c.name} /> : kind === 'project' ? <EntityIcon value={c.projectIcon} /> : kind === 'group' ? <EntityIcon value={c.icon} /> : <Icon name="team" />}</span>
                    <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                    {kind === 'direct' && <PresenceDot user={other} />}
                    {c.activeCallId && <span title="Laufender Anruf"><Icon name="video" /></span>}
                    {c.unread > 0 && <span className="count">{c.unread}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {current ? (
        <ChatView key={current.id} channelId={current.id} title={current.name}
          subtitle={current.kind === 'direct' ? <span className="row" style={{ gap: 6, display: 'inline-flex' }}><PresenceDot user={otherUser} /> {presenceLine(otherUser)}</span>
            : current.kind === 'group' ? `${current.memberCount} Mitglieder` : undefined}
          actions={current.kind === 'group' ? <>
            <button className="btn sm" onClick={() => openGroup(current.id)}><Icon name="users" /> Mitglieder</button>
            <button className="btn sm ghost" onClick={() => setLeave(current.id)}>Verlassen</button>
          </> : undefined} />
      ) : <div className="chat-main"><Empty icon="chat" title="Unterhaltung auswählen" /></div>}
      {groupEdit && <GroupModal group={groupEdit === 'new' ? null : groupEdit} onClose={() => setGroupEdit(null)}
        onSaved={async (id) => { setGroupEdit(null); invalidate('/chat/channels'); await reload(); if (id) setParams({ channel: id }); }} />}
      {leave && <Confirm text="Gruppe verlassen? Sie sehen danach keine neuen Nachrichten mehr." confirmLabel="Verlassen" danger onClose={() => setLeave(null)}
        onConfirm={async () => { await act(() => post(`/chat/groups/${leave}/leave`), 'Gruppe verlassen'); setLeave(null); setParams({}); invalidate('/chat/channels'); await reload(); }} />}
    </div>
  );
}

function GroupModal({ group, onClose, onSaved }: { group: GroupDetail | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const { users, me } = useSession();
  const act = useAction();
  const [name, setName] = useState(group?.name ?? '');
  const [icon, setIcon] = useState(group?.icon ?? 'chat');
  const [members, setMembers] = useState<string[]>(group?.members.map((m) => m.userId).filter((x) => x !== me!.id) ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const owner = !group || me!.role === 'admin' || group.members.some((m) => m.userId === me!.id && m.role === 'owner');
  const save = async () => {
    if (group) { const r = await act(() => patch(`/chat/groups/${group.id}`, { name, icon, memberIds: members }), 'Gruppe gespeichert'); if (r) onSaved(group.id); }
    else { const r = await act(() => post<{ id: string }>('/chat/groups', { name, icon, memberIds: members }), 'Gruppe angelegt'); if (r) onSaved(r.id); }
  };
  return (
    <Modal title={group ? `Gruppe „${group.name}“` : 'Neue Gruppe'} onClose={onClose}
      footer={<>
        {group && owner && <button className="btn danger" onClick={() => setConfirmDelete(true)}>Gruppe löschen</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Abbrechen</button>
        {owner && <button className="btn primary" disabled={!name.trim()} onClick={save}>{group ? 'Speichern' : 'Anlegen'}</button>}
      </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={name} disabled={!owner} onChange={(e) => setName(e.target.value)} placeholder="z. B. Messe 2027" /></Field>
        <Field label="Symbol"><IconPicker value={icon} onChange={(v) => owner && setIcon(v)} /></Field>
      </div>
      <Field label="Mitglieder" hint={owner ? 'Sie selbst sind automatisch dabei' : 'Nur der Ersteller ändert die Mitglieder'}>
        {owner ? <UserPicker users={users.filter((u) => u.id !== me!.id && u.role !== 'guest')} value={members} onChange={setMembers} />
          : <div>{group!.members.map((m) => <div key={m.userId} className="row" style={{ padding: 3 }}><Avatar id={m.userId} name={m.displayName} /> {m.displayName} {m.role === 'owner' && <span className="pill">Ersteller</span>}</div>)}</div>}
      </Field>
      {confirmDelete && group && <Confirm danger text="Gruppe mit allen Nachrichten für alle löschen?" confirmLabel="Löschen" onClose={() => setConfirmDelete(false)}
        onConfirm={async () => { await act(() => del(`/chat/groups/${group.id}`), 'Gruppe gelöscht'); onSaved(); }} />}
    </Modal>
  );
}
