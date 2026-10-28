-- Produktion & Technik: Instandhaltung, Qualität, Fertigung, Änderungsmanagement

-- Instandhaltung: Wartungspläne je Anlage (Inventar) und Aufträge (geplant oder Störung)
create table mnt_plans (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references inv_assets(id) on delete cascade,
  title text not null,
  interval_days integer not null check (interval_days > 0),
  next_due date not null,
  lead_days integer not null default 7,
  checklist jsonb not null default '[]',
  responsible_id uuid references users(id) on delete set null,
  estimate_minutes integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index mnt_plans_asset on mnt_plans(asset_id);

create table mnt_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  asset_id uuid references inv_assets(id) on delete set null,
  plan_id uuid references mnt_plans(id) on delete set null,
  kind text not null check (kind in ('preventive', 'corrective')),
  title text not null,
  description text not null default '',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  machine_down boolean not null default false,
  reported_by uuid references users(id) on delete set null,
  assignee_id uuid references users(id) on delete set null,
  due_date date,
  checklist jsonb not null default '[]',
  started_at timestamptz,
  finished_at timestamptz,
  work_minutes integer not null default 0,
  material_cost numeric(12,2) not null default 0,
  external_cost numeric(12,2) not null default 0,
  report text not null default '',
  photos jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mnt_orders_asset on mnt_orders(asset_id, created_at desc);
create index mnt_orders_open on mnt_orders(status) where status not in ('done', 'cancelled');

-- Qualität: Prüfpläne mit Merkmalen, Prüfungen, Messmittel mit Kalibrierung, 8D-Reports
create table qm_plans (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  title text not null,
  object text not null default '',
  article_id uuid references wh_articles(id) on delete set null,
  characteristics jsonb not null default '[]',
  sample text not null default '',
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table qm_inspections (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  plan_id uuid references qm_plans(id) on delete set null,
  title text not null,
  kind text not null default 'incoming' check (kind in ('incoming', 'production', 'final', 'other')),
  reference text not null default '',
  project_id uuid references projects(id) on delete set null,
  supplier_id uuid references crm_accounts(id) on delete set null,
  lot text not null default '',
  qty numeric(14,3),
  characteristics jsonb not null default '[]',
  result text not null default 'open' check (result in ('open', 'pass', 'fail', 'conditional')),
  notes text not null default '',
  inspector_id uuid references users(id) on delete set null,
  inspected_at timestamptz,
  created_at timestamptz not null default now()
);

create table qm_gauges (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  name text not null,
  kind text not null default '',
  manufacturer text not null default '',
  serial_no text not null default '',
  range text not null default '',
  resolution text not null default '',
  location text not null default '',
  holder_id uuid references users(id) on delete set null,
  interval_months integer not null default 12,
  next_due date,
  status text not null default 'ok' check (status in ('ok', 'blocked', 'retired')),
  reminded_for date,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table qm_calibrations (
  id uuid primary key default gen_random_uuid(),
  gauge_id uuid not null references qm_gauges(id) on delete cascade,
  date date not null,
  result text not null check (result in ('ok', 'adjusted', 'failed')),
  by_whom text not null default '',
  certificate_path text,
  certificate_name text,
  notes text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table qm_8d (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  title text not null,
  source text not null default 'customer' check (source in ('customer', 'supplier', 'internal')),
  account_id uuid references crm_accounts(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  reference text not null default '',
  status text not null default 'open' check (status in ('open', 'containment', 'analysis', 'actions', 'verification', 'closed')),
  owner_id uuid references users(id) on delete set null,
  team jsonb not null default '[]',
  d jsonb not null default '{}',
  due_date date,
  closed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fertigung: Arbeitsplätze, Fertigungsaufträge mit Stückliste und Arbeitsgängen, Rückmeldungen
create table mfg_workcenters (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  hourly_rate numeric(10,2) not null default 0,
  hours_per_day numeric(5,2) not null default 8,
  active boolean not null default true
);

create table mfg_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  title text not null,
  project_id uuid references projects(id) on delete set null,
  cad_item_id uuid references cad_items(id) on delete set null,
  article_id uuid references wh_articles(id) on delete set null,
  qty numeric(14,3) not null default 1,
  qty_done numeric(14,3) not null default 0,
  qty_scrap numeric(14,3) not null default 0,
  status text not null default 'planned' check (status in ('planned', 'released', 'in_progress', 'done', 'cancelled')),
  priority integer not null default 0,
  start_date date,
  due_date date,
  bom jsonb not null default '[]',
  operations jsonb not null default '[]',
  notes text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mfg_orders_status on mfg_orders(status, due_date);

create table mfg_feedback (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references mfg_orders(id) on delete cascade,
  op integer not null,
  user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('start', 'stop', 'done')),
  minutes integer not null default 0,
  qty_good numeric(14,3) not null default 0,
  qty_scrap numeric(14,3) not null default 0,
  note text not null default '',
  at timestamptz not null default now()
);
create index mfg_feedback_order on mfg_feedback(order_id, at);

-- Änderungsmanagement (PLM): Änderungsanträge mit betroffenen Teilen und Freigabe
create table plm_changes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  title text not null,
  reason text not null default '',
  description text not null default '',
  kind text not null default 'change' check (kind in ('change', 'deviation', 'new')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'rejected', 'implemented', 'cancelled')),
  project_id uuid references projects(id) on delete set null,
  items jsonb not null default '[]',
  impact jsonb not null default '{}',
  approvers jsonb not null default '[]',
  effective_date date,
  requested_by uuid references users(id) on delete set null,
  owner_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  implemented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plm_comments (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references plm_changes(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null,
  decision text check (decision in ('approve', 'reject')),
  created_at timestamptz not null default now()
);
