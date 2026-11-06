-- Projekt-Reiter für Apps aus dem App-Store (Einkauf, Verkauf, Material, Service …).
-- projects.modules bleibt für ältere Versionen erhalten und enthält nur die alten Bereiche;
-- projects.tabs ist die vollständige, sortierte Liste. Mindmaps und Rechnungen waren bisher immer sichtbar
-- und werden deshalb in bestehenden Projekten als Reiter „mindmaps“ und „sales“ übernommen.
alter table projects add column tabs jsonb;
update projects set tabs = modules || '["sales", "mindmaps"]'::jsonb;

-- Lagerbestellungen ohne Projekt (Nachschub für das Lager)
alter table purchase_items alter column project_id drop not null;
alter table purchase_items add column location_id uuid references wh_locations(id) on delete set null;

-- Wareneingang: Lieferschein, Lagerort, Charge/Seriennummer und Verknüpfung zur Lagerbuchung
alter table purchase_receipts add column delivery_note text not null default '';
alter table purchase_receipts add column location_id uuid references wh_locations(id) on delete set null;
alter table purchase_receipts add column lot text not null default '';
alter table purchase_receipts add column target text not null default 'none' check (target in ('none', 'stock', 'project'));
alter table purchase_receipts add column wh_move_id uuid references wh_moves(id) on delete set null;
create index purchase_items_article on purchase_items(wh_article_id) where wh_article_id is not null;
create index wh_moves_purchase on wh_moves(purchase_item_id) where purchase_item_id is not null;

-- Vorgabe für neue Projekte aus der bisherigen Einstellung übernehmen (plus Verkauf und Einkauf)
insert into settings (key, value) select 'defaultProjectTabs',
    value || (case when value ? 'sales' then '[]' else '["sales"]' end)::jsonb || (case when value ? 'purchasing' then '[]' else '["purchasing"]' end)::jsonb
  from settings where key = 'defaultModules'
  on conflict (key) do nothing;
