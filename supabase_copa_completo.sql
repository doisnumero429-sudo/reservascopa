-- ============================================================================
-- ARAÇÁ GRILL · BANCO COMPLETO DE RESERVAS DA COPA
-- Evento: Escócia x Brasil · 24/06/2026 · 19h
-- Execute TODO este arquivo no SQL Editor do Supabase.
-- Pode ser executado novamente para atualizar tabelas, funções, índices e bucket.
-- ============================================================================

create extension if not exists pgcrypto;

-- 1) EVENTOS
create table if not exists public.copa_eventos (
  id text primary key,
  nome text not null,
  data_evento date not null,
  abre_as time not null,
  inicio_as time not null,
  valor_por_pagante_centavos integer not null check (valor_por_pagante_centavos > 0),
  minutos_bloqueio integer not null default 20 check (minutos_bloqueio between 5 and 120),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

insert into public.copa_eventos (
  id, nome, data_evento, abre_as, inicio_as,
  valor_por_pagante_centavos, minutos_bloqueio, ativo
) values (
  'escocia_brasil_2026_06_24',
  'Escócia x Brasil',
  '2026-06-24',
  '17:00',
  '19:00',
  5000,
  20,
  true
)
on conflict (id) do update set
  nome = excluded.nome,
  data_evento = excluded.data_evento,
  abre_as = excluded.abre_as,
  inicio_as = excluded.inicio_as,
  valor_por_pagante_centavos = excluded.valor_por_pagante_centavos,
  minutos_bloqueio = excluded.minutos_bloqueio,
  atualizado_em = now();

-- 2) CADASTRO DAS MESAS
create table if not exists public.copa_mesas (
  numero integer primary key check (numero between 1 and 67),
  setor text not null,
  capacidade integer not null default 4 check (capacidade > 0),
  reservavel_online boolean not null default true,
  ativo boolean not null default true
);

insert into public.copa_mesas (numero, setor, capacidade, reservavel_online, ativo)
select n,
       case when n between 1 and 49 then 'salão interno' else 'calçada / área externa' end,
       4,
       (n between 1 and 49),
       true
from generate_series(1, 67) as n
on conflict (numero) do update set
  setor = excluded.setor,
  capacidade = excluded.capacidade,
  reservavel_online = excluded.reservavel_online,
  ativo = excluded.ativo;

-- 3) RESERVAS
create table if not exists public.copa_reservas (
  id uuid primary key default gen_random_uuid(),
  evento text not null references public.copa_eventos(id),
  protocolo text not null unique,
  acesso_hash text not null,

  nome text not null,
  whatsapp text not null,
  whatsapp_digits text not null,
  pagantes integer not null check (pagantes between 2 and 40),
  criancas integer not null default 0 check (criancas between 0 and 20),
  total_pessoas integer not null check (total_pessoas between 2 and 60),
  valor_centavos integer not null check (valor_centavos >= 10000),
  observacao text,

  status text not null default 'aguardando_pagamento'
    check (status in (
      'aguardando_pagamento',
      'comprovante_enviado',
      'confirmada',
      'cancelada',
      'expirada'
    )),
  expira_em timestamptz,

  comprovante_path text,
  comprovante_nome text,
  comprovante_tipo text,
  comprovante_tamanho bigint,
  comprovante_enviado_em timestamptz,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  confirmado_em timestamptz,
  cancelado_em timestamptz,
  observacao_interna text
);

-- Caso uma versão antiga da tabela já exista, garante as novas colunas.
alter table public.copa_reservas add column if not exists acesso_hash text;
alter table public.copa_reservas add column if not exists whatsapp_digits text;
alter table public.copa_reservas add column if not exists comprovante_path text;
alter table public.copa_reservas add column if not exists comprovante_nome text;
alter table public.copa_reservas add column if not exists comprovante_tipo text;
alter table public.copa_reservas add column if not exists comprovante_tamanho bigint;
alter table public.copa_reservas add column if not exists comprovante_enviado_em timestamptz;
alter table public.copa_reservas add column if not exists atualizado_em timestamptz not null default now();
alter table public.copa_reservas add column if not exists cancelado_em timestamptz;
alter table public.copa_reservas add column if not exists observacao_interna text;

-- Histórico permanente das mesas escolhidas em cada reserva.
create table if not exists public.copa_reserva_mesas (
  reserva_id uuid not null references public.copa_reservas(id) on delete cascade,
  mesa integer not null references public.copa_mesas(numero),
  criado_em timestamptz not null default now(),
  primary key (reserva_id, mesa)
);

-- Somente esta tabela representa mesas atualmente indisponíveis.
-- Ao expirar ou cancelar, o bloqueio é apagado, mas o histórico da reserva permanece.
create table if not exists public.copa_mesas_bloqueios (
  evento text not null references public.copa_eventos(id),
  mesa integer not null references public.copa_mesas(numero),
  reserva_id uuid not null references public.copa_reservas(id) on delete cascade,
  criado_em timestamptz not null default now(),
  primary key (evento, mesa),
  unique (reserva_id, mesa)
);

create table if not exists public.copa_reserva_historico (
  id bigint generated always as identity primary key,
  reserva_id uuid not null references public.copa_reservas(id) on delete cascade,
  status_anterior text,
  status_novo text not null,
  origem text not null default 'sistema',
  observacao text,
  criado_em timestamptz not null default now()
);

create index if not exists copa_reservas_evento_status_idx
  on public.copa_reservas(evento, status, expira_em);
create index if not exists copa_reservas_data_idx
  on public.copa_reservas(criado_em desc);
create index if not exists copa_reservas_whatsapp_idx
  on public.copa_reservas(evento, whatsapp_digits);
create index if not exists copa_reserva_mesas_mesa_idx
  on public.copa_reserva_mesas(mesa);
create index if not exists copa_historico_reserva_idx
  on public.copa_reserva_historico(reserva_id, criado_em desc);

-- Impede mais de uma reserva ativa para o mesmo WhatsApp e evento.
create unique index if not exists copa_reserva_ativa_whatsapp_uq
  on public.copa_reservas(evento, whatsapp_digits)
  where status in ('aguardando_pagamento', 'comprovante_enviado', 'confirmada');

-- 4) ATUALIZAÇÃO AUTOMÁTICA DE atualizado_em
create or replace function public.copa_set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists copa_reservas_set_atualizado_em on public.copa_reservas;
create trigger copa_reservas_set_atualizado_em
before update on public.copa_reservas
for each row execute function public.copa_set_atualizado_em();

drop trigger if exists copa_eventos_set_atualizado_em on public.copa_eventos;
create trigger copa_eventos_set_atualizado_em
before update on public.copa_eventos
for each row execute function public.copa_set_atualizado_em();

-- 5) LIMPEZA DE BLOQUEIOS VENCIDOS
create or replace function public.copa_limpar_bloqueios_expirados_v2()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer := 0;
begin
  with expiradas as (
    update public.copa_reservas
       set status = 'expirada',
           atualizado_em = now()
     where status = 'aguardando_pagamento'
       and expira_em is not null
       and expira_em <= now()
    returning id
  ), removidos as (
    delete from public.copa_mesas_bloqueios b
    using expiradas e
    where b.reserva_id = e.id
    returning b.reserva_id
  )
  select count(*) into v_total from expiradas;

  insert into public.copa_reserva_historico(reserva_id, status_anterior, status_novo, origem, observacao)
  select id, 'aguardando_pagamento', 'expirada', 'sistema', 'Prazo de pagamento encerrado.'
  from public.copa_reservas
  where status = 'expirada'
    and atualizado_em >= now() - interval '5 seconds'
    and not exists (
      select 1 from public.copa_reserva_historico h
      where h.reserva_id = copa_reservas.id and h.status_novo = 'expirada'
    );

  return v_total;
end;
$$;

-- 6) LISTA PÚBLICA SEGURA: RETORNA SOMENTE NÚMEROS DAS MESAS OCUPADAS
create or replace function public.listar_mesas_ocupadas_copa_v2(
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns table (mesa integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.copa_limpar_bloqueios_expirados_v2();
  return query
    select b.mesa
      from public.copa_mesas_bloqueios b
     where b.evento = p_evento
     order by b.mesa;
end;
$$;

-- 7) CRIA A SOLICITAÇÃO E BLOQUEIA AS MESAS POR 20 MINUTOS
create or replace function public.criar_reserva_copa_v2(
  p_nome text,
  p_whatsapp text,
  p_pagantes integer,
  p_criancas integer,
  p_observacao text,
  p_mesas integer[],
  p_acesso_hash text,
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_protocolo text;
  v_expira timestamptz;
  v_mesa integer;
  v_mesas integer[];
  v_total integer;
  v_necessarias integer;
  v_valor_unitario integer;
  v_minutos integer;
  v_whatsapp_digits text;
begin
  perform pg_advisory_xact_lock(hashtext(p_evento));
  perform public.copa_limpar_bloqueios_expirados_v2();

  select valor_por_pagante_centavos, minutos_bloqueio
    into v_valor_unitario, v_minutos
    from public.copa_eventos
   where id = p_evento and ativo = true;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'EVENTO_INDISPONIVEL');
  end if;

  if nullif(trim(p_nome), '') is null or char_length(trim(p_nome)) > 120 then
    return jsonb_build_object('ok', false, 'erro', 'NOME_INVALIDO');
  end if;

  v_whatsapp_digits := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  if char_length(v_whatsapp_digits) not between 10 and 13 then
    return jsonb_build_object('ok', false, 'erro', 'WHATSAPP_INVALIDO');
  end if;

  if p_pagantes is null or p_pagantes not between 2 and 40 then
    return jsonb_build_object('ok', false, 'erro', 'PAGANTES_INVALIDO');
  end if;
  if p_criancas is null or p_criancas not between 0 and 20 then
    return jsonb_build_object('ok', false, 'erro', 'CRIANCAS_INVALIDO');
  end if;
  if char_length(coalesce(p_observacao, '')) > 600 then
    return jsonb_build_object('ok', false, 'erro', 'OBSERVACAO_MUITO_LONGA');
  end if;
  if p_acesso_hash is null or p_acesso_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'erro', 'ACESSO_INVALIDO');
  end if;

  if exists (
    select 1 from public.copa_reservas
     where evento = p_evento
       and whatsapp_digits = v_whatsapp_digits
       and status in ('aguardando_pagamento', 'comprovante_enviado', 'confirmada')
  ) then
    return jsonb_build_object('ok', false, 'erro', 'RESERVA_ATIVA_EXISTENTE');
  end if;

  v_total := p_pagantes + p_criancas;
  v_necessarias := ceil(v_total / 4.0)::integer;

  select array_agg(distinct x order by x)
    into v_mesas
    from unnest(coalesce(p_mesas, array[]::integer[])) as x;

  if v_mesas is null or cardinality(v_mesas) <> v_necessarias then
    return jsonb_build_object('ok', false, 'erro', 'QUANTIDADE_MESAS_INVALIDA');
  end if;

  if exists (
    select 1
      from unnest(v_mesas) x
      left join public.copa_mesas m on m.numero = x
     where m.numero is null
        or m.ativo = false
        or m.reservavel_online = false
  ) then
    return jsonb_build_object('ok', false, 'erro', 'MESA_INVALIDA');
  end if;

  if exists (
    select 1 from public.copa_mesas_bloqueios b
    where b.evento = p_evento and b.mesa = any(v_mesas)
  ) then
    return jsonb_build_object('ok', false, 'erro', 'MESA_INDISPONIVEL');
  end if;

  v_expira := now() + make_interval(mins => v_minutos);
  v_protocolo := 'COPA-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

  begin
    insert into public.copa_reservas (
      evento, protocolo, acesso_hash, nome, whatsapp, whatsapp_digits,
      pagantes, criancas, total_pessoas, valor_centavos, observacao,
      status, expira_em
    ) values (
      p_evento, v_protocolo, p_acesso_hash, trim(p_nome), trim(p_whatsapp), v_whatsapp_digits,
      p_pagantes, p_criancas, v_total, p_pagantes * v_valor_unitario,
      nullif(trim(coalesce(p_observacao, '')), ''),
      'aguardando_pagamento', v_expira
    ) returning id into v_id;

    foreach v_mesa in array v_mesas loop
      insert into public.copa_reserva_mesas(reserva_id, mesa)
      values (v_id, v_mesa);

      insert into public.copa_mesas_bloqueios(evento, mesa, reserva_id)
      values (p_evento, v_mesa, v_id);
    end loop;

    insert into public.copa_reserva_historico(
      reserva_id, status_anterior, status_novo, origem, observacao
    ) values (
      v_id, null, 'aguardando_pagamento', 'site', 'Mesas bloqueadas aguardando Pix e comprovante.'
    );
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'erro', 'MESA_INDISPONIVEL');
  end;

  return jsonb_build_object(
    'ok', true,
    'reserva_id', v_id,
    'protocolo', v_protocolo,
    'expira_em', v_expira,
    'mesas', v_mesas
  );
end;
$$;

-- 8) REGISTRA O COMPROVANTE ENVIADO PELO SITE
create or replace function public.registrar_comprovante_copa_v2(
  p_protocolo text,
  p_acesso_hash text,
  p_comprovante_path text,
  p_comprovante_nome text,
  p_comprovante_tipo text,
  p_comprovante_tamanho bigint,
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserva public.copa_reservas%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_evento || ':' || p_protocolo));
  perform public.copa_limpar_bloqueios_expirados_v2();

  select * into v_reserva
    from public.copa_reservas
   where evento = p_evento
     and protocolo = upper(trim(p_protocolo))
     and acesso_hash = p_acesso_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'RESERVA_NAO_ENCONTRADA');
  end if;

  if v_reserva.status = 'comprovante_enviado' then
    return jsonb_build_object('ok', true, 'ja_registrado', true, 'comprovante_enviado_em', v_reserva.comprovante_enviado_em);
  end if;

  if v_reserva.status <> 'aguardando_pagamento' then
    return jsonb_build_object('ok', false, 'erro', 'STATUS_INVALIDO');
  end if;

  if v_reserva.expira_em is null or v_reserva.expira_em <= now() then
    update public.copa_reservas set status = 'expirada' where id = v_reserva.id;
    delete from public.copa_mesas_bloqueios where reserva_id = v_reserva.id;
    return jsonb_build_object('ok', false, 'erro', 'PRAZO_EXPIRADO');
  end if;

  if p_comprovante_path is null
     or p_comprovante_path not like (p_evento || '/' || v_reserva.protocolo || '/%') then
    return jsonb_build_object('ok', false, 'erro', 'ARQUIVO_INVALIDO');
  end if;

  if p_comprovante_tipo not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or p_comprovante_tamanho is null
     or p_comprovante_tamanho <= 0
     or p_comprovante_tamanho > 5242880 then
    return jsonb_build_object('ok', false, 'erro', 'ARQUIVO_INVALIDO');
  end if;

  update public.copa_reservas
     set status = 'comprovante_enviado',
         expira_em = null,
         comprovante_path = p_comprovante_path,
         comprovante_nome = left(coalesce(p_comprovante_nome, 'comprovante'), 180),
         comprovante_tipo = p_comprovante_tipo,
         comprovante_tamanho = p_comprovante_tamanho,
         comprovante_enviado_em = now()
   where id = v_reserva.id;

  insert into public.copa_reserva_historico(
    reserva_id, status_anterior, status_novo, origem, observacao
  ) values (
    v_reserva.id,
    'aguardando_pagamento',
    'comprovante_enviado',
    'site',
    'Comprovante registrado no armazenamento privado.'
  );

  return jsonb_build_object('ok', true, 'comprovante_enviado_em', now());
end;
$$;

-- 9) CANCELAMENTO PELO CLIENTE: SOMENTE ANTES DO COMPROVANTE
create or replace function public.cancelar_reserva_copa_cliente_v2(
  p_protocolo text,
  p_acesso_hash text,
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtext(p_evento || ':' || p_protocolo));
  perform public.copa_limpar_bloqueios_expirados_v2();

  select id, status into v_id, v_status
    from public.copa_reservas
   where evento = p_evento
     and protocolo = upper(trim(p_protocolo))
     and acesso_hash = p_acesso_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'RESERVA_NAO_ENCONTRADA');
  end if;
  if v_status <> 'aguardando_pagamento' then
    return jsonb_build_object('ok', false, 'erro', 'NAO_PODE_CANCELAR');
  end if;

  update public.copa_reservas
     set status = 'cancelada', cancelado_em = now(), expira_em = null
   where id = v_id;
  delete from public.copa_mesas_bloqueios where reserva_id = v_id;

  insert into public.copa_reserva_historico(
    reserva_id, status_anterior, status_novo, origem, observacao
  ) values (
    v_id, 'aguardando_pagamento', 'cancelada', 'cliente', 'Cancelada no site antes do envio do comprovante.'
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- 10) FUNÇÕES PARA A FUTURA PÁGINA ADMINISTRATIVA
create or replace function public.confirmar_reserva_copa_admin(
  p_protocolo text,
  p_observacao text default null,
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
begin
  select id, status into v_id, v_status
    from public.copa_reservas
   where evento = p_evento and protocolo = upper(trim(p_protocolo))
   for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'RESERVA_NAO_ENCONTRADA'); end if;
  if v_status not in ('comprovante_enviado', 'aguardando_pagamento') then
    return jsonb_build_object('ok', false, 'erro', 'STATUS_INVALIDO');
  end if;

  update public.copa_reservas
     set status = 'confirmada', confirmado_em = now(), expira_em = null,
         observacao_interna = nullif(trim(coalesce(p_observacao, '')), '')
   where id = v_id;

  insert into public.copa_reserva_historico(reserva_id, status_anterior, status_novo, origem, observacao)
  values (v_id, v_status, 'confirmada', 'atendente', p_observacao);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.cancelar_reserva_copa_admin(
  p_protocolo text,
  p_observacao text default null,
  p_evento text default 'escocia_brasil_2026_06_24'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
begin
  select id, status into v_id, v_status
    from public.copa_reservas
   where evento = p_evento and protocolo = upper(trim(p_protocolo))
   for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'RESERVA_NAO_ENCONTRADA'); end if;
  if v_status in ('cancelada', 'expirada') then return jsonb_build_object('ok', true); end if;

  update public.copa_reservas
     set status = 'cancelada', cancelado_em = now(), expira_em = null,
         observacao_interna = nullif(trim(coalesce(p_observacao, '')), '')
   where id = v_id;
  delete from public.copa_mesas_bloqueios where reserva_id = v_id;

  insert into public.copa_reserva_historico(reserva_id, status_anterior, status_novo, origem, observacao)
  values (v_id, v_status, 'cancelada', 'atendente', p_observacao);
  return jsonb_build_object('ok', true);
end;
$$;

-- View pronta para a futura página de consulta e impressão.
create or replace view public.copa_reservas_admin as
select
  r.id,
  r.evento,
  e.nome as evento_nome,
  e.data_evento,
  r.protocolo,
  r.nome,
  r.whatsapp,
  r.pagantes,
  r.criancas,
  r.total_pessoas,
  r.valor_centavos,
  r.observacao,
  r.status,
  r.expira_em,
  r.comprovante_path,
  r.comprovante_nome,
  r.comprovante_tipo,
  r.comprovante_tamanho,
  r.comprovante_enviado_em,
  r.criado_em,
  r.confirmado_em,
  r.cancelado_em,
  r.observacao_interna,
  coalesce(array_agg(m.mesa order by m.mesa) filter (where m.mesa is not null), array[]::integer[]) as mesas
from public.copa_reservas r
join public.copa_eventos e on e.id = r.evento
left join public.copa_reserva_mesas m on m.reserva_id = r.id
group by r.id, e.nome, e.data_evento;

-- 11) STORAGE PRIVADO DOS COMPROVANTES
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'copa-comprovantes',
  'copa-comprovantes',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = excluded.allowed_mime_types;

-- 12) SEGURANÇA: NENHUMA TABELA OU FUNÇÃO FICA ABERTA AO NAVEGADOR
alter table public.copa_eventos enable row level security;
alter table public.copa_mesas enable row level security;
alter table public.copa_reservas enable row level security;
alter table public.copa_reserva_mesas enable row level security;
alter table public.copa_mesas_bloqueios enable row level security;
alter table public.copa_reserva_historico enable row level security;

revoke all on public.copa_eventos from anon, authenticated;
revoke all on public.copa_mesas from anon, authenticated;
revoke all on public.copa_reservas from anon, authenticated;
revoke all on public.copa_reserva_mesas from anon, authenticated;
revoke all on public.copa_mesas_bloqueios from anon, authenticated;
revoke all on public.copa_reserva_historico from anon, authenticated;
revoke all on public.copa_reservas_admin from anon, authenticated;

revoke all on function public.copa_limpar_bloqueios_expirados_v2() from public;
revoke all on function public.listar_mesas_ocupadas_copa_v2(text) from public;
revoke all on function public.criar_reserva_copa_v2(text,text,integer,integer,text,integer[],text,text) from public;
revoke all on function public.registrar_comprovante_copa_v2(text,text,text,text,text,bigint,text) from public;
revoke all on function public.cancelar_reserva_copa_cliente_v2(text,text,text) from public;
revoke all on function public.confirmar_reserva_copa_admin(text,text,text) from public;
revoke all on function public.cancelar_reserva_copa_admin(text,text,text) from public;

-- A API da Vercel usa exclusivamente a service_role. Ela recebe somente os acessos
-- necessários às funções e à view administrativa.
grant execute on function public.copa_limpar_bloqueios_expirados_v2() to service_role;
grant execute on function public.listar_mesas_ocupadas_copa_v2(text) to service_role;
grant execute on function public.criar_reserva_copa_v2(text,text,integer,integer,text,integer[],text,text) to service_role;
grant execute on function public.registrar_comprovante_copa_v2(text,text,text,text,text,bigint,text) to service_role;
grant execute on function public.cancelar_reserva_copa_cliente_v2(text,text,text) to service_role;
grant execute on function public.confirmar_reserva_copa_admin(text,text,text) to service_role;
grant execute on function public.cancelar_reserva_copa_admin(text,text,text) to service_role;
grant select on public.copa_reservas_admin to service_role;

-- A service_role usada apenas nas funções da Vercel ignora RLS e continuará funcionando.
-- Não crie políticas públicas para nomes, telefones ou comprovantes.

-- CONSULTAS ÚTEIS PARA TESTE NO SQL EDITOR:
-- select * from public.copa_reservas_admin order by criado_em desc;
-- select * from public.listar_mesas_ocupadas_copa_v2('escocia_brasil_2026_06_24');
-- select public.confirmar_reserva_copa_admin('COPA-XXXXXX-XXXXX', 'Pix conferido');
-- select public.cancelar_reserva_copa_admin('COPA-XXXXXX-XXXXX', 'Pagamento não localizado');
