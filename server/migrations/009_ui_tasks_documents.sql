-- Version 1.2, Etappe 1: Beobachter von Aufgaben, Dokumentenregister mit Vorlagen

create table task_watchers (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (task_id, user_id)
);

alter table project_documents
  add column kind text not null default 'Sonstiges',
  add column version int not null default 1,
  add column status text not null default 'draft' check (status in ('draft', 'review', 'released', 'obsolete')),
  add column description text not null default '',
  add column template_id uuid;

create table document_templates (
  id uuid primary key default gen_random_uuid(),
  builtin_key text unique,                 -- mitgelieferte Vorlage (z. B. 'protokoll'), sonst null
  name text not null,
  kind text not null default 'Sonstiges',
  ext text not null,
  storage_path text,                       -- hochgeladene Vorlage
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
