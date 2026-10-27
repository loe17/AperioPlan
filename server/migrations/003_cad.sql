-- CAD-Zentrale / PDM (Kapitel 6B und 7)
create table cad_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete restrict,
  type text not null check (type in ('part', 'assembly', 'drawing')),
  base_number text not null,                -- 0100-100-00-0000
  main text not null, sub text not null, subsub text not null, part integer not null,
  revision integer not null default 0,      -- aktueller Versionsstand
  designation text not null,
  state text not null default 'in_work' check (state in ('in_work', 'review', 'released', 'obsolete')),
  procurement text not null default 'make' check (procurement in ('make', 'buy', 'standard')),
  properties jsonb not null default '{}',   -- Eigenschaften aus der Speichermaske (Custom Properties)
  drawing_of uuid references cad_items(id) on delete set null,  -- Zeichnung gehört zu Teil/Baugruppe
  file_path text,                           -- aktuelle Datei relativ zur Ablage
  checked_out_by uuid references users(id) on delete set null,
  checked_out_at timestamptz,
  checkout_host text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (base_number, type)
);
create index cad_items_project on cad_items(project_id);

create table cad_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references cad_items(id) on delete cascade,
  revision integer not null,
  reason text not null default '',
  file_path text,
  file_sha256 text,
  file_size bigint,
  properties jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (item_id, revision)
);

-- Baugruppenstruktur: Stückliste (parent -> child) und Verwendungsnachweis (child -> parent)
create table cad_references (
  parent_id uuid not null references cad_items(id) on delete cascade,
  child_id uuid not null references cad_items(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  primary key (parent_id, child_id),
  check (parent_id <> child_id)
);
create index cad_references_child on cad_references(child_id);

create table cad_state_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references cad_items(id) on delete cascade,
  revision integer not null,
  from_state text, to_state text not null,
  user_id uuid references users(id),
  comment text not null default '',
  at timestamptz not null default now()
);

-- Fertigungsableitungen (PDF, DXF, STEP) – erzeugt vom CAD-Wächter auf einem SolidWorks-Rechner
create table cad_exports (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references cad_items(id) on delete cascade,
  revision integer not null,
  format text not null check (format in ('pdf', 'dxf', 'step')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  file_path text,
  worker text,
  error text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (item_id, revision, format)
);
create index cad_exports_status on cad_exports(status, requested_at);
