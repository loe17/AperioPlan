-- Dateiverwaltung und externe Freigaben (Kapitel 9 und 10)
create table files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  path text not null unique,                -- relativ zur Ablage
  name text not null,
  size bigint not null default 0,
  sha256 text,
  mime text,
  version integer not null default 1,
  locked_by uuid references users(id) on delete set null,
  uploaded_by uuid references users(id) on delete set null,
  uploaded_via text,                        -- z. B. "Anforderungslink: Lieferant X"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index files_project on files(project_id);

create table file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  version integer not null,
  path text not null,                       -- Ablage der Altversion (.versions/...)
  size bigint not null,
  sha256 text,
  uploaded_by uuid references users(id) on delete set null,
  comment text not null default '',
  created_at timestamptz not null default now(),
  unique (file_id, version)
);

create table share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  kind text not null check (kind in ('guest', 'share', 'request')),
  label text not null default '',
  project_id uuid references projects(id) on delete cascade,
  folder_path text,                         -- Zielordner (request) bzw. geteilter Ordner
  file_ids uuid[] not null default '{}',
  areas text[] not null default '{}',       -- Gast: freigegebene Bereiche (files, drawings, tasks, cad)
  password_hash text,
  expires_at timestamptz,
  max_uses integer,
  use_count integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
