// /api/proof
//  POST { action:"prepare", protocol, accessToken, filename, mimeType, size }
//        -> { ok, bucket, path, token }   (URL de upload assinada gerada pelo servidor)
//  POST { action:"confirm", protocol, accessToken, path, filename, mimeType, size }
//        -> { ok, proofSubmittedAt }      (confirma que o arquivo existe e muda o status)

import {
  sendJson,
  applyCommonHeaders,
  handlePreflight,
  isAllowedOrigin,
  readJsonBody,
  rateLimit,
  clientError,
  serverError,
} from "../lib/http.js";
import {
  getServiceClient,
  EVENTO_ID,
  BUCKET,
  ALLOWED_MIME,
  MAX_PROOF_BYTES,
  hashAccessToken,
  isValidAccessToken,
  mimeToExt,
  erroPt,
} from "../lib/supabase.js";

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST")
    return clientError(res, "Método não permitido.", 405);
  if (!isAllowedOrigin(req))
    return clientError(res, "Origem não autorizada.", 403);
  if (!rateLimit(req, { max: 30, windowMs: 60000 }))
    return clientError(res, "Muitas tentativas. Aguarde um momento.", 429);

  try {
    const body = await readJsonBody(req);
    if (body === "TOO_LARGE")
      return clientError(res, "Requisição muito grande.", 413);
    if (body === null) return clientError(res, "JSON inválido.", 400);

    if (!body.protocol || !isValidAccessToken(body.accessToken))
      return clientError(res, erroPt("ACESSO_INVALIDO"), 400);

    if (body.action === "prepare") return await handlePrepare(req, res, body);
    if (body.action === "confirm") return await handleConfirm(req, res, body);
    return clientError(res, "Ação inválida.", 400);
  } catch (err) {
    if (err.public) return sendJson(res, 503, { ok: false, error: err.public });
    return serverError(res, err);
  }
}

function validateFileMeta(body) {
  if (!ALLOWED_MIME.includes(body.mimeType)) return "ARQUIVO_INVALIDO";
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PROOF_BYTES)
    return "ARQUIVO_INVALIDO";
  return null;
}

// Confere se a solicitação pertence ao cliente e ainda está válida.
async function loadOwnedReservation(supa, body) {
  const { data, error } = await supa
    .from("copa_reservas")
    .select("id,protocolo,status,expira_em,acesso_hash")
    .eq("evento", EVENTO_ID)
    .eq("protocolo", String(body.protocol).toUpperCase().trim())
    .eq("acesso_hash", hashAccessToken(body.accessToken))
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function handlePrepare(req, res, body) {
  const supa = getServiceClient();
  const metaErr = validateFileMeta(body);
  if (metaErr) return clientError(res, erroPt(metaErr), 400);

  await supa.rpc("copa_limpar_bloqueios_expirados_v2");
  const r = await loadOwnedReservation(supa, body);
  if (!r) return clientError(res, erroPt("RESERVA_NAO_ENCONTRADA"), 404);
  if (r.status === "comprovante_enviado" || r.status === "confirmada")
    return clientError(res, "O comprovante já foi enviado.", 409);
  if (r.status !== "aguardando_pagamento")
    return clientError(res, erroPt("STATUS_INVALIDO"), 409);
  if (!r.expira_em || new Date(r.expira_em).getTime() <= Date.now())
    return clientError(res, erroPt("PRAZO_EXPIRADO"), 409);

  // Caminho sempre gerado pelo servidor: evento/protocolo/arquivo.ext
  const ext = mimeToExt(body.mimeType);
  const path = `${EVENTO_ID}/${r.protocolo}/comprovante-${Date.now()}.${ext}`;

  const { data, error } = await supa.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw error;

  return sendJson(res, 200, {
    ok: true,
    bucket: BUCKET,
    path: data.path || path,
    token: data.token,
  });
}

async function handleConfirm(req, res, body) {
  const supa = getServiceClient();
  const metaErr = validateFileMeta(body);
  if (metaErr) return clientError(res, erroPt(metaErr), 400);

  const r = await loadOwnedReservation(supa, body);
  if (!r) return clientError(res, erroPt("RESERVA_NAO_ENCONTRADA"), 404);

  // O caminho precisa pertencer a esta reserva (mesmo padrão exigido pela RPC).
  const prefix = `${EVENTO_ID}/${r.protocolo}/`;
  if (typeof body.path !== "string" || !body.path.startsWith(prefix))
    return clientError(res, erroPt("ARQUIVO_INVALIDO"), 400);

  // Confirma que o arquivo realmente existe no bucket privado antes de mudar o status.
  const exists = await fileExists(supa, body.path);
  if (!exists)
    return clientError(
      res,
      "O arquivo não foi encontrado no armazenamento. Tente enviar novamente.",
      409,
    );

  const { data, error } = await supa.rpc("registrar_comprovante_copa_v2", {
    p_protocolo: r.protocolo,
    p_acesso_hash: hashAccessToken(body.accessToken),
    p_comprovante_path: body.path,
    p_comprovante_nome: String(body.filename || "comprovante").slice(0, 180),
    p_comprovante_tipo: body.mimeType,
    p_comprovante_tamanho: Number(body.size),
    p_evento: EVENTO_ID,
  });
  if (error) throw error;
  if (!data || data.ok !== true) {
    const code = data?.erro || "DESCONHECIDO";
    const status = code === "PRAZO_EXPIRADO" ? 409 : 400;
    return sendJson(res, status, { ok: false, error: erroPt(code), code });
  }

  return sendJson(res, 200, {
    ok: true,
    proofSubmittedAt: data.comprovante_enviado_em || new Date().toISOString(),
  });
}

async function fileExists(supa, path) {
  // createSignedUrl falha se o objeto não existir — serve como prova de existência.
  const { data, error } = await supa.storage
    .from(BUCKET)
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return false;
  return true;
}
