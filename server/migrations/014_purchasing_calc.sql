-- Version 1.2, Etappe 6 und 6b: Einkauf und Kalkulation

alter table projects add column budget numeric(14,2);

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  project_id uuid references projects(id) on delete set null,
  supplier_id uuid references crm_accounts(id) on delete set null,
  order_date date not null default current_date,
  note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table purchase_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source text not null default 'manual' check (source in ('cad', 'pcb', 'manual')),
  cad_item_id uuid references cad_items(id) on delete set null,
  revision_at_order integer,
  revision_warning boolean not null default false,
  number text not null default '',
  designation text not null,
  manufacturer text not null default '',
  manufacturer_no text not null default '',
  supplier_id uuid references crm_accounts(id) on delete set null,
  supplier_order_no text not null default '',
  qty numeric(14,3) not null default 1,
  unit text not null default 'Stk',
  unit_price numeric(14,4),
  discount numeric(5,2) not null default 0,
  cost_center text not null default '',
  note text not null default '',
  status text not null default 'open' check (status in ('open', 'requested', 'ordered', 'confirmed', 'partial', 'delivered', 'cancelled')),
  requested_at date,
  ordered_at date,
  planned_delivery date,
  confirmed_delivery date,
  delivered_qty numeric(14,3) not null default 0,
  delivered_at date,
  order_id uuid references purchase_orders(id) on delete set null,
  attachments jsonb not null default '[]',
  reminded_on date,
  sort double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index purchase_items_project on purchase_items(project_id, status);
create unique index purchase_items_cad on purchase_items(project_id, cad_item_id) where cad_item_id is not null and status <> 'cancelled';

create table purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references purchase_items(id) on delete cascade,
  qty numeric(14,3) not null,
  received_at date not null default current_date,
  note text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Kalkulationen: Sätze werden beim Anlegen festgeschrieben (rates), damit alte Kalkulationen stimmen
create table calculations (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  project_id uuid references projects(id) on delete cascade,
  title text not null,
  template text not null check (template in ('surcharge', 'plant', 'hourly', 'postcalc', 'travel')),
  status text not null default 'draft' check (status in ('draft', 'checked', 'released')),
  rates jsonb not null,
  data jsonb not null default '{}',
  result jsonb not null default '{}',
  base_calculation_id uuid references calculations(id) on delete set null,
  quote_id uuid references crm_quotes(id) on delete set null,
  note text not null default '',
  created_by uuid references users(id) on delete set null,
  checked_by uuid references users(id) on delete set null,
  checked_at timestamptz,
  released_by uuid references users(id) on delete set null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calculations_project on calculations(project_id);
alter table crm_quotes add constraint crm_quotes_calculation foreign key (calculation_id) references calculations(id) on delete set null;
