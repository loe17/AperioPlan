-- Kunden & Service: Service-Einsätze, Kundenanfragen (Helpdesk), Wartungs-/Serviceverträge, Terminbuchung, Messen/Veranstaltungen

create table svc_jobs (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  account_id uuid references crm_accounts(id) on delete set null,
  contact_name text not null default '',
  contact_phone text not null default '',
  address text not null default '',
  title text not null,
  description text not null default '',
  asset text not null default '',
  technician_ids jsonb not null default '[]',
  start_at timestamptz,
  end_at timestamptz,
  status text not null default 'planned' check (status in ('planned', 'on_way', 'in_progress', 'done', 'invoiced', 'cancelled')),
  report text not null default '',
  work jsonb not null default '[]',
  materials jsonb not null default '[]',
  travel_km numeric(10,1) not null default 0,
  signature jsonb,
  signed_by text not null default '',
  signed_at timestamptz,
  invoice_id uuid references crm_invoices(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  ticket_id uuid,
  contract_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index svc_jobs_start on svc_jobs(start_at);

create table hd_tickets (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  subject text not null,
  account_id uuid references crm_accounts(id) on delete set null,
  contact_name text not null default '',
  email text not null default '',
  phone text not null default '',
  status text not null default 'new' check (status in ('new', 'open', 'waiting', 'solved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category text not null default '',
  assignee_id uuid references users(id) on delete set null,
  channel text not null default 'web' check (channel in ('web', 'email', 'phone', 'internal')),
  due_at timestamptz,
  first_response_at timestamptz,
  solved_at timestamptz,
  token text not null unique,
  rating integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hd_tickets_status on hd_tickets(status, due_at);

create table hd_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references hd_tickets(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  author_name text not null default '',
  body text not null,
  internal boolean not null default false,
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index hd_messages_ticket on hd_messages(ticket_id, created_at);

create table hd_canned (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table ctr_contracts (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  account_id uuid not null references crm_accounts(id) on delete restrict,
  title text not null,
  kind text not null default 'maintenance' check (kind in ('maintenance', 'service', 'rental', 'license', 'other')),
  start_date date not null,
  end_date date,
  interval_months integer not null default 12 check (interval_months in (1, 3, 6, 12)),
  billing text not null default 'advance' check (billing in ('advance', 'arrears')),
  next_invoice_date date,
  positions jsonb not null default '[]',
  auto text not null default 'draft' check (auto in ('off', 'draft', 'send')),
  notice_months integer not null default 3,
  renew_months integer not null default 12,
  status text not null default 'active' check (status in ('draft', 'active', 'paused', 'cancelled', 'ended')),
  cancelled_to date,
  owner_id uuid references users(id) on delete set null,
  assets jsonb not null default '[]',
  visits_per_year integer not null default 0,
  sla_hours integer,
  notes text not null default '',
  notice_reminded_for date,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ctr_invoices (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references ctr_contracts(id) on delete cascade,
  invoice_id uuid references crm_invoices(id) on delete set null,
  period_from date not null,
  period_to date not null,
  created_at timestamptz not null default now(),
  unique (contract_id, period_from)
);

create table bk_types (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  duration_min integer not null default 30,
  buffer_min integer not null default 0,
  host_ids jsonb not null default '[]',
  availability jsonb not null default '{}',
  min_notice_hours integer not null default 12,
  max_days_ahead integer not null default 60,
  location text not null default '',
  online boolean not null default false,
  questions jsonb not null default '[]',
  color text not null default '#4f46e5',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table bk_bookings (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references bk_types(id) on delete cascade,
  host_id uuid references users(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  name text not null,
  email text not null,
  phone text not null default '',
  company text not null default '',
  answers jsonb not null default '{}',
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  token text not null unique,
  event_id uuid references calendar_events(id) on delete set null,
  meeting_link text,
  created_at timestamptz not null default now()
);
create index bk_bookings_host on bk_bookings(host_id, starts_at);

create table ev_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'fair' check (kind in ('fair', 'event', 'workshop', 'other')),
  location text not null default '',
  start_date date not null,
  end_date date not null,
  status text not null default 'planned' check (status in ('idea', 'planned', 'confirmed', 'done', 'cancelled')),
  description text not null default '',
  budget numeric(12,2),
  owner_id uuid references users(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  checklist jsonb not null default '[]',
  staff jsonb not null default '[]',
  public_token text unique,
  registration_open boolean not null default false,
  max_attendees integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ev_costs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references ev_events(id) on delete cascade,
  text text not null,
  category text not null default '',
  amount numeric(12,2) not null,
  date date,
  created_at timestamptz not null default now()
);

create table ev_leads (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references ev_events(id) on delete cascade,
  name text not null,
  company text not null default '',
  email text not null default '',
  phone text not null default '',
  interest text not null default '',
  notes text not null default '',
  rating text not null default 'warm' check (rating in ('hot', 'warm', 'cold')),
  follow_up date,
  account_id uuid references crm_accounts(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table ev_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references ev_events(id) on delete cascade,
  name text not null,
  company text not null default '',
  email text not null,
  persons integer not null default 1,
  note text not null default '',
  status text not null default 'registered' check (status in ('registered', 'cancelled', 'attended')),
  token text not null unique,
  created_at timestamptz not null default now()
);
