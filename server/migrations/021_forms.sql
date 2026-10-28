-- Etappe 11d (0.2.0): Formulare und Umfragen

create table forms (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  description text not null default '',
  owner_id uuid not null references users(id) on delete cascade,
  settings jsonb not null default '{}',
  public_token text unique,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table form_questions (
  id uuid primary key,
  form_id uuid not null references forms(id) on delete cascade,
  sort integer not null default 0,
  type text not null check (type in ('short', 'long', 'single', 'multiple', 'dropdown', 'date', 'time', 'datetime', 'scale', 'file', 'section')),
  text text not null default '',
  description text not null default '',
  required boolean not null default false,
  options jsonb not null default '[]',
  extra jsonb not null default '{}'
);
create index form_questions_form on form_questions (form_id, sort);

create table form_shares (
  form_id uuid not null references forms(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  everyone boolean not null default false,
  permission text not null default 'submit' check (permission in ('submit', 'results', 'edit')),
  check ((user_id is not null)::int + (team_id is not null)::int + everyone::int = 1)
);
create unique index form_shares_user on form_shares (form_id, user_id) where user_id is not null;
create unique index form_shares_team on form_shares (form_id, team_id) where team_id is not null;
create unique index form_shares_all on form_shares (form_id) where everyone;

create table form_responses (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  public boolean not null default false,
  answers jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index form_responses_form on form_responses (form_id, created_at);
