-- Etappe 9 (1.2): PCB-Bridge (Leiterplatten, zuerst KiCad) und verbundene Arbeitsplätze der Wächter

create table pcb_boards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  seq integer not null,
  number text not null unique,
  revision integer not null default 0,
  designation text not null,
  properties jsonb not null default '{}',
  state text not null default 'in_work' check (state in ('in_work', 'review', 'released', 'obsolete')),
  file_path text,
  checked_out_by uuid references users(id) on delete set null,
  checked_out_at timestamptz,
  checkout_host text,
  step_cad_item_id uuid references cad_items(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, seq)
);
create index pcb_boards_project on pcb_boards (project_id);

create table pcb_revisions (
  board_id uuid not null references pcb_boards(id) on delete cascade,
  revision integer not null,
  reason text not null default '',
  properties jsonb not null default '{}',
  file_path text,
  file_size bigint,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (board_id, revision)
);

create table pcb_state_history (
  id bigserial primary key,
  board_id uuid not null references pcb_boards(id) on delete cascade,
  revision integer not null,
  from_state text,
  to_state text not null,
  user_id uuid references users(id) on delete set null,
  comment text not null default '',
  at timestamptz not null default now()
);

create table pcb_bom (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references pcb_boards(id) on delete cascade,
  revision integer not null,
  refs text not null default '',
  value text not null default '',
  footprint text not null default '',
  manufacturer text not null default '',
  manufacturer_no text not null default '',
  supplier_no text not null default '',
  qty integer not null default 1,
  dnp boolean not null default false,
  sort integer not null default 0
);
create index pcb_bom_board on pcb_bom (board_id, revision);

create table pcb_exports (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references pcb_boards(id) on delete cascade,
  revision integer not null,
  format text not null check (format in ('gerber', 'drill', 'pos', 'bom', 'schematic', 'step')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  worker text,
  error text,
  file_path text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (board_id, revision, format)
);

-- vom PCB-Wächter erkannte, noch nicht registrierte KiCad-Projekte (Speichermaske im Browser)
create table pcb_detected (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  host text not null default '',
  path text not null,
  name text not null,
  board_id uuid references pcb_boards(id) on delete cascade,
  dismissed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, host, path)
);

-- Arbeitsplätze mit CAD-/PCB-Wächter oder Export-Dienst
create table bridge_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('cad', 'pcb', 'export')),
  host text not null,
  os text not null default '',
  version text not null default '',
  app_version text not null default '',
  ip text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (user_id, kind, host)
);

alter table purchase_items add column pcb_board_id uuid references pcb_boards(id) on delete set null;
alter table purchase_items add column pcb_key text;
