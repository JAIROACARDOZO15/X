-- UAN V24: auditoría centralizada de cambios de notas
create table if not exists public.auditoria_notas (
  id text primary key,
  fecha timestamptz not null default now(),
  grupo_id text,
  codigo text,
  materia text,
  programa text,
  grupo text,
  item_id text,
  item_nombre text,
  anterior numeric,
  nuevo numeric,
  actor text,
  rol text
);
create index if not exists idx_auditoria_notas_fecha on public.auditoria_notas(fecha desc);
create index if not exists idx_auditoria_notas_codigo on public.auditoria_notas(codigo);
create index if not exists idx_auditoria_notas_grupo on public.auditoria_notas(grupo_id);
-- Si tu proyecto usa RLS, crea políticas según tus roles institucionales.
