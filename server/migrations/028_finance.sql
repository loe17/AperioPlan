-- Finanzbuchhaltung: Eingangsrechnungen, Bankkonten und Umsätze, Mahnungen, eigene Buchungen
alter table crm_accounts add column datev_creditor integer unique;

create table fin_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references crm_accounts(id) on delete set null,
  supplier_name text not null default '',
  supplier_vat_id text not null default '',
  number text not null default '',               -- Rechnungsnummer des Lieferanten
  bill_date date,
  due_date date,
  service_date date,
  lines jsonb not null default '[]',              -- [{text, account, net, rate, projectId, costCenter}]
  total_net numeric(14,2) not null default 0,
  total_tax numeric(14,2) not null default 0,
  total_gross numeric(14,2) not null default 0,
  paid_amount numeric(14,2) not null default 0,
  iban text not null default '',
  bic text not null default '',
  project_id uuid references projects(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'approval', 'approved', 'partial', 'paid', 'rejected')),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  file_path text,
  file_name text,
  e_invoice boolean not null default false,
  xml_path text,
  notes text not null default '',
  exported_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fin_bills_status on fin_bills(status, due_date);
create index fin_bills_supplier on fin_bills(supplier_id);

create table fin_bill_payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references fin_bills(id) on delete cascade,
  date date not null,
  amount numeric(14,2) not null,
  bank_tx_id uuid,
  note text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table fin_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  iban text not null default '',
  bic text not null default '',
  datev_account text not null default '1200',
  opening_balance numeric(14,2) not null default 0,
  opening_date date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table fin_bank_tx (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references fin_bank_accounts(id) on delete cascade,
  date date not null,
  value_date date,
  amount numeric(14,2) not null,
  counterparty text not null default '',
  counter_iban text not null default '',
  purpose text not null default '',
  reference text not null default '',
  import_hash text not null,
  status text not null default 'open' check (status in ('open', 'matched', 'booked', 'ignored')),
  matched_type text check (matched_type in ('invoice', 'bill')),
  matched_id uuid,
  booking_account text,                            -- bei eigener Buchung: Gegenkonto (z. B. 4970)
  booking_tax text,                                -- BU-Schlüssel
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (account_id, import_hash)
);
create index fin_bank_tx_status on fin_bank_tx(account_id, status, date);

create table fin_dunnings (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references crm_invoices(id) on delete cascade,
  level integer not null,
  date date not null default current_date,
  fee numeric(14,2) not null default 0,
  pdf_path text,
  sent_at timestamptz,
  sent_to text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
