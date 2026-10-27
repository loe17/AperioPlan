-- Kern: Benutzer, Sitzungen, Teams, Einstellungen, Änderungsprotokoll, Benachrichtigungen
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  email text,
  password_hash text,                       -- null bei reinen LDAP-Konten
  auth_source text not null default 'local' check (auth_source in ('local', 'ldap')),
  role text not null default 'member' check (role in ('admin', 'teamlead', 'member', 'guest')),
  must_change_password boolean not null default false,
  active boolean not null default true,
  locale text not null default 'de',
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  vacation_days_per_year numeric(5,1) not null default 30,
  avatar_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_username_lower on users (lower(username));

create table sessions (
  id text primary key,                      -- SHA-256 des Sitzungstokens
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text,
  ip text
);
create index sessions_user on sessions(user_id);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text not null default '👥',
  description text not null default '',
  parent_id uuid references teams(id) on delete set null,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  is_lead boolean not null default false,
  primary key (team_id, user_id)
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lückenloses, revisionssicheres Änderungsprotokoll (nur anfügen, nie ändern)
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id) on delete set null,
  user_name text,
  action text not null,                     -- z. B. project.create, task.update
  entity_type text not null,
  entity_id text,
  project_id uuid,
  summary text not null default '',
  details jsonb
);
create index audit_entity on audit_log(entity_type, entity_id);
create index audit_project on audit_log(project_id);

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Das Änderungsprotokoll ist revisionssicher und kann nicht verändert werden';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications(user_id, read_at);

create table favorites (
  user_id uuid not null references users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create table private_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null default '',
  body text not null default '',
  updated_at timestamptz not null default now()
);
