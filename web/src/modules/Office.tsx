import { useSession } from '../session';

const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|csv|rtf)$/i;

/** Öffnet Word-, Excel- und PowerPoint-Dateien im Browser (Collabora Online, falls eingerichtet) */
export function OfficeButton({ projectId, entry }: { projectId: string; entry: { id?: string; name: string } }) {
  const { settings } = useSession();
  if (!settings?.officeEnabled || !entry.id || !OFFICE_EXT.test(entry.name)) return null;
  return <a className="btn ghost sm" title="Im Browser bearbeiten" href={`/office/${entry.id}?project=${projectId}`} target="_blank" rel="noreferrer">📝</a>;
}
