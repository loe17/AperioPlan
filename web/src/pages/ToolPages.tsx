import { useCrumbs } from '../components/Layout';
import { PurchasingDashboard } from '../modules/Purchasing';
import { CalculationList } from '../modules/Calculations';

/** Werkzeug-Seiten außerhalb eines Projekts: Einkaufsübersicht und alle Kalkulationen */
export default function ToolPages({ tool }: { tool: 'purchasing' | 'calculation' }) {
  useCrumbs([{ label: tool === 'purchasing' ? 'Einkauf' : 'Kalkulation' }]);
  return (
    <div className="page wide">
      <div className="page-head"><div>
        <h1>{tool === 'purchasing' ? 'Einkauf' : 'Kalkulation'}</h1>
        <div className="sub">{tool === 'purchasing' ? 'Alle Bestellungen über alle Projekte, nach Projekt geordnet, und Bestellungen für das Lager. Die Bestellungen eines einzelnen Projekts finden Sie auch im Projekt unter „Einkauf“.'
          : 'Alle Kalkulationen; projektbezogene finden Sie auch im Projekt unter „Kalkulation“. Hier lassen sich z. B. Stundensätze ohne Projekt rechnen.'}</div>
      </div></div>
      {tool === 'purchasing' ? <PurchasingDashboard /> : <CalculationList />}
    </div>
  );
}
