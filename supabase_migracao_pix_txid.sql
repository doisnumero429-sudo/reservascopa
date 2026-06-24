-- ============================================================================
-- MIGRAÇÃO: Adiciona colunas de TXID e Pix Copia e Cola na tabela de reservas
-- Execute este script no SQL Editor do Supabase antes do deploy do novo código.
-- É idempotente: pode ser executado novamente sem erro.
-- ============================================================================

-- Novas colunas para rastreamento do Pix por reserva
alter table public.copa_reservas
  add column if not exists txid            text,
  add column if not exists pix_copia_e_cola text,
  add column if not exists pix_gerado_em   timestamptz;

-- Índice único para evitar colisão de TXIDs entre reservas ativas
create unique index if not exists copa_reservas_txid_uq
  on public.copa_reservas(txid)
  where txid is not null;

-- Comentário descritivo nas colunas
comment on column public.copa_reservas.txid is
  'Identificador único da transação Pix gerado pelo backend (ex: RESA7X2P8K). '
  'Inserido no campo 62.05 do BRCode. Nunca exposto ao navegador diretamente.';

comment on column public.copa_reservas.pix_copia_e_cola is
  'Código Pix Copia e Cola (BRCode EMV) completo com CRC16, gerado no backend. '
  'Contém valor, recebedor e TXID. A chave Pix raw nunca é armazenada aqui.';

comment on column public.copa_reservas.pix_gerado_em is
  'Data e hora da geração do Pix Copia e Cola para esta reserva.';
