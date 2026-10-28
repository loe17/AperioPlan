import { useState } from 'react';
import type { TimeRuleSettings, TimeRuleSet, ScheduledBreak } from '@aperio/shared';
import { post } from '../lib/api';
import { useSession } from '../session';
import { Empty, Field, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { useAdminSettings } from './Settings';

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Regelsätze (DE/AT/CH), automatische Pausen, feste Betriebspausen, vergessenes Ausstempeln */
export function TimeRulesSettings() {
  const act = useAction();
  const { teams } = useSession();
  const rules = useAdminSettings('timeRules');
  const time = useAdminSettings('time');
  const [open, setOpen] = useState<string | null>(null);
  if (!rules.value || !time.value) return null;
  const s = rules.value as TimeRuleSettings;
  const set = (patch: Partial<TimeRuleSettings>) => rules.setValue({ ...s, ...patch });
  const setRule = (id: string, p: Partial<TimeRuleSet>) => set({ sets: s.sets.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const setSb = (i: number, p: Partial<ScheduledBreak>) => set({ scheduledBreaks: s.scheduledBreaks.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const importT = async (template: string) => { if (await act(() => post('/time/rules/import', { template }), 'Regelsatz übernommen')) await rules.reload(); };
  const TeamChecks = ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <div className="row wrap">{teams.map((t) => <label key={t.id} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={value.includes(t.id)} onChange={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])} />{t.name}</label>)}</div>
  );
  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginBottom: 8 }}>Zeiterfassung und Regeln</h1>
      <p className="muted">Die Vorlagen sind eine Hilfe, keine Rechtsberatung: Tarifverträge oder Betriebsvereinbarungen können abweichen, deshalb sind alle Werte änderbar.</p>

      <h2 style={{ margin: '18px 0 8px' }}>Allgemein</h2>
      <div className="grid2">
        <Field label="Runden auf Minuten" hint="1 = minutengenau"><input type="number" min={1} max={60} value={time.value.roundMinutes} onChange={(e) => time.setValue({ ...time.value, roundMinutes: Number(e.target.value) })} /></Field>
        <Field label="Soll-Stunden pro Tag"><input type="number" min={1} max={24} step="0.25" value={time.value.dailyHours} onChange={(e) => time.setValue({ ...time.value, dailyHours: Number(e.target.value) })} /></Field>
      </div>
      <button className="btn primary" onClick={() => act(() => time.save(time.value), 'Gespeichert')}>Speichern</button>

      <h2 style={{ margin: '24px 0 8px' }}>Regelsätze</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="small muted">Vorlage laden:</span>
        <button className="btn sm" onClick={() => importT('de')}>Deutschland</button>
        <button className="btn sm" onClick={() => importT('at')}>Österreich</button>
        <button className="btn sm" onClick={() => importT('ch')}>Schweiz</button>
      </div>
      {!s.sets.length && <Empty icon="shield" title="Noch kein Regelsatz">Laden Sie die Vorlage Ihres Landes – danach warnt die Stempeluhr und trägt Pflichtpausen selbst ein.</Empty>}
      {s.sets.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 10 }}>
          <div className="row click" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <Icon name={open === r.id ? 'chevron-down' : 'chevron-right'} /><b className="grow">{r.name}</b>
            {s.defaultSetId === r.id ? <span className="pill green">Standard</span> : <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); set({ defaultSetId: r.id }); }}>als Standard</button>}
            <span className="small muted">{r.teamIds.length ? teams.filter((t) => r.teamIds.includes(t.id)).map((t) => t.name).join(', ') : 'alle ohne eigenen Regelsatz'}</span>
          </div>
          {open === r.id && <div style={{ marginTop: 10 }}>
            <div className="grid2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <Field label="Name"><input value={r.name} onChange={(e) => setRule(r.id, { name: e.target.value })} /></Field>
              <Field label="Höchstarbeitszeit (Std./Tag)"><input type="number" step="0.5" value={r.maxDailyHours} onChange={(e) => setRule(r.id, { maxDailyHours: Number(e.target.value) })} /></Field>
              <Field label="Ruhezeit (Std.)"><input type="number" value={r.restHours} onChange={(e) => setRule(r.id, { restHours: Number(e.target.value) })} /></Field>
              <Field label="Pausenabschnitt mind. (Min.)"><input type="number" value={r.minSegmentMinutes} onChange={(e) => setRule(r.id, { minSegmentMinutes: Number(e.target.value) })} /></Field>
              <Field label="Vorwarnung (Min.)"><input type="number" value={r.warnBeforeMinutes} onChange={(e) => setRule(r.id, { warnBeforeMinutes: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Pausen (gestaffelt)">
              {r.breaks.map((b, i) => (
                <div key={i} className="row" style={{ marginBottom: 4 }}>
                  ab mehr als <input type="number" step="0.25" value={b.afterMinutes / 60} onChange={(e) => setRule(r.id, { breaks: r.breaks.map((x, j) => (j === i ? { ...x, afterMinutes: Math.round(Number(e.target.value) * 60) } : x)) })} style={{ width: 80 }} /> Std. Arbeit
                  insgesamt <input type="number" value={b.totalMinutes} onChange={(e) => setRule(r.id, { breaks: r.breaks.map((x, j) => (j === i ? { ...x, totalMinutes: Number(e.target.value) } : x)) })} style={{ width: 80 }} /> Min. Pause
                  <button className="btn ghost sm" onClick={() => setRule(r.id, { breaks: r.breaks.filter((_, j) => j !== i) })}><Icon name="x" /></button>
                </div>
              ))}
              <button className="btn sm ghost" onClick={() => setRule(r.id, { breaks: [...r.breaks, { afterMinutes: 360, totalMinutes: 30 }] })}><Icon name="plus" /> Stufe</button>
            </Field>
            <Field label="Gilt für Abteilungen" hint="keine gewählt = für alle ohne eigenen Regelsatz"><TeamChecks value={r.teamIds} onChange={(teamIds) => setRule(r.id, { teamIds })} /></Field>
            <div className="small muted">Quelle: {r.source}</div>
            <button className="btn sm danger" style={{ marginTop: 6 }} onClick={() => set({ sets: s.sets.filter((x) => x.id !== r.id), defaultSetId: s.defaultSetId === r.id ? null : s.defaultSetId })}>Regelsatz entfernen</button>
          </div>}
        </div>
      ))}
      <label className="row" style={{ margin: '10px 0' }}><input type="checkbox" checked={s.autoBreaks} onChange={(e) => set({ autoBreaks: e.target.checked })} /> Fehlende Pflichtpause automatisch eintragen (z. B. 30 Min. nach mehr als 6 Std. ohne Pause)</label>

      <h2 style={{ margin: '24px 0 8px' }}>Feste Betriebspausen</h2>
      <p className="muted small">Werden automatisch gestempelt, wenn man zu der Zeit eingestempelt ist. Wer in der Nähe schon selbst Pause gemacht hat, bekommt keine doppelte.</p>
      {s.scheduledBreaks.map((b, i) => (
        <div key={b.id} className="card" style={{ marginBottom: 8 }}>
          <div className="row wrap">
            <input value={b.name} onChange={(e) => setSb(i, { name: e.target.value })} style={{ width: 160 }} placeholder="z. B. Vesper" />
            <input type="time" value={b.start} onChange={(e) => setSb(i, { start: e.target.value })} style={{ width: 110 }} /> bis
            <input type="time" value={b.end} onChange={(e) => setSb(i, { end: e.target.value })} style={{ width: 110 }} />
            {WD.map((d, k) => <label key={d} className="row small" style={{ gap: 2 }}><input type="checkbox" checked={b.weekdays.includes(k + 1)} onChange={() => setSb(i, { weekdays: b.weekdays.includes(k + 1) ? b.weekdays.filter((x) => x !== k + 1) : [...b.weekdays, k + 1] })} />{d}</label>)}
            <button className="btn ghost sm" onClick={() => set({ scheduledBreaks: s.scheduledBreaks.filter((_, j) => j !== i) })}><Icon name="x" /></button>
          </div>
          <div style={{ marginTop: 6 }}><TeamChecks value={b.teamIds} onChange={(teamIds) => setSb(i, { teamIds })} /></div>
        </div>
      ))}
      <button className="btn sm" onClick={() => set({ scheduledBreaks: [...s.scheduledBreaks, { id: `p${Date.now()}`, name: 'Mittagspause', start: '12:00', end: '12:30', weekdays: [1, 2, 3, 4, 5], teamIds: [] }] })}><Icon name="plus" /> Feste Pause</button>

      <h2 style={{ margin: '24px 0 8px' }}>Ausstempeln vergessen</h2>
      <Field label="Automatisch ausstempeln nach (Stunden)" hint="0 = aus; danach wird eine Korrektur vorgeschlagen"><input type="number" min={0} max={24} value={s.autoClockOutHours} onChange={(e) => set({ autoClockOutHours: Number(e.target.value) })} style={{ width: 120 }} /></Field>
      <button className="btn primary" onClick={() => act(() => rules.save(s), 'Gespeichert')}>Regeln speichern</button>
    </div>
  );
}
