-- Freigaben von Formularen erhalten einen eigenen Schlüssel, damit sie gesichert und wiederhergestellt werden können
alter table form_shares add column id uuid primary key default gen_random_uuid();
