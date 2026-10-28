-- Version 1.2, Etappe 2: Abteilung, Werkzeugrechte, Profilbild, Zwei-Faktor-Anmeldung,
-- Startassistent, Benachrichtigungs-Einstellungen, Löschen von Benutzern, Anwesenheit

alter table users
  add column department_id uuid references teams(id) on delete set null,
  add column tools text[],                       -- null = Voreinstellung der Abteilung
  add column phone text not null default '',
  add column avatar_path text,
  add column avatar_version int not null default 0,
  add column totp_secret text,                   -- verschlüsselt
  add column totp_enabled boolean not null default false,
  add column onboarded_at timestamptz,
  add column notify_prefs jsonb not null default '{}',
  add column deleted_at timestamptz,
  add column status_mode text not null default 'auto' check (status_mode in ('auto', 'online', 'idle', 'away', 'offline')),
  add column show_last_seen boolean not null default true,
  add column last_seen_at timestamptz;

-- Bestehende Konten sollen den Startassistenten nicht nachträglich sehen
update users set onboarded_at = now() where not must_change_password;

alter table teams add column default_tools text[];   -- null = alle Werkzeuge

-- Abteilung aus der ersten Teammitgliedschaft übernehmen
update users u set department_id = (select tm.team_id from team_members tm where tm.user_id = u.id order by tm.is_lead desc limit 1)
  where department_id is null;

-- Zwischenschritt der Anmeldung mit Zwei-Faktor-Code
create table login_tickets (
  id text primary key,                           -- SHA-256 des Tickets
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  attempts int not null default 0
);
