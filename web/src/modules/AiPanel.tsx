import { useState } from 'react';
import { post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Field, SlideOver, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

const MODES: [string, string, string][] = [
  ['summarize', 'Zusammenfassen', 'Fortschritt, Risiken und nächste Schritte'],
  ['write', 'Schreibhilfe', 'z. B. Statusbericht an den Kunden formulieren'],
  ['analyze', 'Dokument analysieren', 'Kernaussagen und offene Fragen'],
  ['free', 'Frage stellen', 'Freie Frage zum Projekt'],
];

/** KI-Assistent: nutzt die in den Einstellungen hinterlegte lokale oder externe KI */
export function AiPanel({ projectId, fileId, initialText, onClose }: { projectId?: string; fileId?: string; initialText?: string; onClose: () => void }) {
  const act = useAction();
  const [mode, setMode] = useState(fileId ? 'analyze' : 'summarize');
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: providers } = useApi<{ id: string; name: string; online: boolean; isDefault: boolean }[]>('/ai/providers');
  const { data: project } = useApi<any>(projectId ? `/projects/${projectId}` : null);
  const [providerId, setProviderId] = useState('');
  const auto = providers?.find((p) => p.id === project?.aiProviderId) ?? providers?.find((p) => p.isDefault);
  const current = providers?.find((p) => p.id === providerId) ?? auto;
  const run = async () => {
    setBusy(true);
    const r = await act(() => post('/ai/chat', { mode, prompt, history, projectId, fileId, text: initialText, providerId: providerId || undefined }));
    setBusy(false);
    if (r) { setHistory([...history, { role: 'user', content: prompt || MODES.find((m) => m[0] === mode)![1] }, { role: 'assistant', content: r.answer }]); setPrompt(''); }
  };
  return (
    <SlideOver title={<b><Icon name="sparkles" /> KI-Assistent</b>} onClose={onClose}>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {MODES.filter(([m]) => m !== 'analyze' || fileId).map(([m, l, h]) => <button key={m} className={`btn sm ${mode === m ? 'primary' : ''}`} title={h} onClick={() => setMode(m)}>{l}</button>)}
      </div>
      {providers && providers.length > 1 && (
        <Field label="Anbieter"><select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">{project?.aiProviderId ? 'wie im Projekt eingestellt' : 'Standard'} ({auto?.name})</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.online ? ' (online)' : ' (eigenes Netz)'}</option>)}
        </select></Field>
      )}
      {current?.online && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)', padding: '8px 12px' }}><Icon name="globe" /> <b>{current.name}</b> ist ein Online-Dienst: Ihre Anfrage und die nötigen Projektdaten werden an den Anbieter übertragen.</div>}
      {history.map((h, i) => (
        <div key={i} className="card" style={{ marginBottom: 10, background: h.role === 'user' ? 'var(--bg-soft)' : undefined }}>
          <div className="small muted" style={{ marginBottom: 4 }}>{h.role === 'user' ? 'Sie' : 'Assistent'}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{h.content}</div>
          {h.role === 'assistant' && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => navigator.clipboard.writeText(h.content)}>Kopieren</button>}
        </div>
      ))}
      <Field label={history.length ? 'Nachfrage' : 'Zusätzliche Anweisung (optional)'}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} /></Field>
      <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Denkt nach …' : 'Ausführen'}</button>
      <p className="hint" style={{ marginTop: 12 }}>Es werden nur Projektdaten übermittelt, auf die Sie Zugriff haben. Beim eigenen Modell verlassen keine Daten das Firmennetz.</p>
    </SlideOver>
  );
}
