-- Mindmaps nach dem Vorbild von FreeMind: Schrift, Farben, Formen, Symbole, Wolken, Pfeile, Attribute,
-- Zeitstempel und Erinnerungen je Knoten. Liegen in einer eigenen Spalte neben den Daten, damit ältere
-- Versionen beim Speichern nichts davon verlieren (sie kennen die Spalte nicht). Nur neue Spalten.
alter table mindmaps add column node_props jsonb not null default '{}'::jsonb;
alter table mindmaps add column next_reminder timestamptz;
alter table mindmaps add column reminders_sent jsonb not null default '{}'::jsonb;
create index mindmaps_next_reminder on mindmaps(next_reminder) where next_reminder is not null;
