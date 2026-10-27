import { useCrumbs } from '../components/Layout';
export default function Page() {
  useCrumbs([{ label: 'Chat' }]);
  return <div className="page"><div className="empty">Dieser Bereich folgt in einer der nächsten Etappen.</div></div>;
}
