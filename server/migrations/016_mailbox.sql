-- Version 1.2, Etappe 8: persönliches Firmen-Postfach (IMAP/SMTP) mit Ordnern, Entwürfen und Unterhaltungen

create table mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  imap_host text not null,
  imap_port integer not null default 993,
  imap_secure boolean not null default true,
  smtp_host text not null,
  smtp_port integer not null default 587,
  smtp_secure boolean not null default false,
  username text not null,
  password_sealed text not null,
  signature_html text not null default '',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table mail_folders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  path text not null,
  name text not null,
  special_use text,                 -- \Inbox \Sent \Drafts \Trash \Junk \Archive
  delimiter text not null default '/',
  uidvalidity bigint,
  last_uid bigint not null default 0,
  total integer not null default 0,
  unseen integer not null default 0,
  sort integer not null default 100,
  unique (account_id, path)
);

-- Nachrichten des persönlichen Postfachs liegen in derselben Tabelle wie das gemeinsame Projektpostfach
alter table mail_messages drop constraint if exists mail_messages_message_id_key;
alter table mail_messages
  add column account_id uuid references mail_accounts(id) on delete cascade,
  add column folder_id uuid references mail_folders(id) on delete cascade,
  add column flagged boolean not null default false,
  add column answered boolean not null default false,
  add column thread_key text,
  add column in_reply_to text,
  add column bcc_addrs text not null default '';
create unique index mail_messages_shared_mid on mail_messages(message_id) where account_id is null;
create unique index mail_messages_folder_uid on mail_messages(folder_id, uid) where folder_id is not null;
create index mail_messages_account on mail_messages(account_id, date desc);
create index mail_messages_thread on mail_messages(account_id, thread_key);

create table mail_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  to_addrs text not null default '',
  cc_addrs text not null default '',
  bcc_addrs text not null default '',
  subject text not null default '',
  html text not null default '',
  in_reply_to text,
  reply_of uuid references mail_messages(id) on delete set null,
  attachments jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- KI: Projekt kann einen eigenen Anbieter verwenden (z. B. lokales Modell für vertrauliche Projekte)
alter table projects add column ai_provider_id text;
