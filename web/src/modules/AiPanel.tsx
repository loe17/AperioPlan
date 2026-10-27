import { useState } from 'react';
import { post } from '../lib/api';
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
  const run = async () => {
    setBusy(true);
    const r = await act(() => post('/ai/chat', { mode, prompt, history, projectId, fileId, text: initialText }));
    setBusy(false);
    if (r) { setHistory([...history, { role: 'user', content: prompt || MODES.find((m) => m[0] === mode)![1] }, { role: 'assistant', content: r.answer }]); setPrompt(''); }
  };
  return (
    <SlideOver title={<b><Icon name="sparkles" /> KI-Assistent</b>} onClose={onClose}>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {MODES.filter(([m]) => m !== 'analyze' || fileId).map(([m, l, h]) => <button key={m} className={`btn sm ${mode === m ? 'primary' : ''}`} title={h} onClick={() => setMode(m)}>{l}</button>)}
      </div>
      {history.map((h, i) => (
        <div key={i} className="card" style={{ marginBottom: 10, background: h.role === 'user' ? 'var(--bg-soft)' : undefined }}>
          <div className="small muted" style={{ marginBottom: 4 }}>{h.role === 'user' ? 'Sie' : 'Assistent'}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{h.content}</div>
          {h.role === 'assistant' && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => navigator.clipboard.writeText(h.content)}>Kopieren</button>}
        </div>
      ))}
      <Field label={history.length ? 'Nachfrage' : 'Zusätzliche Anweisung (optional)'}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} /></Field>
      <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Denkt nach …' : 'Ausführen'}</button>
      <p className="hint" style={{ marginTop: 12 }}>Es werden nur Projektdaten übermittelt, auf die Sie Zugriff haben. Bei lokalen Modellen verlassen keine Daten das Firmennetz.</p>
    </SlideOver>
  );
}
