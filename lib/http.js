// Helpers HTTP compartilhados pelas funções da Vercel.
// Sem segredos. Respostas sempre em JSON, sem stack trace em produção.

const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// CORS mínimo e preflight. As chamadas reais são same-origin; isto cobre OPTIONS.
export function applyCommonHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    applyCommonHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

// Bloqueia somente requisições POST claramente cross-site. Same-origin sempre passa
// (Origin/Referer host === host do deploy). Domínios *.vercel.app são aceitos.
export function isAllowedOrigin(req) {
  if (req.method === "GET" || req.method === "OPTIONS") return true;
  const host = (req.headers.host || "").toLowerCase();
  const ref = req.headers.origin || req.headers.referer || "";
  if (!ref) return true; // alguns clientes não enviam Origin em same-origin
  let refHost;
  try {
    refHost = new URL(ref).host.toLowerCase();
  } catch {
    return true;
  }
  if (refHost === host) return true;
  if (refHost.endsWith(".vercel.app")) return true;
  const allow = (process.env.ALLOWED_ORIGIN || "").toLowerCase();
  if (allow) {
    try {
      if (new URL(allow).host.toLowerCase() === refHost) return true;
    } catch {
      if (allow === refHost) return true;
    }
  }
  return false;
}

// Lê o corpo JSON com limite de tamanho. Devolve {} se vazio e null se JSON inválido.
export async function readJsonBody(req, maxBytes = 100 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        return null;
      }
    }
    if (typeof req.body === "object") return req.body;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("BODY_TOO_LARGE");
      chunks.push(chunk);
    }
  } catch (e) {
    if (e.message === "BODY_TOO_LARGE") return "TOO_LARGE";
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Rate limit best-effort, em memória por instância. Não substitui WAF, mas freia abuso.
const buckets = new Map();
export function rateLimit(req, { max = 30, windowMs = 60000 } = {}) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now > entry.reset) {
    buckets.set(ip, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  if (buckets.size > 5000) buckets.clear(); // proteção simples de memória
  return entry.count <= max;
}

export function clientError(res, message, status = 400, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

export function serverError(res, err) {
  if (!IS_PROD) console.error(err);
  sendJson(res, 500, {
    ok: false,
    error: "Erro interno. Tente novamente em instantes.",
  });
}
