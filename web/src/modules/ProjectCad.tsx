import { CadCenter } from './CadCenter';
export function ProjectCad({ projectId, canEdit }: { projectId: string; project?: any; canEdit?: boolean }) {
  return <CadCenter projectId={projectId} canEdit={canEdit} />;
}
