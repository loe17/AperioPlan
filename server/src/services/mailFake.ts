/**
 * Nachgebildeter Mail-Server für automatische Tests und Vorführungen (nur Server, die auf „.aperio.test“ enden,
 * und nur im Testbetrieb oder mit APERIO_MAIL_FAKE=1). Bildet die Teile von IMAP und SMTP nach, die AperioPlan nutzt,
 * und kann Fehler spielen: Passwort „falsch“ → Anmeldung abgelehnt, Server „aus.…“ → nicht erreichbar,
 * Benutzername mit „+busy“ → erster Sendeversuch „zu viele Verbindungen“, „+langsam“ → Test-E-Mail kommt nicht an.
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';

interface FakeMsg { uid: number; flags: Set<string>; source: Buffer }
interface FakeBox { path: string; specialUse: string | null; uidValidity: number; uidNext: number; messages: FakeMsg[] }
interface FakeAccount { email: string; boxes: Map<string, FakeBox>; busyLeft: number; slow: boolean }

const store = new Map<string, FakeAccount>();
let connections = 0;

export const isFakeHost = (host: string) => /\.aperio\.test$/i.test(host) && (process.env.NODE_ENV === 'test' || process.env.APERIO_MAIL_FAKE === '1');
export const fakeStats = () => ({ connections, accounts: store.size });
export function fakeReset() { store.clear(); connections = 0; }

/** Ein Postfach im nachgebildeten Server (wird beim ersten Zugriff angelegt) */
export function fakeAccount(email: string, opts: { noSpecialUse?: boolean } = {}): FakeAccount {
  const key = email.toLowerCase();
  let a = store.get(key);
  if (!a) {
    a = { email: key, boxes: new Map(), busyLeft: /\+busy/i.test(key) ? 1 : 0, slow: /\+langsam/i.test(key) };
    const mk = (path: string, specialUse: string | null) => a!.boxes.set(path, { path, specialUse: opts.noSpecialUse ? null : specialUse, uidValidity: 1, uidNext: 1, messages: [] });
    mk('INBOX', '\\Inbox'); mk('Sent', '\\Sent'); mk('Drafts', '\\Drafts'); mk('Trash', '\\Trash'); mk('Junk', '\\Junk');
    store.set(key, a);
  }
  return a;
}

function deliver(to: string, raw: Buffer, box = 'INBOX') {
  const a = store.get(to.toLowerCase());
  if (!a || a.slow) return false;
  const b = a.boxes.get(box)!;
  b.messages.push({ uid: b.uidNext++, flags: new Set(), source: raw });
  return true;
}

const fail = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

function check(host: string, user: string, pass: string) {
  if (/^aus\./i.test(host)) throw fail(`getaddrinfo ENOTFOUND ${host}`, { code: 'ENOTFOUND' });
  if (pass === 'falsch') throw fail('Authentication failed.', { authenticationFailed: true, code: 'EAUTH', responseCode: 535 });
  return fakeAccount(user.includes('@') ? user : `${user}@unbekannt.aperio.test`);
}

const rangeOf = (range: string, all: FakeMsg[], byUid: boolean) => {
  const max = byUid ? Math.max(0, ...all.map((m) => m.uid)) : all.length;
  const ids = new Set<number>();
  for (const part of range.split(',')) {
    const [a, b] = part.split(':');
    const lo = Number(a), hi = b === undefined ? lo : b === '*' ? Math.max(max, lo) : Number(b);
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) ids.add(i);
  }
  return all.filter((m, i) => ids.has(byUid ? m.uid : i + 1));
};

/** Ersatz für ImapFlow mit den genutzten Teilen */
export class FakeImap {
  usable = false;
  mailbox: { path: string; exists: number; uidValidity: number } | false = false;
  private acc: FakeAccount | null = null;
  private listeners: Record<string, (() => void)[]> = {};
  constructor(private opts: { host: string; auth: { user: string; pass?: string; accessToken?: string } }) {}
  on(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); return this; }
  async connect() {
    this.acc = check(this.opts.host, this.opts.auth.user, this.opts.auth.pass ?? this.opts.auth.accessToken ?? '');
    connections++;
    this.usable = true;
  }
  async logout() { this.close(); }
  close() { if (this.usable) { this.usable = false; connections--; this.listeners.close?.forEach((f) => f()); } }
  private box(path: string) { const b = this.acc!.boxes.get(path); if (!b) throw fail(`Mailbox doesn't exist: ${path}`, { code: 'NONEXISTENT' }); return b; }
  async list() { return [...this.acc!.boxes.values()].map((b) => ({ path: b.path, name: b.path, delimiter: '/', flags: new Set<string>(), specialUse: b.specialUse ?? undefined })); }
  async status(path: string) { const b = this.box(path); return { path, messages: b.messages.length, unseen: b.messages.filter((m) => !m.flags.has('\\Seen')).length, uidNext: b.uidNext }; }
  async getMailboxLock(path: string) {
    const b = this.box(path);
    this.mailbox = { path, exists: b.messages.length, uidValidity: b.uidValidity };
    return { path, release: () => { this.mailbox = false; } };
  }
  async *fetch(range: string, _q: unknown, opts: { uid?: boolean } = {}) {
    if (!this.mailbox) throw new Error('No mailbox selected');
    for (const m of rangeOf(range, this.box(this.mailbox.path).messages, Boolean(opts.uid))) yield { uid: m.uid, flags: new Set(m.flags), source: m.source };
  }
  private sel() { if (!this.mailbox) throw new Error('No mailbox selected'); return this.box(this.mailbox.path); }
  async messageFlagsAdd(range: string, flags: string[]) { for (const m of rangeOf(range, this.sel().messages, true)) flags.forEach((f) => m.flags.add(f)); return true; }
  async messageFlagsRemove(range: string, flags: string[]) { for (const m of rangeOf(range, this.sel().messages, true)) flags.forEach((f) => m.flags.delete(f)); return true; }
  async messageDelete(range: string) { const b = this.sel(); const gone = new Set(rangeOf(range, b.messages, true)); b.messages = b.messages.filter((m) => !gone.has(m)); return true; }
  async messageMove(range: string, target: string) {
    const b = this.sel(); const t = this.box(target);
    const moving = rangeOf(range, b.messages, true);
    b.messages = b.messages.filter((m) => !moving.includes(m));
    for (const m of moving) t.messages.push({ ...m, uid: t.uidNext++ });
    return { path: target };
  }
  async append(path: string, raw: Buffer | string, flags: string[] = []) {
    const b = this.box(path);
    b.messages.push({ uid: b.uidNext++, flags: new Set(flags), source: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) });
    return { destination: path };
  }
}

/** Ersatz für den nodemailer-Versand */
export function fakeSmtp(opts: { host: string; auth: { user: string; pass?: string; accessToken?: string } }) {
  return {
    async verify() { check(opts.host, opts.auth.user, opts.auth.pass ?? opts.auth.accessToken ?? ''); return true; },
    async sendMail(mail: Record<string, unknown>) {
      const acc = check(opts.host, opts.auth.user, opts.auth.pass ?? opts.auth.accessToken ?? '');
      if (acc.busyLeft > 0) { acc.busyLeft--; throw fail('421 Too many concurrent connections, try again later', { code: 'EENVELOPE', responseCode: 421 }); }
      const raw = await new MailComposer(mail as never).compile().build();
      const parsed = await simpleParser(raw);
      const rcpts = ['to', 'cc', 'bcc'].flatMap((k) => { const v = parsed[k as 'to']; return !v ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.value.map((y) => y.address ?? '')); });
      if (k('bcc', mail)) rcpts.push(...String(mail.bcc).split(',').map((s) => s.replace(/.*</, '').replace(/>.*/, '').trim()));
      for (const r of new Set(rcpts.filter(Boolean))) deliver(r, raw);
      return { messageId: parsed.messageId ?? `<fake-${Date.now()}@aperio.test>`, accepted: rcpts };
    },
  };
}
const k = (key: string, o: Record<string, unknown>) => Boolean(o[key]);
