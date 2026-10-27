-- Ressourcen (Räume, Fahrzeuge, Geräte) und ihre Buchungen
create extension if not exists btree_gist;

create table resources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'room' check (kind in ('room', 'vehicle', 'equipment', 'other')),
  location text not null default '',
  capacity integer,
  description text not null default '',
  color text not null default '#4f46e5',
  requires_approval boolean not null default false,
  approver_id uuid references users(id) on delete set null,   -- leer = Administratoren
  allowed_team_ids uuid[] not null default '{}',              -- leer = alle dürfen buchen
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table resource_bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default '',
  note text not null default '',
  project_id uuid references projects(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'approved' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  series_id uuid,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Doppelbuchungen sind technisch ausgeschlossen
  constraint resource_bookings_no_overlap exclude using gist (
    resource_id with =, tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'approved'))
);
create index resource_bookings_time on resource_bookings(starts_at, ends_at);
create index resource_bookings_user on resource_bookings(user_id);
