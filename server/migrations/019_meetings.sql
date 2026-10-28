-- Etappe 11b (0.2.0): Meetings mit Gast-Link und Warteraum

alter table chat_channels drop constraint if exists chat_channels_kind_check;
alter table chat_channels add constraint chat_channels_kind_check check (kind in ('project', 'direct', 'team', 'group', 'meeting'));

create table meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  host_id uuid not null references users(id) on delete cascade,
  channel_id uuid not null references chat_channels(id) on delete cascade,
  event_id uuid references calendar_events(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  crm_account_id uuid references crm_accounts(id) on delete set null,
  guest_token text not null unique,
  guests_allowed boolean not null default true,
  lobby boolean not null default true,
  pin text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at >= starts_at)
);
create index meetings_time on meetings (starts_at);

-- eingeladene Externe (Einladung per E-Mail)
create table meeting_invitees (
  meeting_id uuid not null references meetings(id) on delete cascade,
  email text not null,
  name text not null default '',
  invited_at timestamptz,
  primary key (meeting_id, email)
);

-- Gäste, die über den Link beitreten (ohne Benutzerkonto)
create table meeting_guests (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  name text not null,
  key_hash text not null,
  status text not null default 'waiting' check (status in ('waiting', 'admitted', 'denied', 'left')),
  joined_at timestamptz not null default now(),
  admitted_at timestamptz,
  left_at timestamptz
);
create index meeting_guests_meeting on meeting_guests (meeting_id, status);

alter table chat_messages add column guest_name text;
