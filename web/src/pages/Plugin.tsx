import { useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { Empty } from '../components/ui';
import { Icon } from '../components/Icon';

/** Eigene Seite eines Plugins (Entwickler-Schnittstelle) */
export function PluginPage() {
  const { id } = useParams();
  const { data } = useApi<any[]>('/plugins');
  const p = data?.find((x) => x.id === id && x.enabled && x.page);
  useCrumbs(p ? [{ label: p.page.label }] : []);
  if (!data) return null;
  if (!p) return <div className="page"><Empty icon="assembly" title="Plugin nicht gefunden oder nicht aktiv" /></div>;
  return <iframe title={p.name} src={`/plugins/${p.id}/${p.page.entry}`} style={{ width: '100%', height: 'calc(100vh - 52px)', border: 'none' }} />;
}
