-- ============================================================================
-- MIGRAÇÃO: Tabela copa_chat_contexto — contexto extra da IA
-- Execute no SQL Editor do Supabase. É idempotente (re-executável sem erro).
-- ============================================================================

create table if not exists public.copa_chat_contexto (
  id          int primary key default 1 check (id = 1),
  conteudo    text not null default '',
  atualizado_em  timestamptz default now(),
  atualizado_por text not null default ''
);

-- Apenas service_role acessa (bypassa RLS automaticamente)
alter table public.copa_chat_contexto enable row level security;

-- Linha inicial (tabela de linha única)
insert into public.copa_chat_contexto (id, conteudo, atualizado_por)
values (1, '', 'sistema')
on conflict (id) do nothing;

comment on table public.copa_chat_contexto is
  'Contexto extra injetado no system prompt da IA pelo administrador. Tabela de linha única (id=1).';
comment on column public.copa_chat_contexto.conteudo is
  'Texto livre com informações adicionais para o chatbot. Max 8000 chars.';
