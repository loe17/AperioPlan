-- Version 1.2, Etappe 7: gesetzliche Regeln, automatische und feste Pausen, vergessenes Ausstempeln

create table time_breaks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null check (kind in ('legal', 'scheduled')),
  rule text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index time_breaks_user on time_breaks(user_id, starts_at);

-- Hinweise nur einmal je Tag und Art
create table time_warnings (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  kind text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);

alter table time_entries add column auto_closed boolean not null default false;
