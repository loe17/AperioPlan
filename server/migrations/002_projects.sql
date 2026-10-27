-- Projekte, Teilprojekte, Dokumente, Aufgaben, Whiteboards, Kommentare
create table projects (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  seq integer not null,                     -- laufende Nummer (Hauptprojekt) bzw. Index (Teilprojekt)
  year integer,
  name text not null,
  description text not null default '',
  icon text not null default '🚀',
  parent_id uuid references projects(id) on delete restrict,
  team_id uuid references teams(id) on delete set null,
  status text not null default 'active' check (status in ('planned', 'active', 'paused', 'done', 'archived')),
  visibility text not null default 'company' check (visibility in ('company', 'team', 'members')),
  modules jsonb not null default '[]',
  folder_path text,
  customer text not null default '',
  start_date date,
  due_date date,
  report jsonb not null default '{}',       -- Abschlussbericht
  task_seq integer not null default 0,
  doc_seq integer not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_parent on projects(parent_id);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member', 'viewer')),
  primary key (project_id, user_id)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number integer not null,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'review', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references users(id) on delete set null,
  team_id uuid references teams(id) on delete set null,     -- Abteilung (Konstruktion, Elektro, Montage)
  start_date date,
  due_date date,
  estimate_hours numeric(8,2),
  milestone boolean not null default false,
  sort double precision not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, number)
);
create index tasks_project on tasks(project_id, status, sort);
create index tasks_assignee on tasks(assignee_id);

create table task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_id uuid not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,                -- task, kvp, cad_item, file
  entity_id uuid not null,
  user_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index comments_entity on comments(entity_type, entity_id, created_at);

create table whiteboards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  data jsonb not null default '{"items":[]}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number text not null unique,              -- 0100-DOK-001
  title text not null,
  file_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
