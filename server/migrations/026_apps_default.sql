-- Ab 0.2.0 sind bei einer neuen Installation nur Chat und E-Mail eingeschaltet.
-- Bestehende Installationen (mit Benutzern oder Projekten) behalten alle bisher festen Werkzeuge.
insert into settings (key, value)
select 'apps', '{"installed": ["chat", "mail", "calendar", "notes", "kvp", "crm", "calculation", "purchasing", "resources", "cad", "pcb", "time", "absences", "ai"]}'::jsonb
where not exists (select 1 from settings where key = 'apps')
  and (exists (select 1 from projects) or (select count(*) from users) > 1);
