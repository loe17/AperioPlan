-- Etappe 11c (0.2.0): Telefonie – Anrufliste, Nebenstellen, Softphone

create table phone_users (
  user_id uuid primary key references users(id) on delete cascade,
  extension text not null default '',
  numbers text[] not null default '{}',
  sip_user text not null default '',
  sip_password_sealed text,
  sipgate_device text not null default '',
  updated_at timestamptz not null default now()
);

create table phone_calls (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text,
  direction text not null check (direction in ('in', 'out')),
  from_number text not null default '',
  to_number text not null default '',
  remote_number text not null default '',
  user_id uuid references users(id) on delete set null,
  crm_account_id uuid references crm_accounts(id) on delete set null,
  crm_contact_id uuid references crm_contacts(id) on delete set null,
  colleague_id uuid references users(id) on delete set null,
  status text not null default 'ringing' check (status in ('ringing', 'answered', 'missed', 'busy', 'ended', 'failed')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec integer,
  note text not null default '',
  note_id uuid references crm_notes(id) on delete set null,
  seen boolean not null default false
);
create unique index phone_calls_external on phone_calls (source, external_id) where external_id is not null;
create index phone_calls_user on phone_calls (user_id, started_at desc);
create index phone_calls_time on phone_calls (started_at desc);
