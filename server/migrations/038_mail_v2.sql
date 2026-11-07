-- Version 0.4.0: E-Mail-Assistent, mehrere Postfächer je Person, Signaturen, Postausgang und Verlauf,
-- Berufsbezeichnung im Benutzerkonto, Reiter für sich ausblenden, Werkzeug-Favoriten.
-- Alles nur ergänzend – ältere Versionen laufen mit dieser Datenbank weiter.

alter table users
  add column job_title text not null default '',
  add column mobile text not null default '';

-- Mehrere Postfächer: owner_id ist der Inhaber. user_id bleibt nur beim Hauptpostfach gesetzt,
-- damit ältere Versionen weiterhin genau ein Postfach je Person finden (eindeutig, leer erlaubt).
alter table mail_accounts alter column user_id drop not null;
alter table mail_accounts
  add column owner_id uuid references users(id) on delete cascade,
  add column label text not null default '',
  add column provider text not null default '',
  add column auth_kind text not null default 'password' check (auth_kind in ('password', 'microsoft', 'google')),
  add column oauth_sealed text,
  add column folder_map jsonb not null default '{}',
  add column sig_new text not null default '',
  add column sig_reply text not null default '',
  add column sort integer not null default 0;
update mail_accounts set owner_id = user_id where owner_id is null;
create index mail_accounts_owner on mail_accounts(owner_id);

-- Signaturen gehören der Person und gelten für alle ihre Postfächer
create table mail_signatures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  html text not null default '',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mail_signatures_owner on mail_signatures(owner_id, sort);

-- Bisherige Signatur wird zur Signatur „Standard“ (das alte Feld bleibt gefüllt)
insert into mail_signatures (owner_id, name, html)
  select owner_id, 'Standard', signature_html from mail_accounts where signature_html <> '' and owner_id is not null;
update mail_accounts a set sig_new = s.id::text, sig_reply = s.id::text
  from mail_signatures s where s.owner_id = a.owner_id and s.html = a.signature_html and a.signature_html <> '';

-- Postausgang: jede E-Mail hat eine Kennung aus dem Schreibfenster, damit sie nie doppelt verschickt wird
create table mail_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  client_key text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  next_try_at timestamptz not null default now(),
  message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (account_id, client_key)
);
create index mail_outbox_due on mail_outbox(status, next_try_at);

-- Verlauf je Postfach in Klartext
create table mail_events (
  id bigserial primary key,
  account_id uuid not null references mail_accounts(id) on delete cascade,
  at timestamptz not null default now(),
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  text text not null
);
create index mail_events_account on mail_events(account_id, at desc);

-- Reiter, die jemand in einem Projekt nur für sich ausgeblendet hat
create table project_tab_hidden (
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  tabs text[] not null default '{}',
  primary key (user_id, project_id)
);

-- Werkzeug-Favoriten (getrennt von den Projekt-Favoriten)
create table tool_favorites (
  user_id uuid not null references users(id) on delete cascade,
  tool text not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, tool)
);
