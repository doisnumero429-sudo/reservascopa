// Conexão privada com o Supabase usando exclusivamente a service_role.
// A service_role NUNCA é enviada ao navegador. Só existe nas funções da Vercel.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export const EVENTO_ID = "escocia_brasil_2026_06_24";
export const BUCKET = "copa-comprovantes";
export const VALOR_POR_PAGANTE_CENTAVOS = 5000;
export const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

let cached = null;

export function getServiceClient() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error("SUPABASE_CONFIG_MISSING");
    err.public = "Sistema de mesas indisponível no momento.";
    throw err;
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function getPublishableKey() {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  );
}

// Token público de retomada (vai ao navegador/localStorage) e seu hash (vai ao banco).
export function newAccessToken() {
  return crypto.randomBytes(32).toString("hex");
}
export function hashAccessToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
export function isValidAccessToken(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}

export function mimeToExt(mime) {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}

// Monta o objeto de reserva no formato que o frontend (index.html) espera.
export function toReservationDTO(row, accessToken) {
  const tables = Array.isArray(row.copa_reserva_mesas)
    ? row.copa_reserva_mesas.map((m) => Number(m.mesa)).sort((a, b) => a - b)
    : Array.isArray(row.mesas)
      ? row.mesas.map(Number)
      : [];
  return {
    protocol: row.protocolo,
    accessToken,
    name: row.nome,
    whatsapp: row.whatsapp,
    payers: Number(row.pagantes),
    children: Number(row.criancas),
    totalPeople: Number(row.total_pessoas),
    observation: row.observacao || "",
    tables,
    status: row.status,
    amountCents: Number(row.valor_centavos),
    expiresAt: row.expira_em,
    proofSubmittedAt: row.comprovante_enviado_em || null,
  };
}

// Mensagens humanas para os códigos de erro vindos das RPCs.
export const ERROS_PT = {
  EVENTO_INDISPONIVEL: "O evento não está disponível para reservas.",
  NOME_INVALIDO: "Informe um nome válido.",
  WHATSAPP_INVALIDO: "Informe um WhatsApp válido com DDD.",
  PAGANTES_INVALIDO: "É necessário no mínimo 2 pessoas pagantes.",
  CRIANCAS_INVALIDO: "Quantidade de crianças inválida.",
  OBSERVACAO_MUITO_LONGA: "A observação é muito longa.",
  ACESSO_INVALIDO: "Sessão inválida. Recarregue a página e tente novamente.",
  RESERVA_ATIVA_EXISTENTE:
    "Já existe uma solicitação ativa para este WhatsApp. Conclua ou cancele a anterior.",
  QUANTIDADE_MESAS_INVALIDA:
    "A quantidade de mesas não corresponde ao tamanho do grupo.",
  MESA_INVALIDA: "Uma das mesas não pode ser reservada online.",
  MESA_INDISPONIVEL:
    "Uma das mesas acabou de ficar indisponível. Escolha outra opção.",
  RESERVA_NAO_ENCONTRADA: "Solicitação não encontrada.",
  STATUS_INVALIDO: "Esta solicitação não pode mais ser alterada.",
  PRAZO_EXPIRADO: "O prazo da solicitação expirou. Faça uma nova reserva.",
  ARQUIVO_INVALIDO: "Arquivo inválido. Envie JPG, PNG, WEBP ou PDF até 5 MB.",
  NAO_PODE_CANCELAR: "Esta solicitação não pode ser cancelada.",
};
export function erroPt(code, fallback = "Não foi possível concluir.") {
  return ERROS_PT[code] || fallback;
}
