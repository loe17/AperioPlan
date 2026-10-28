-- Wissensdatenbank: Artikel mit Unterseiten in drei Bereichen (Firma, geteilt, privat)
create table kb_articles (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references kb_articles(id) on delete cascade,
  root_id uuid,                       -- oberster Artikel (bei Wurzel: eigene ID)
  scope text not null default 'workspace' check (scope in ('workspace', 'shared', 'private')),
  title text not null default '',
  icon text not null default '',
  content jsonb not null default '{"type":"doc","content":[]}',
  text text not null default '',       -- reiner Text für die Suche
  sort double precision not null default 0,
  owner_id uuid not null references users(id) on delete cascade,
  is_template boolean not null default false,
  locked boolean not null default false,
  full_width boolean not null default false,
  public_token text unique,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
create index kb_articles_parent on kb_articles(parent_id, sort);
create index kb_articles_root on kb_articles(root_id);

create table kb_members (
  article_id uuid not null references kb_articles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  permission text not null default 'edit' check (permission in ('read', 'edit')),
  primary key (article_id, user_id)
);

create table kb_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references kb_articles(id) on delete cascade,
  title text not null,
  content jsonb not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index kb_versions_article on kb_versions(article_id, created_at desc);

create table kb_favorites (
  user_id uuid not null references users(id) on delete cascade,
  article_id uuid not null references kb_articles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, article_id)
);
