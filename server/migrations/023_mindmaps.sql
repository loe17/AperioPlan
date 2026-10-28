-- Mindmaps: privat, geteilt oder zu einem Projekt
create table mindmaps (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  owner_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  data jsonb not null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
create index mindmaps_owner on mindmaps(owner_id);
create index mindmaps_project on mindmaps(project_id);

create table mindmap_shares (
  mindmap_id uuid not null references mindmaps(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  can_edit boolean not null default false,
  primary key (mindmap_id, user_id)
);
