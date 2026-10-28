-- Etappe 11a (0.2.0): App-Store, Datenablage für Plugins, eigene Startseite

alter table users add column dashboard jsonb;
alter table users add column weather_location jsonb;

create table plugin_data (
  id uuid primary key default gen_random_uuid(),
  plugin text not null,
  collection text not null,
  scope text not null default 'shared' check (scope in ('shared', 'user')),
  owner_id uuid references users(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plugin_data_lookup on plugin_data (plugin, collection, scope, owner_id);
