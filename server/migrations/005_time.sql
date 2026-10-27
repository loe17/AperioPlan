-- Zeiterfassung, Korrekturanfragen, Abwesenheiten (Kapitel 11)
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,                     -- null = Stempeluhr läuft
  note text not null default '',
  source text not null default 'clock' check (source in ('clock', 'manual', 'correction')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);
create index time_entries_user on time_entries(user_id, started_at);
create index time_entries_project on time_entries(project_id);
create unique index time_entries_one_running on time_entries(user_id) where ended_at is null;

create table time_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  entry_id uuid references time_entries(id) on delete set null,
  kind text not null check (kind in ('add', 'change', 'delete')),
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  new_started_at timestamptz,
  new_ended_at timestamptz,
  what text not null,                       -- Was?
  reason text not null,                     -- Warum?
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table absences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null default 'vacation' check (kind in ('vacation', 'other')),
  start_date date not null,
  end_date date not null,
  half_day_start boolean not null default false,
  half_day_end boolean not null default false,
  days numeric(5,1) not null,
  note text not null default '',            -- nur für Antragsteller und Genehmiger sichtbar
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approver_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index absences_user on absences(user_id, start_date);

create table vacation_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  year integer not null,
  days numeric(5,1) not null,               -- Resturlaub aus Vorjahr, Sonderurlaub (+/-)
  note text not null default '',
  created_at timestamptz not null default now()
);

create table holidays (
  day date primary key,
  name text not null
);
