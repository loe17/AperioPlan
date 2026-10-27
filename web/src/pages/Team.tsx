import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { Avatar, Empty, Pill } from '../components/ui';
import { EntityIcon } from '../components/Icon';
import { NewProjectDialog, ProjectCards, type ProjectRow } from './Projects';

export default function TeamPage() {
  const { id } = useParams();
  const { teams, users, me } = useSession();
  const team = teams.find((t) => t.id === id);
  const { data } = useApi<ProjectRow[]>(`/projects?teamId=${id}`);
  const [newOpen, setNewOpen] = useState(false);
  useCrumbs(team ? [{ label: team.name }] : []);
  if (!team) return <div className="page"><Empty title="Team nicht gefunden" /></div>;
  return (
    <div className="page">
      <div className="page-head">
        <div className="entity-big"><EntityIcon value={team.icon} size={30} fallback="team" /></div>
        <div className="grow"><h1>{team.name}</h1><div className="sub">{team.description}</div></div>
        <div className="actions">{me?.role !== 'guest' && <button className="btn primary" onClick={() => setNewOpen(true)}>＋ Neues Projekt</button>}</div>
      </div>
      <h3 style={{ marginBottom: 10 }}>Mitglieder</h3>
      <div className="row wrap" style={{ marginBottom: 24 }}>
        {team.members.map((m) => (
          <div key={m.userId} className="card row" style={{ padding: '8px 12px' }}>
            <Avatar id={m.userId} name={m.displayName} />
            <span>{m.displayName}</span>
            {m.isLead && <Pill tone="accent">Teamleitung</Pill>}
            {users.find((u) => u.id === m.userId)?.online && <span className="dot ok" title="online" />}
          </div>
        ))}
        {!team.members.length && <span className="muted">Noch keine Mitglieder – Administratoren pflegen Teams unter Einstellungen.</span>}
      </div>
      <h3 style={{ marginBottom: 10 }}>Projekte</h3>
      {data?.length ? <ProjectCards projects={data} /> : <Empty icon="projects" title="Noch keine Projekte in diesem Team" />}
      {newOpen && <NewProjectDialog teamId={team.id} onClose={() => setNewOpen(false)} />}
    </div>
  );
}
