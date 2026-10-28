-- Rechnungen im CRM (Ausgangsrechnungen) mit E-Rechnung (ZUGFeRD/XRechnung) und Zahlungseingängen
alter table crm_accounts add column leitweg_id text not null default '',
  add column invoice_email text not null default '',
  add column e_invoice text check (e_invoice in ('zugferd', 'xrechnung', 'pdf')),
  add column datev_account integer unique;

create table crm_invoices (
  id uuid primary key default gen_random_uuid(),
  number text unique,                              -- erst beim Festschreiben vergeben (lückenlos)
  kind text not null default 'invoice' check (kind in ('invoice', 'partial', 'final', 'credit')),
  status text not null default 'draft' check (status in ('draft', 'open', 'partial', 'paid', 'cancelled')),
  account_id uuid not null references crm_accounts(id) on delete restrict,
  contact_id uuid references crm_contacts(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  quote_id uuid references crm_quotes(id) on delete set null,
  cancels_id uuid references crm_invoices(id) on delete restrict,
  title text not null default '',
  invoice_date date,
  service_from date,
  service_to date,
  due_date date,
  buyer_reference text not null default '',
  order_reference text not null default '',
  intro text not null default '',
  outro text not null default '',
  positions jsonb not null default '[]',
  vat_rate numeric(5,2) not null default 19,
  tax_mode text not null default 'standard' check (tax_mode in ('standard', 'reverse_charge', 'intra_eu', 'export', 'small_business')),
  payment_terms text not null default '',
  total_net numeric(14,2) not null default 0,
  total_tax numeric(14,2) not null default 0,
  total_gross numeric(14,2) not null default 0,
  prepaid numeric(14,2) not null default 0,       -- bei Schlussrechnungen: abgerechnete Abschläge (brutto)
  paid_amount numeric(14,2) not null default 0,
  format text not null default 'zugferd' check (format in ('zugferd', 'xrechnung', 'pdf')),
  pdf_path text,
  xml_path text,
  finalized_at timestamptz,
  finalized_by uuid references users(id) on delete set null,
  sent_at timestamptz,
  sent_to text,
  dunning_level integer not null default 0,
  last_dunning_at date,
  exported_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_invoices_account on crm_invoices(account_id);
create index crm_invoices_project on crm_invoices(project_id);
create index crm_invoices_status on crm_invoices(status, due_date);

-- Abschläge, die in einer Schlussrechnung abgezogen werden
create table crm_invoice_partials (
  final_id uuid not null references crm_invoices(id) on delete cascade,
  partial_id uuid not null references crm_invoices(id) on delete restrict,
  primary key (final_id, partial_id)
);

create table crm_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references crm_invoices(id) on delete cascade,
  date date not null,
  amount numeric(14,2) not null,
  method text not null default 'transfer',
  note text not null default '',
  bank_tx_id uuid,
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
