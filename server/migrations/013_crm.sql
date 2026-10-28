-- Version 1.2, Etappe 5: CRM – Kunden und Lieferanten, Ansprechpartner, Notizen, Protokolle,
-- Verkaufschancen, Angebote, Reklamationen

create table number_counters (
  key text primary key,          -- z. B. 'customer', 'quote:2026'
  value integer not null default 0
);

create table crm_accounts (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  kind text not null default 'customer' check (kind in ('customer', 'supplier', 'both')),
  status text not null default 'customer' check (status in ('prospect', 'customer', 'former')),
  name text not null,
  street text not null default '',
  zip text not null default '',
  city text not null default '',
  country text not null default 'Deutschland',
  industry text not null default '',
  payment_terms text not null default '',
  website text not null default '',
  phone text not null default '',
  email text not null default '',
  vat_id text not null default '',
  owner_id uuid references users(id) on delete set null,
  notes text not null default '',
  custom jsonb not null default '{}',
  last_contact_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_accounts_name on crm_accounts(lower(name));

create table crm_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references crm_accounts(id) on delete cascade,
  salutation text not null default '',
  first_name text not null default '',
  last_name text not null,
  position text not null default '',
  department text not null default '',
  phone text not null default '',
  mobile text not null default '',
  email text not null default '',
  birthday date,
  preferred_channel text not null default '' check (preferred_channel in ('', 'phone', 'mobile', 'email', 'visit')),
  is_primary boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_contacts_account on crm_contacts(account_id);
create index crm_contacts_email on crm_contacts(lower(email));

create table crm_notes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references crm_accounts(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  body text not null,
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index crm_notes_account on crm_notes(account_id, created_at desc);

create table crm_minutes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references crm_accounts(id) on delete cascade,
  held_at timestamptz not null default now(),
  topic text not null,
  contact_ids uuid[] not null default '{}',
  user_ids uuid[] not null default '{}',
  other_participants text not null default '',
  discussed text not null default '',
  agreements jsonb not null default '[]',   -- [{text, assigneeId, dueDate, projectId, taskId}]
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_minutes_account on crm_minutes(account_id, held_at desc);

create table crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references crm_accounts(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete set null,
  title text not null,
  stage text not null default 'request' check (stage in ('request', 'offer', 'negotiation', 'won', 'lost')),
  value numeric(14,2),
  probability integer not null default 10 check (probability between 0 and 100),
  expected_close date,
  owner_id uuid references users(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  lost_reason text not null default '',
  description text not null default '',
  sort double precision not null default 0,
  closed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_opps_account on crm_opportunities(account_id);

create table crm_quotes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  account_id uuid not null references crm_accounts(id) on delete restrict,
  contact_id uuid references crm_contacts(id) on delete set null,
  opportunity_id uuid references crm_opportunities(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  calculation_id uuid,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected')),
  quote_date date not null default current_date,
  valid_until date,
  intro text not null default '',
  outro text not null default '',
  positions jsonb not null default '[]',     -- [{pos, text, description, qty, unit, price, discount}]
  vat_rate numeric(5,2) not null default 19,
  total_net numeric(14,2) not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_quotes_account on crm_quotes(account_id);

create table crm_cases (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  type text not null default 'complaint' check (type in ('complaint', 'service', 'question')),
  title text not null,
  description text not null default '',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'closed')),
  resolution text not null default '',
  assignee_id uuid references users(id) on delete set null,
  closed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_cases_account on crm_cases(account_id);

-- Termine mit Kunden
alter table calendar_events add column crm_account_id uuid references crm_accounts(id) on delete set null,
  add column crm_contact_ids uuid[] not null default '{}';

-- Kunde im Projekt: Auswahl aus dem CRM statt Freitext
alter table projects add column customer_id uuid references crm_accounts(id) on delete set null,
  add column customer_contact_id uuid references crm_contacts(id) on delete set null;

-- E-Mails einem Kunden zuordnen
alter table mail_messages add column crm_account_id uuid references crm_accounts(id) on delete set null;

-- Bestehende Kundennamen einmalig übernehmen (Schreibweise wird zum Zusammenführen angezeigt)
do $$
declare r record; n integer := 0;
begin
  for r in select distinct trim(customer) as name from projects where trim(coalesce(customer, '')) <> '' order by 1 loop
    n := n + 1;
    insert into crm_accounts (number, name, status) values ('K' || lpad(n::text, 4, '0'), r.name, 'customer');
  end loop;
  insert into number_counters (key, value) values ('customer', n);
  update projects p set customer_id = a.id from crm_accounts a where trim(p.customer) = a.name;
end $$;
