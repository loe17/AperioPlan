-- Chat, E-Mail und KVP-Ideenbox (Kapitel 12)
create table chat_channels (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('project', 'direct', 'team')),
  project_id uuid references projects(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  direct_key text unique,                   -- "<uuid>:<uuid>" sortiert bei Direktnachrichten
  name text not null default '',
  created_at timestamptz not null default now()
);
create unique index chat_channels_project on chat_channels(project_id) where kind = 'project';
create unique index chat_channels_team on chat_channels(team_id) where kind = 'team';

create table chat_members (
  channel_id uuid not null references chat_channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references chat_channels(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null,
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index chat_messages_channel on chat_messages(channel_id, created_at);

create table mail_messages (
  id uuid primary key default gen_random_uuid(),
  message_id text unique,
  mailbox text not null default 'INBOX',
  uid bigint,
  direction text not null default 'in' check (direction in ('in', 'out')),
  from_addr text not null default '',
  to_addrs text not null default '',
  cc_addrs text not null default '',
  subject text not null default '',
  date timestamptz,
  text_body text not null default '',
  html_body text,
  attachments jsonb not null default '[]',
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  assigned_by uuid references users(id) on delete set null,
  seen boolean not null default false,
  sent_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mail_messages_project on mail_messages(project_id);

create table kvp_ideas (
  id uuid primary key default gen_random_uuid(),
  number serial unique,
  title text not null,
  description text not null default '',
  team_id uuid references teams(id) on delete set null,
  savings_eur numeric(12,2),
  lead_id uuid references users(id) on delete set null,       -- zuständiger Teamleiter
  status text not null default 'new' check (status in ('new', 'review', 'accepted', 'implemented', 'rejected')),
  decision_note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table kvp_photos (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references kvp_ideas(id) on delete cascade,
  path text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references chat_channels(id) on delete cascade,
  started_by uuid references users(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
