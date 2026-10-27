import { useNavigate } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { useMe } from '../session';
import { useT } from '../i18n';
import { Empty } from '../components/ui';
import { TaskTable } from '../modules/TaskTable';
import { ClockWidget } from './Time';
import { ProjectCards, type ProjectRow } from './Projects';
import type { Task } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

export function DeskPage() {
  const t = useT();
  const me = useMe();
  const nav = useNavigate();
  useCrumbs([{ label: `${t('Mein Schreibtisch')}` }]);
  const { data: tasks } = useApi<Task[]>('/tasks/mine');
  const { data: favorites } = useApi<ProjectRow[]>('/projects');
  const h = new Date().getHours();
  const greet = h < 11 ? t('Guten Morgen') : h < 18 ? t('Guten Tag') : t('Guten Abend');
  const favs = favorites?.filter((p) => p.favorite) ?? [];
  const overdue = tasks?.filter((x) => x.dueDate && new Date(x.dueDate) < new Date(new Date().toDateString())).length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greet}, {me.displayName.split(' ')[0]}</h1>
          <div className="sub">{new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </div>
      </div>
      <div className="card-grid" style={{ marginBottom: 24 }}>
        {me.role !== 'guest' && <ClockWidget compact />}
        <div className="card click" onClick={() => document.getElementById('mytasks')?.scrollIntoView({ behavior: 'smooth' })}>
          <div className="muted small">{t('Meine Aufgaben')}</div><div className="stat">{tasks?.length ?? '–'}</div>
          {overdue > 0 && <div className="small" style={{ color: 'var(--red)' }}>{overdue} überfällig</div>}
        </div>
      </div>
      {favs.length > 0 && <><h2 style={{ marginBottom: 10 }}><Icon name="star-filled" /> {t('Favoriten')}</h2><ProjectCards projects={favs} /><div className="spacer" /></>}
      <h2 id="mytasks" style={{ marginBottom: 10 }}>{t('Meine Aufgaben')}</h2>
      {tasks?.length ? <TaskTable tasks={tasks} showProject onOpen={(id) => { const tk = tasks.find((x) => x.id === id)!; nav(`/projects/${tk.projectId}?task=${id}`); }} />
        : <Empty icon="check-circle" title="Keine offenen Aufgaben" />}
    </div>
  );
}
