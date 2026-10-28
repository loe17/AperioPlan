import { useEffect, useMemo, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../session';
import { isoDate } from '../lib/format';
import { Confirm, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Icon } from '../components/Icon';

export interface CalEvent {
  id: string; ownerId: string; ownerName: string; title: string; description: string; location: string; startsAt: string; endsAt: string;
  allDay: boolean; projectId: string | null; projectNumber?: string | null; private: boolean; recurrence: string; recurrenceUntil: string | null;
  reminderMinutes: number | null; bookingId: string | null; accountId: string | null; accountName?: string | null; accountColor?: string;
  readOnly?: boolean; crmAccountId?: string | null; crmAccountName?: string | null; resourceName?: string | null; bookingStatus?: string | null; mine?: boolean; myResponse?: string | null;
  attendees: { userId: string; displayName: string; response: string }[]; occurrence?: string;
}

export const RECURRENCE_LABEL: Record<string, string> = { none: 'Keine', daily: 'Täglich', weekdays: 'Jeden Werktag (Mo–Fr)', weekly: 'Wöchentlich', monthly: 'Monatlich', yearly: 'Jährlich' };
const REMINDERS: [string, string][] = [['', 'Keine'], ['0', 'Zu Beginn'], ['5', '5 Minuten vorher'], ['15', '15 Minuten vorher'], ['30', '30 Minuten vorher'], ['60', '1 Stunde vorher'], ['1440', '1 Tag vorher']];
const RESPONSE: Record<string, { label: string; tone: string }> = { accepted: { label: 'Zugesagt', tone: 'green' }, declined: { label: 'Abgesagt', tone: 'red' }, pending: { label: 'Offen', tone: '' } };

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const join = (date: string, time: string) => new Date(`${date}T${time || '00:00'}:00`);

/** Termin anlegen oder bearbeiten – mit Einladungen, Wiederholung, Erinnerung und Raum/Fahrzeug */
export function EventModal({ event, defaults, onClose, onSaved }: {
  event?: CalEvent | null; defaults?: { date?: string; projectId?: string | null; title?: string; attendeeIds?: string[]; crmAccountId?: string; location?: string };
  onClose: () => void; onSaved: () => void;
}) {
  const { me, users } = useSession();
  const act = useAction();
  const toast = useToast();
  const editable = !event || ((event.ownerId === me!.id || me!.role === 'admin') && !event.readOnly);
  const start0 = event ? new Date(event.startsAt) : (() => { const d = defaults?.date ? new Date(`${defaults.date}T09:00:00`) : new Date(); if (!defaults?.date) { d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); } return d; })();
  const end0 = event ? new Date(event.endsAt) : new Date(start0.getTime() + 3600000);
  const [f, setF] = useState({
    title: event?.title ?? defaults?.title ?? '', description: event?.description ?? '', location: event?.location ?? defaults?.location ?? '',
    allDay: event?.allDay ?? false, date: isoDate(start0), start: hm(start0),
    endDate: isoDate(event?.allDay ? new Date(end0.getTime() - 86400000) : end0), end: hm(end0),
    projectId: event?.projectId ?? defaults?.projectId ?? '', private: event?.private ?? false,
    recurrence: event?.recurrence ?? 'none', recurrenceUntil: event?.recurrenceUntil ?? '',
    reminder: event?.reminderMinutes == null ? (event ? '' : '15') : String(event.reminderMinutes),
    attendeeIds: event?.attendees.map((a) => a.userId) ?? defaults?.attendeeIds ?? [],
    accountId: event?.accountId ?? '',
  });
  const [resourceId, setResourceId] = useState('');
  const [free, setFree] = useState<{ id: string; name: string; kind: string; location: string }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: projects } = useApi<any[]>('/projects');
  const { data: accounts } = useApi<{ id: string; name: string; kind: string; pushNew: boolean }[]>('/calendar/accounts');
  const { data: types } = useApi<{ key: string; name: string }[]>('/resource-types');
  const writable = (accounts ?? []).filter((a) => a.kind === 'caldav');

  const startsAt = f.allDay ? new Date(`${f.date}T00:00:00`) : join(f.date, f.start);
  const endsAt = f.allDay ? new Date(new Date(`${f.endDate}T00:00:00`).getTime() + 86400000) : join(f.endDate, f.end);
  const valid = f.title.trim() && endsAt >= startsAt;

  // freie Räume/Fahrzeuge für den gewählten Zeitraum
  const key = `${startsAt.toISOString()}|${endsAt.toISOString()}`;
  useEffect(() => {
    if (!editable || event?.bookingId || endsAt <= startsAt || endsAt < new Date()) { setFree(null); return; }
    let alive = true;
    post<any[]>('/resources/availability', { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }).then((r) => alive && setFree(r)).catch(() => alive && setFree(null));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const freeByType = useMemo(() => (types ?? []).map((t) => ({ ...t, items: (free ?? []).filter((r) => r.kind === t.key) })).filter((t) => t.items.length), [types, free]);

  const save = async () => {
    let bookingId: string | null | undefined;
    if (resourceId) {
      const b = await act(() => post<{ ids: string[]; status: string }>('/resources/bookings', { resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), title: f.title, projectId: f.projectId || null }));
      if (!b) return;
      bookingId = b.ids[0];
      if (b.status === 'pending') toast('Die Buchung wartet noch auf Genehmigung');
    }
    const body = {
      title: f.title.trim(), description: f.description, location: f.location || (resourceId ? free?.find((r) => r.id === resourceId)?.name ?? '' : ''),
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), allDay: f.allDay, projectId: f.projectId || null, private: f.private,
      recurrence: f.recurrence, recurrenceUntil: f.recurrence !== 'none' && f.recurrenceUntil ? f.recurrenceUntil : null,
      reminderMinutes: f.reminder === '' ? null : Number(f.reminder), attendeeIds: f.attendeeIds,
      ...(bookingId ? { bookingId } : {}), ...(!event ? { accountId: f.accountId || null, crmAccountId: defaults?.crmAccountId ?? null } : {}),
    };
    const r = await act(() => (event ? patch<{ syncError: string | null }>(`/calendar/events/${event.id}`, body) : post<{ id: string; syncError: string | null }>('/calendar/events', body)), event ? 'Termin gespeichert' : 'Termin angelegt');
    if (!r) return;
    if (r.syncError) toast(`Im verbundenen Kalender nicht gespeichert: ${r.syncError}`, 'error');
    onSaved();
  };

  const respond = async (response: string) => {
    if (await act(() => post(`/calendar/events/${event!.id}/respond`, { response }), response === 'accepted' ? 'Zugesagt' : 'Abgesagt')) onSaved();
  };

  if (!editable && event) {
    const mine = event.attendees.find((a) => a.userId === me!.id);
    return (
      <Modal title={event.title} onClose={onClose} footer={<>
        {mine && <><button className={`btn ${mine.response === 'accepted' ? 'primary' : ''}`} onClick={() => respond('accepted')}><Icon name="check" /> Zusagen</button>
          <button className={`btn ${mine.response === 'declined' ? 'danger solid' : ''}`} onClick={() => respond('declined')}>Absagen</button></>}
        <span className="grow" /><button className="btn" onClick={onClose}>Schließen</button>
      </>}>
        <EventFacts e={event} />
      </Modal>
    );
  }

  return (
    <Modal size="lg" title={event ? 'Termin bearbeiten' : 'Neuer Termin'} onClose={onClose} footer={<>
      {event && <button className="btn danger" onClick={() => setConfirmDelete(true)}>Löschen</button>}
      <span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!valid} onClick={save}>{event ? 'Speichern' : 'Anlegen'}</button>
    </>}>
      <Field label="Titel" required><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Abstimmung Konstruktion" /></Field>
      <label className="row" style={{ marginBottom: 8 }}><input type="checkbox" checked={f.allDay} onChange={(e) => setF({ ...f, allDay: e.target.checked })} /> Ganztägig</label>
      <div className="grid2">
        <Field label="Beginn"><div className="row"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} />
          {!f.allDay && <input type="time" value={f.start} onChange={(e) => { const s = join(f.date, e.target.value); const dur = endsAt.getTime() - startsAt.getTime(); const en = new Date(s.getTime() + Math.max(dur, 0)); setF({ ...f, start: e.target.value, endDate: isoDate(en), end: hm(en) }); }} style={{ width: 110 }} />}</div></Field>
        <Field label="Ende"><div className="row"><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
          {!f.allDay && <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} style={{ width: 110 }} />}</div></Field>
        <Field label="Ort"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Raum, Adresse oder Link" /></Field>
        <Field label="Projekt"><select value={f.projectId ?? ''} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
        <Field label="Wiederholung"><select value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}>{Object.entries(RECURRENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.recurrence !== 'none' ? <Field label="Wiederholen bis" hint="leer = ohne Ende"><input type="date" value={f.recurrenceUntil ?? ''} onChange={(e) => setF({ ...f, recurrenceUntil: e.target.value })} /></Field>
          : <Field label="Erinnerung"><select value={f.reminder} onChange={(e) => setF({ ...f, reminder: e.target.value })}>{REMINDERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
        {f.recurrence !== 'none' && <Field label="Erinnerung"><select value={f.reminder} onChange={(e) => setF({ ...f, reminder: e.target.value })}>{REMINDERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
      </div>
      <Field label="Teilnehmer" hint="erhalten eine Einladung zum Zusagen oder Absagen">
        <UserPicker users={users.filter((u) => u.id !== me!.id && u.role !== 'guest')} value={f.attendeeIds} onChange={(ids) => setF({ ...f, attendeeIds: ids })} />
      </Field>
      {event?.attendees.length ? <div className="row wrap" style={{ marginBottom: 10, gap: 6 }}>{event.attendees.map((a) => <Pill key={a.userId} tone={RESPONSE[a.response]?.tone}>{a.displayName}: {RESPONSE[a.response]?.label}</Pill>)}</div> : null}
      {event?.bookingId ? <div className="card flat" style={{ marginBottom: 10 }}><Icon name="door" /> Gebucht: <b>{event.resourceName}</b>{event.bookingStatus === 'pending' && ' (wartet auf Genehmigung)'} – wird beim Löschen des Termins mit storniert.</div>
        : editable && free && freeByType.length > 0 && (
          <Field label="Raum oder Fahrzeug mitbuchen" hint="nur freie im gewählten Zeitraum">
            <select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">– nichts buchen –</option>
              {freeByType.map((t) => <optgroup key={t.key} label={t.name}>{t.items.map((r) => <option key={r.id} value={r.id}>{r.name}{r.location ? ` (${r.location})` : ''}</option>)}</optgroup>)}
            </select>
          </Field>
        )}
      <Field label="Beschreibung"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="row"><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Privat – Kollegen sehen nur „belegt“</label>
        {!event && writable.length > 0 && (
          <label className="row">Auch eintragen in:
            <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} style={{ width: 'auto' }}>
              <option value="">{writable.find((a) => a.pushNew) ? `${writable.find((a) => a.pushNew)!.name} (Standard)` : 'nur AperioPlan'}</option>
              {writable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {confirmDelete && event && <Confirm danger text={`Termin „${event.title}“${event.recurrence !== 'none' ? ' mit allen Wiederholungen' : ''} löschen? Teilnehmer erhalten eine Absage.`} confirmLabel="Löschen"
        onClose={() => setConfirmDelete(false)} onConfirm={async () => { const r = await act(() => del<{ syncError: string | null }>(`/calendar/events/${event.id}`), 'Termin gelöscht'); if (r?.syncError) toast(r.syncError, 'error'); onSaved(); }} />}
    </Modal>
  );
}

function EventFacts({ e }: { e: CalEvent }) {
  const s = new Date(e.startsAt), en = new Date(e.endsAt);
  const day = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return (
    <div className="facts">
      <div><Icon name="clock" /> {e.allDay ? day(s) : `${day(s)}, ${hm(s)} – ${hm(en)}`}{e.recurrence !== 'none' && ` · ${RECURRENCE_LABEL[e.recurrence]}`}</div>
      {e.location && <div><Icon name="location" /> {e.location}</div>}
      {e.resourceName && <div><Icon name="door" /> {e.resourceName}</div>}
      {e.crmAccountName && <div><Icon name="building" /> Kunde: {e.crmAccountName}</div>}
      <div><Icon name="user" /> Organisator: {e.ownerName}</div>
      {e.accountName && <div><Icon name="refresh" /> aus „{e.accountName}“{e.readOnly ? ' (nur lesen)' : ''}</div>}
      {e.attendees.length > 0 && <div className="row wrap" style={{ gap: 6 }}>{e.attendees.map((a) => <Pill key={a.userId} tone={RESPONSE[a.response]?.tone}>{a.displayName}: {RESPONSE[a.response]?.label}</Pill>)}</div>}
      {e.description && <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{e.description}</div>}
    </div>
  );
}

/** Termin per ID laden (z. B. aus einer Benachrichtigung) */
export async function loadEvent(id: string) { return get<CalEvent>(`/calendar/events/${id}`); }
