-- Version 1.2, Etappe 4: Projektnummern-Bausteine, eigene Kanban-Spalten, Termine, Kalender-Abgleich, Ressourcenarten

-- Kürzel der Abteilung für die Projektnummer ({TEAM})
alter table teams add column short_code text not null default '';

-- Eigene Kanban-Spalten: jede gehört zu einer der vier Grundstufen
create table project_columns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  color text not null default '#6b7280',
  base_status text not null check (base_status in ('todo', 'in_progress', 'review', 'done')),
  sort double precision not null default 0,
  created_at timestamptz not null default now()
);
create index project_columns_project on project_columns(project_id, sort);
alter table tasks add column column_id uuid references project_columns(id) on delete set null;

-- Eigene Termine
create table calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('caldav', 'ics')),
  name text not null,
  url text not null,
  username text not null default '',
  password_sealed text not null default '',
  color text not null default '#0ea5e9',
  push_new boolean not null default false,       -- neue eigene Termine auch dort anlegen
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  description text not null default '',
  location text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  project_id uuid references projects(id) on delete set null,
  private boolean not null default false,
  recurrence text not null default 'none' check (recurrence in ('none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly')),
  recurrence_until date,
  reminder_minutes integer,
  reminded_at timestamptz,
  booking_id uuid references resource_bookings(id) on delete set null,
  account_id uuid references calendar_accounts(id) on delete cascade,
  external_uid text,
  external_href text,
  external_etag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at >= starts_at)
);
create index calendar_events_time on calendar_events(starts_at, ends_at);
create index calendar_events_owner on calendar_events(owner_id);
create unique index calendar_events_external on calendar_events(account_id, external_uid) where account_id is not null;

create table calendar_attendees (
  event_id uuid not null references calendar_events(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  response text not null default 'pending' check (response in ('pending', 'accepted', 'declined')),
  primary key (event_id, user_id)
);

-- persönlicher Abo-Link für Outlook / Handy
alter table users add column ical_token text unique;

-- Ressourcenarten selbst anlegen
create table resource_types (
  key text primary key,
  name text not null,
  icon text not null default 'box',
  color text not null default '#4f46e5',
  fields jsonb not null default '[]',          -- [{key, label, type: text|number|date, when: create|return}]
  sort integer not null default 0
);
insert into resource_types (key, name, icon, color, fields, sort) values
  ('room', 'Raum', 'door', '#4f46e5', '[]', 1),
  ('vehicle', 'Fahrzeug', 'car', '#0ea5e9', '[{"key":"plate","label":"Kennzeichen","type":"text","when":"resource"},{"key":"km","label":"Kilometerstand bei Rückgabe","type":"number","when":"return"}]', 2),
  ('equipment', 'Gerät', 'equipment', '#16a34a', '[]', 3),
  ('other', 'Sonstiges', 'box', '#6b7280', '[]', 4);
alter table resources drop constraint if exists resources_kind_check;
alter table resources add column extra jsonb not null default '{}';
alter table resource_bookings add column extra jsonb not null default '{}', add column returned_at timestamptz;
