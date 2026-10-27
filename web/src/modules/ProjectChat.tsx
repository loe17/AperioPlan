import { useApi } from '../lib/hooks';
import { ChatView } from './ChatView';

export function ProjectChat({ projectId, project }: { projectId: string; project?: any }) {
  const { data } = useApi<{ id: string }>(`/projects/${projectId}/chat`);
  if (!data) return null;
  return <div className="card" style={{ padding: 0, overflow: 'hidden' }}><ChatView channelId={data.id} title={`${project?.number ?? ''} ${project?.name ?? ''}`} height="calc(100vh - 250px)" /></div>;
}
