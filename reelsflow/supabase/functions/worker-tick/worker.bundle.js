// GERADO por apps/worker/scripts/build-edge.mjs — não editar.


// ../../packages/connectors/src/types.ts
var ConnectorError = class extends Error {
  errorClass;
  code;
  retryAfterSeconds;
  /** true se a falha ocorreu depois de um efeito externo ter começado (pode ter publicado). */
  sideEffectStarted;
  constructor(errorClass, message, opts = {}) {
    super(message);
    this.name = "ConnectorError";
    this.errorClass = errorClass;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.sideEffectStarted = opts.sideEffectStarted ?? false;
  }
};
function toConnectorError(err, sideEffectStarted) {
  if (err instanceof ConnectorError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
  return new ConnectorError(isTimeout ? "timeout" : "unknown", msg, { sideEffectStarted });
}

// ../../packages/connectors/src/mock.ts
var MOCK_BEHAVIORS = [
  "success",
  "slow",
  "flaky",
  "transient",
  "permanent",
  "timeout_before",
  "timeout_after",
  "rate_limit",
  "auth_revoked",
  "uncertain"
];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var MockConnector = class {
  constructor(store, delayMs = 0) {
    this.store = store;
    this.delayMs = delayMs;
  }
  store;
  delayMs;
  platform = "mock";
  behavior(input) {
    const b = input.settings.mock_behavior;
    return MOCK_BEHAVIORS.includes(b) ? b : "success";
  }
  async publish(input, io) {
    const behavior = this.behavior(input.account);
    if (behavior === "auth_revoked") throw new ConnectorError("auth", "Token revogado pelo usu\xE1rio na plataforma.", { code: "token_revoked" });
    if (behavior === "permanent") throw new ConnectorError("permanent", "M\xEDdia rejeitada pela plataforma.", { code: "media_rejected" });
    if (behavior === "transient") throw new ConnectorError("transient", "Servi\xE7o indispon\xEDvel (503).", { code: "http_503" });
    if (behavior === "timeout_before") throw new ConnectorError("timeout", "Tempo esgotado ao conectar.", { sideEffectStarted: false });
    if (behavior === "flaky" && input.attemptNo === 1) throw new ConnectorError("transient", "Falha tempor\xE1ria simulada.", { code: "http_502" });
    if (behavior === "rate_limit" && input.attemptNo === 1) {
      throw new ConnectorError("rate_limited", "Limite de requisi\xE7\xF5es atingido.", { code: "rate_limit", retryAfterSeconds: 120 });
    }
    let uploadRef = typeof input.checkpoint?.upload_ref === "string" ? input.checkpoint.upload_ref : null;
    if (!uploadRef) {
      uploadRef = `${input.jobId}:${input.attemptNo}`;
      await io.save("uploading", { upload_ref: uploadRef });
      await this.store.createUpload(input.account.id, uploadRef, input.caption);
    }
    await io.save("processing_remote", { upload_ref: uploadRef });
    if (behavior === "slow") await sleep(this.delayMs || 50);
    if (behavior === "uncertain") throw new ConnectorError("unknown", "Resposta ileg\xEDvel da plataforma.", { sideEffectStarted: true });
    await io.save("publishing", { upload_ref: uploadRef });
    await this.store.publish(uploadRef);
    if (behavior === "timeout_after") throw new ConnectorError("timeout", "Tempo esgotado aguardando resposta.", { sideEffectStarted: true });
    const found = await this.store.find(uploadRef);
    return { externalId: found.id, permalink: `https://mock.reelsflow.invalid/p/${found.id}` };
  }
  async getStatus(account, checkpoint) {
    if (this.behavior(account) === "uncertain") return { state: "unknown" };
    const ref = typeof checkpoint.upload_ref === "string" ? checkpoint.upload_ref : null;
    if (!ref) return { state: "not_found" };
    const found = await this.store.find(ref);
    if (!found) return { state: "not_found" };
    if (found.status === "processing") return { state: "processing" };
    return { state: "published", externalId: found.id, permalink: `https://mock.reelsflow.invalid/p/${found.id}` };
  }
};

// ../../packages/connectors/src/registry.ts
var ConnectorRegistry = class {
  map = /* @__PURE__ */ new Map();
  register(c) {
    this.map.set(c.platform, c);
    return this;
  }
  get(key) {
    const c = this.map.get(key);
    if (!c) throw new ConnectorError("permanent", `Conector ${key} indispon\xEDvel.`, { code: "connector_unavailable" });
    return c;
  }
  /** Conta conectada por um provedor intermediário (provider = "zernio") usa o conector dele. */
  forAccount(account) {
    if (account.provider === "zernio" && !this.map.has("zernio")) {
      throw new ConnectorError("transient", "Integra\xE7\xE3o com a Zernio n\xE3o configurada no worker (ZERNIO_API_KEY).", {
        code: "zernio_not_configured",
        retryAfterSeconds: 900
      });
    }
    return this.get(account.provider === "zernio" ? "zernio" : account.platform);
  }
};

// ../../packages/connectors/src/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
var TokenCipher = class _TokenCipher {
  constructor(keys, current) {
    this.current = current;
    for (const [v, k] of Object.entries(keys)) {
      const buf = Buffer.from(k, "base64");
      if (buf.length !== 32) throw new Error(`Chave de criptografia vers\xE3o ${v} deve ter 32 bytes (base64).`);
      this.keys.set(Number(v), buf);
    }
    if (!this.keys.has(current)) throw new Error(`Chave de criptografia atual (vers\xE3o ${current}) ausente.`);
  }
  current;
  keys = /* @__PURE__ */ new Map();
  static fromEnv(env = process.env) {
    if (env.TOKEN_ENCRYPTION_KEYS) {
      const keys = JSON.parse(env.TOKEN_ENCRYPTION_KEYS);
      const current = Number(env.TOKEN_ENCRYPTION_KEY_VERSION ?? Math.max(...Object.keys(keys).map(Number)));
      return new _TokenCipher(Object.fromEntries(Object.entries(keys).map(([k, v]) => [Number(k), v])), current);
    }
    if (env.TOKEN_ENCRYPTION_KEY) return new _TokenCipher({ 1: env.TOKEN_ENCRYPTION_KEY }, 1);
    throw new Error("TOKEN_ENCRYPTION_KEY n\xE3o configurada.");
  }
  /** `aad` amarra a cifra a um contexto (ex.: id da conta): a cifra não pode ser movida para outra linha. */
  seal(plaintext, aad) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keys.get(this.current), iv);
    c.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), keyVersion: this.current };
  }
  open(s, aad) {
    const key = this.keys.get(s.keyVersion);
    if (!key) throw new Error(`Chave de criptografia vers\xE3o ${s.keyVersion} indispon\xEDvel.`);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ciphertext, "base64")), d.final()]).toString("utf8");
  }
};

// ../../packages/connectors/src/meta/graph.ts
var DEFAULT_GRAPH_VERSION = "v27.0";
var MetaApiError = class extends Error {
  constructor(message, httpStatus, body, retryAfterSeconds) {
    super(message);
    this.httpStatus = httpStatus;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "MetaApiError";
  }
  httpStatus;
  body;
  retryAfterSeconds;
};
var RATE_LIMIT_CODES = /* @__PURE__ */ new Set([4, 17, 32, 613, 80001, 80002]);
var isAuthCode = (code) => code === 190 || code === 102 || code === 10 || code !== void 0 && code >= 200 && code <= 299;
function classifyMetaError(err, sideEffectStarted) {
  if (err instanceof ConnectorError) return err;
  if (err instanceof MetaApiError) {
    const code = err.body.code;
    const tag = `meta_${code ?? err.httpStatus}${err.body.error_subcode ? `_${err.body.error_subcode}` : ""}`;
    if (code !== void 0 && RATE_LIMIT_CODES.has(code)) {
      return new ConnectorError("rate_limited", err.message, { code: tag, retryAfterSeconds: err.retryAfterSeconds ?? 900, sideEffectStarted: false });
    }
    if (isAuthCode(code)) return new ConnectorError("auth", err.message, { code: tag });
    if (err.body.is_transient || code === 1 || code === 2 || err.httpStatus >= 500) {
      return new ConnectorError(sideEffectStarted ? "unknown" : "transient", err.message, { code: tag, sideEffectStarted });
    }
    return new ConnectorError("permanent", err.message, { code: tag });
  }
  const msg = err instanceof Error ? err.message : String(err);
  const timeout = err?.name === "AbortError" || /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg);
  return new ConnectorError(timeout ? "timeout" : "unknown", msg, { sideEffectStarted });
}
function retryAfterFromHeaders(h) {
  const raw = h.get("x-business-use-case-usage");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const minutes = Math.max(0, ...Object.values(data).flat().map((x) => x.estimated_time_to_regain_access ?? 0));
    return minutes > 0 ? minutes * 60 : null;
  } catch {
    return null;
  }
}
function parseJsonSafe(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}
var GraphClient = class {
  version;
  fetchImpl;
  timeoutMs;
  constructor(opts = {}) {
    this.version = opts.version ?? DEFAULT_GRAPH_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3e4;
  }
  url(path3, host = "graph.facebook.com") {
    return `https://${host}/${this.version}/${path3.replace(/^\//, "")}`;
  }
  async request(method, path3, opts = {}) {
    const url = new URL(opts.rawUrl ?? (opts.unversioned ? `https://${opts.host ?? "graph.facebook.com"}/${path3.replace(/^\//, "")}` : this.url(path3, opts.host)));
    const params = Object.entries(opts.params ?? {}).filter(([, v]) => v !== void 0);
    const headers = { ...opts.headers ?? {} };
    let body;
    const auth = opts.auth ?? "oauth";
    if (opts.token && !headers.Authorization) {
      if (auth === "query") params.push(["access_token", opts.token]);
      else headers.Authorization = `${auth === "bearer" ? "Bearer" : "OAuth"} ${opts.token}`;
    }
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of params) url.searchParams.set(k, String(v));
    } else if (params.length) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(params.map(([k, v]) => [k, String(v)])).toString();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? parseJsonSafe(text) : null;
    } catch {
    }
    if (!res.ok || json && typeof json === "object" && "error" in json) {
      const e = json?.error ?? {};
      throw new MetaApiError(e.message ?? `HTTP ${res.status}`, res.status, e, retryAfterFromHeaders(res.headers));
    }
    return json;
  }
};

// ../../packages/connectors/src/meta/instagram-login.ts
var INSTAGRAM_GRAPH_HOST = "graph.instagram.com";
var expiresAt = (seconds) => seconds && seconds > 0 ? new Date(Date.now() + seconds * 1e3) : null;
async function refreshInstagramToken(graph, token) {
  const r = await graph.request("GET", "refresh_access_token", {
    host: INSTAGRAM_GRAPH_HOST,
    unversioned: true,
    params: { grant_type: "ig_refresh_token" },
    token,
    auth: "query"
  });
  return { token: r.access_token, expiresAt: expiresAt(r.expires_in) };
}
async function fetchInstagramProfile(graph, token) {
  const r = await graph.request("GET", "me", {
    host: INSTAGRAM_GRAPH_HOST,
    params: { fields: "user_id,username,name,account_type,profile_picture_url" },
    token,
    auth: "query"
  });
  const me = (Array.isArray(r.data) ? r.data[0] : r) ?? {};
  const userId = me.user_id ?? me.id;
  if (userId === void 0 || typeof me.username !== "string") {
    throw new ConnectorError("permanent", "Resposta inesperada do Instagram ao ler o perfil.", { code: "ig_profile_shape" });
  }
  return {
    userId: String(userId),
    username: me.username,
    name: typeof me.name === "string" && me.name.trim() ? me.name : null,
    avatarUrl: typeof me.profile_picture_url === "string" ? me.profile_picture_url : null,
    accountType: typeof me.account_type === "string" ? me.account_type : null
  };
}

// ../../packages/connectors/src/meta/instagram.ts
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
var InstagramConnector = class {
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.pollIntervalMs = opts.pollIntervalMs ?? 15e3;
    this.pollBudgetMs = opts.pollBudgetMs ?? 5 * 6e4;
    this.processingDeadlineMs = opts.processingDeadlineMs ?? 30 * 6e4;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }
  graph;
  platform = "instagram";
  pollIntervalMs;
  pollBudgetMs;
  processingDeadlineMs;
  sleep;
  now;
  get(path3, token, params) {
    return this.graph.request("GET", path3, { host: INSTAGRAM_GRAPH_HOST, token, auth: "query", params });
  }
  post(path3, token, params) {
    return this.graph.request("POST", path3, { host: INSTAGRAM_GRAPH_HOST, token, auth: "bearer", params });
  }
  token(input) {
    const t = input.credentials?.accessToken;
    if (!t) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    return t;
  }
  containerStatus(id, token) {
    return this.get(id, token, { fields: "status_code,status" });
  }
  /** Garante que o token pertence à conta selecionada: nunca publicar em outra conta. */
  async assertIdentity(igUser, token) {
    const r = await this.get("me", token, { fields: "user_id,username" });
    const me = (Array.isArray(r.data) ? r.data[0] : r) ?? {};
    const id = me.user_id ?? me.id;
    if (id === void 0 || String(id) !== igUser) {
      throw new ConnectorError("permanent", "O token armazenado n\xE3o pertence \xE0 conta de destino. Nada foi publicado; reconecte a conta.", {
        code: "ig_account_mismatch"
      });
    }
  }
  async publish(input, io) {
    if (input.media.mimeType.startsWith("image/")) {
      throw new ConnectorError("permanent", "Imagem n\xE3o suportada: o conector direto do Instagram publica apenas Reels (v\xEDdeo). Use uma conta conectada via Zernio para imagens.", { code: "ig_image_unsupported" });
    }
    const token = this.token(input);
    const igUser = input.account.externalAccountId;
    let containerId = typeof input.checkpoint?.container_id === "string" ? input.checkpoint.container_id : null;
    let createdAt = typeof input.checkpoint?.container_created_at === "number" ? input.checkpoint.container_created_at : this.now();
    try {
      await this.assertIdentity(igUser, token);
      let known = null;
      if (containerId) {
        const st = await this.containerStatus(containerId, token);
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, input.checkpoint, input.caption);
        if (st.status_code === "EXPIRED" || st.status_code === "ERROR") containerId = null;
        else known = st;
      }
      if (!containerId) {
        const quota = await this.get(`${igUser}/content_publishing_limit`, token, {
          fields: "quota_usage,config"
        });
        const q = quota.data?.[0];
        if (q?.config?.quota_total !== void 0 && q.quota_usage !== void 0 && q.quota_usage >= q.config.quota_total) {
          throw new ConnectorError("rate_limited", `Limite de publica\xE7\xF5es do Instagram atingido (${q.quota_usage}/${q.config.quota_total} em 24 h).`, {
            code: "ig_quota",
            retryAfterSeconds: 3600
          });
        }
        if (!input.media.url) throw new ConnectorError("transient", "URL tempor\xE1ria do v\xEDdeo indispon\xEDvel.", { code: "media_url" });
        const created = await this.post(`${igUser}/media`, token, {
          media_type: "REELS",
          video_url: input.media.url,
          caption: input.caption || void 0,
          share_to_feed: true
        });
        containerId = created.id;
        createdAt = this.now();
      }
      await io.save("processing_remote", { container_id: containerId, container_created_at: createdAt });
      const deadline = this.now() + this.pollBudgetMs;
      for (; ; ) {
        const st = known ?? await this.containerStatus(containerId, token);
        known = null;
        if (st.status_code === "FINISHED") break;
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, { container_id: containerId }, input.caption);
        if (st.status_code === "ERROR") {
          throw new ConnectorError("permanent", `O Instagram rejeitou o v\xEDdeo no processamento${st.status ? ` (${st.status})` : ""}.`, { code: "ig_container_error" });
        }
        if (st.status_code === "EXPIRED") throw new ConnectorError("transient", "Container expirado; ser\xE1 recriado.", { code: "ig_container_expired" });
        if (this.now() - createdAt > this.processingDeadlineMs) {
          throw new ConnectorError("permanent", "O Instagram n\xE3o terminou de processar o v\xEDdeo em 30 minutos.", { code: "ig_processing_timeout" });
        }
        if (this.now() >= deadline) {
          throw new ConnectorError("transient", "O Instagram ainda est\xE1 processando o v\xEDdeo; nova verifica\xE7\xE3o em instantes.", { code: "ig_processing", retryAfterSeconds: 60 });
        }
        await this.sleep(this.pollIntervalMs);
      }
    } catch (e) {
      throw classifyMetaError(e, false);
    }
    const requestedAt = new Date(this.now()).toISOString();
    await io.save("publishing", { container_id: containerId, container_created_at: createdAt, publish_requested_at: requestedAt });
    let mediaId;
    try {
      const r = await this.post(`${igUser}/media_publish`, token, { creation_id: containerId });
      mediaId = r.id;
    } catch (e) {
      const err = classifyMetaError(e, true);
      if (err.errorClass === "rate_limited" || err.errorClass === "auth" || err.errorClass === "permanent") {
        throw new ConnectorError(err.errorClass, err.message, { code: err.code, retryAfterSeconds: err.retryAfterSeconds, sideEffectStarted: false });
      }
      throw err;
    }
    return { externalId: mediaId, permalink: await this.permalink(mediaId, token) };
  }
  /** `permalink` do IG Media ("Permanent URL to the media"). Melhor esforço: o ID já prova a publicação. */
  async permalink(mediaId, token) {
    try {
      const r = await this.get(mediaId, token, { fields: "permalink" });
      return r.permalink ?? null;
    } catch {
      return null;
    }
  }
  /**
   * Container PUBLISHED sem o ID da mídia (falha após media_publish): localiza o Reel entre os
   * mais recentes do perfil, publicado depois do pedido e, se possível, com a mesma legenda.
   */
  async resolvePublished(igUser, token, checkpoint, caption) {
    const since = typeof checkpoint?.publish_requested_at === "string" ? Date.parse(checkpoint.publish_requested_at) - 12e4 : 0;
    try {
      const r = await this.get(`${igUser}/media`, token, {
        fields: "id,permalink,timestamp,caption,media_product_type",
        limit: 10
      });
      const recent = r.data.filter((m) => (!m.timestamp || Date.parse(m.timestamp) >= since) && (!m.media_product_type || m.media_product_type === "REELS"));
      const hit = (caption ? recent.find((m) => (m.caption ?? "") === caption) : void 0) ?? (recent.length === 1 ? recent[0] : void 0);
      if (hit) return { externalId: hit.id, permalink: hit.permalink ?? null };
    } catch {
    }
    return { externalId: `container:${String(checkpoint?.container_id ?? "")}`, permalink: null };
  }
  async getStatus(account, checkpoint, credentials) {
    const containerId = typeof checkpoint.container_id === "string" ? checkpoint.container_id : null;
    if (!containerId) return { state: "not_found" };
    try {
      const token = this.token({ credentials });
      const st = await this.containerStatus(containerId, token);
      if (st.status_code === "PUBLISHED") {
        const r = await this.resolvePublished(account.externalAccountId, token, checkpoint);
        return { state: "published", externalId: r.externalId, permalink: r.permalink };
      }
      if (st.status_code === "IN_PROGRESS") return { state: "processing" };
      return { state: "not_found" };
    } catch {
      return { state: "unknown" };
    }
  }
};

// ../../packages/connectors/src/meta/facebook.ts
var done = (s) => s === "complete" || s === "completed";
var FacebookConnector = class {
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1e4;
    this.pollBudgetMs = opts.pollBudgetMs ?? 2 * 6e4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  graph;
  platform = "facebook";
  pollIntervalMs;
  pollBudgetMs;
  sleep;
  token(input) {
    const t = input.credentials?.accessToken;
    if (!t) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    return t;
  }
  status(videoId, token) {
    return this.graph.request("GET", videoId, { token, params: { fields: "status" } });
  }
  async publish(input, io) {
    if (input.media.mimeType.startsWith("image/")) {
      throw new ConnectorError("permanent", "Imagem n\xE3o suportada: o conector direto do Facebook publica apenas Reels (v\xEDdeo). Use uma conta conectada via Zernio para imagens.", { code: "fb_image_unsupported" });
    }
    const token = this.token(input);
    const pageId = input.account.externalAccountId;
    let videoId = typeof input.checkpoint?.video_id === "string" ? input.checkpoint.video_id : null;
    let uploaded = false;
    try {
      if (videoId) {
        const st = (await this.status(videoId, token)).status;
        if (st?.publishing_phase?.publish_status === "published") return { externalId: videoId, permalink: await this.permalink(videoId, token) };
        if (st?.video_status === "upload_failed" || st?.video_status === "error" || st?.video_status === "expired") videoId = null;
        else uploaded = done(st?.uploading_phase?.status);
      }
      if (!videoId) {
        const started = await this.graph.request("POST", `${pageId}/video_reels`, { token, params: { upload_phase: "start" } });
        videoId = started.video_id;
        await io.save("uploading", { video_id: videoId });
      }
      if (!uploaded) {
        if (!input.media.url) throw new ConnectorError("transient", "URL tempor\xE1ria do v\xEDdeo indispon\xEDvel.", { code: "media_url" });
        await this.graph.request("POST", `video-upload/${this.graph.version}/${videoId}`, {
          rawUrl: `https://rupload.facebook.com/video-upload/${this.graph.version}/${videoId}`,
          headers: { Authorization: `OAuth ${token}`, file_url: input.media.url }
        });
      }
      await io.save("processing_remote", { video_id: videoId });
    } catch (e) {
      throw classifyMetaError(e, false);
    }
    await io.save("publishing", { video_id: videoId });
    try {
      await this.graph.request("POST", `${pageId}/video_reels`, {
        token,
        params: { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: input.caption }
      });
    } catch (e) {
      const err = classifyMetaError(e, true);
      if (err.errorClass === "rate_limited" || err.errorClass === "auth" || err.errorClass === "permanent") {
        throw new ConnectorError(err.errorClass, err.message, { code: err.code, retryAfterSeconds: err.retryAfterSeconds, sideEffectStarted: false });
      }
      throw err;
    }
    const deadline = Date.now() + this.pollBudgetMs;
    for (; ; ) {
      let st;
      try {
        st = (await this.status(videoId, token)).status;
      } catch (e) {
        throw classifyMetaError(e, true);
      }
      if (st?.publishing_phase?.publish_status === "published") return { externalId: videoId, permalink: await this.permalink(videoId, token) };
      if (st?.processing_phase?.status === "error" || st?.publishing_phase?.publish_status === "error") {
        throw new ConnectorError("permanent", st.processing_phase?.error?.message ?? "O Facebook rejeitou o v\xEDdeo no processamento.", { code: "fb_processing_error", sideEffectStarted: false });
      }
      if (Date.now() >= deadline) throw new ConnectorError("unknown", "Reel enviado; aguardando confirma\xE7\xE3o do Facebook.", { code: "fb_pending", sideEffectStarted: true });
      await this.sleep(this.pollIntervalMs);
    }
  }
  /** `permalink_url` do vídeo (campo não listado na página de Reels consultada; best-effort). */
  async permalink(videoId, token) {
    try {
      const r = await this.graph.request("GET", videoId, { token, params: { fields: "permalink_url" } });
      if (!r.permalink_url) return null;
      return r.permalink_url.startsWith("http") ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`;
    } catch {
      return null;
    }
  }
  async getStatus(_account, checkpoint, credentials) {
    const videoId = typeof checkpoint.video_id === "string" ? checkpoint.video_id : null;
    if (!videoId) return { state: "not_found" };
    try {
      const token = this.token({ credentials });
      const st = (await this.status(videoId, token)).status;
      const pub = st?.publishing_phase?.publish_status;
      if (pub === "published") return { state: "published", externalId: videoId, permalink: await this.permalink(videoId, token) };
      if (pub === "error" || st?.processing_phase?.status === "error" || st?.video_status === "upload_failed" || st?.video_status === "expired") return { state: "not_found" };
      if (st?.video_status === "processing" || st?.publishing_phase?.status === "in_progress") return { state: "processing" };
      if (pub === "draft" || pub === void 0) return { state: "not_found" };
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }
};

// ../../packages/connectors/src/meta/signed-request.ts
import { createHmac, timingSafeEqual } from "node:crypto";

// ../../packages/connectors/src/zernio/client.ts
var ZERNIO_BASE_URL = "https://zernio.com/api/v1";
var ZERNIO_SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube"];
var zernioId = (v) => v == null ? null : typeof v === "string" ? v : v._id;
var ZernioApiError = class extends Error {
  constructor(message, status, type, code, details, requestId, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "ZernioApiError";
  }
  status;
  type;
  code;
  details;
  requestId;
  retryAfterSeconds;
  /** 408/429/5xx e falhas de rede podem ser repetidas; 4xx de validação/permissão não. */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
};
var ZernioClient = class _ZernioClient {
  apiKey;
  baseUrl;
  fetchImpl;
  timeoutMs;
  constructor(opts) {
    if (!opts.apiKey || !opts.apiKey.trim()) throw new Error("ZERNIO_API_KEY n\xE3o configurada.");
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? ZERNIO_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3e4;
  }
  /** Lê a chave de ZERNIO_API_KEY (somente servidor). */
  static fromEnv(env = process.env, opts = {}) {
    const apiKey = env.ZERNIO_API_KEY;
    if (!apiKey) throw new Error("ZERNIO_API_KEY n\xE3o configurada.");
    return new _ZernioClient({ ...opts, apiKey });
  }
  async request(method, path3, opts = {}) {
    const url = new URL(`${this.baseUrl}/${path3.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== void 0 && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (opts.body !== void 0) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, { method, headers, body: opts.body === void 0 ? void 0 : JSON.stringify(opts.body), signal: ctrl.signal });
    } catch (e) {
      const timeout = e?.name === "AbortError";
      throw new ZernioApiError(timeout ? "Tempo esgotado ao chamar a Zernio." : "Falha de rede ao chamar a Zernio.", 0, timeout ? "timeout" : "network_error", null, null, null, null);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!res.ok) {
      const e = json ?? {};
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ZernioApiError(
        redact(e.error ?? `HTTP ${res.status}`, this.apiKey),
        res.status,
        e.type ?? null,
        e.code ?? null,
        e.details ?? null,
        res.headers.get("x-request-id"),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      );
    }
    return json;
  }
  // ---------------------------------------------------------------- perfis
  async listProfiles(filter = {}) {
    const r = await this.request("GET", "profiles", { query: filter });
    return r.profiles ?? [];
  }
  async createProfile(input) {
    const r = await this.request("POST", "profiles", { body: input });
    return r.profile;
  }
  /**
   * Perfil idempotente por `externalId` (id do tenant no ReelsFlow): procura, senão cria.
   * Corrida entre duas criações: a API responde 409 com details.existingProfileId — reaproveita.
   */
  async ensureProfile(input) {
    const found = (await this.listProfiles({ externalId: input.externalId })).find((p) => p.externalId === input.externalId);
    if (found) return { profile: found, created: false };
    try {
      return { profile: await this.createProfile(input), created: true };
    } catch (e) {
      const existing = e instanceof ZernioApiError && e.status === 409 ? e.details?.existingProfileId : void 0;
      if (typeof existing === "string") {
        const again = (await this.listProfiles({ externalId: input.externalId }))[0];
        return { profile: again ?? { _id: existing, name: input.name, externalId: input.externalId }, created: false };
      }
      throw e;
    }
  }
  // ---------------------------------------------------------------- conexão de contas
  /**
   * Link de autorização hospedado pela Zernio (GET /v1/connect/{platform}). O usuário abre o
   * `authUrl`, autoriza na rede social e volta para `redirectUrl` com
   * connected/profileId/accountId/username (ou error/error_message).
   */
  async getConnectUrl(platform, profileId, opts = {}) {
    if (!ZERNIO_SOCIAL_PLATFORMS.includes(platform)) throw new Error(`Plataforma n\xE3o suportada: ${platform}`);
    const r = await this.request("GET", `connect/${platform}`, {
      query: { profileId, redirect_url: opts.redirectUrl }
    });
    if (!r?.authUrl) throw new ZernioApiError("Resposta da Zernio sem authUrl.", 502, "api_error", "missing_auth_url", null, null, null);
    return r;
  }
  async listAccounts(profileId) {
    const r = await this.request("GET", "accounts", { query: { profileId } });
    return r.accounts ?? [];
  }
  async disconnectAccount(accountId) {
    await this.request("DELETE", `accounts/${encodeURIComponent(accountId)}`);
  }
  async getAccount(accountId) {
    const r = await this.request("GET", `accounts/${encodeURIComponent(accountId)}`);
    return r.account;
  }
  /** Saúde de todas as contas (canPost, needsReconnect). Uma chamada para todas. */
  async accountsHealth() {
    const r = await this.request("GET", "accounts/health");
    return r.accounts ?? [];
  }
  // ---------------------------------------------------------------- posts
  /**
   * Cria o post. `idempotencyKey`: repetir com a mesma chave em 24 h devolve o post original
   * (HTTP 200) em vez de criar outro. 207 é 2xx mesmo com falha: decida por post.status.
   */
  async createPost(input, idempotencyKey) {
    const r = await this.request("POST", "posts", { body: input, idempotencyKey });
    if (!r?.post?._id) throw new ZernioApiError("Resposta da Zernio sem post.", 502, "api_error", "missing_post", null, null, null);
    return r.post;
  }
  async getPost(postId) {
    const r = await this.request("GET", `posts/${encodeURIComponent(postId)}`);
    return r.post;
  }
  /** Localiza o post pelo nosso identificador (GET /v1/posts?externalId=). */
  async findPostByExternalId(externalId) {
    const r = await this.request("GET", "posts", { query: { externalId, limit: 5, includeHidden: true } });
    return (r.posts ?? []).find((p) => p.externalId === externalId) ?? null;
  }
  /** Reexecuta só as plataformas que falharam (POST /v1/posts/{id}/retry). */
  async retryPost(postId) {
    const r = await this.request("POST", `posts/${encodeURIComponent(postId)}/retry`);
    return r?.post ?? null;
  }
};
function redact(message, key) {
  return key ? message.split(key).join("[redacted]") : message;
}

// ../../packages/connectors/src/zernio/connector.ts
var TRANSIENT_CATEGORIES = /* @__PURE__ */ new Set(["platform_error", "platform_rate_limit", "quota_exhausted", "system_error"]);
var AUTH_CATEGORIES = /* @__PURE__ */ new Set(["auth_expired", "account_issue"]);
var PENDING_STATES = /* @__PURE__ */ new Set(["pending", "processing", "uploading", "publishing", "scheduled"]);
var zernioJobKey = (jobId) => `reelsflow-job-${jobId}`;
var ZernioConnector = class {
  constructor(client, opts = {}) {
    this.client = client;
    this.pollBudgetMs = opts.pollBudgetMs ?? 6e4;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1e4;
    this.processingDeadlineMs = opts.processingDeadlineMs ?? 6 * 36e5;
    this.maxRemoteRetries = opts.maxRemoteRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }
  client;
  platform = "zernio";
  pollBudgetMs;
  pollIntervalMs;
  processingDeadlineMs;
  maxRemoteRetries;
  sleep;
  now;
  async publish(input, io) {
    const key = zernioJobKey(input.jobId);
    const prev = input.checkpoint ?? {};
    let cp = { provider: "zernio", idempotency_key: key, ...prev };
    const platform = input.account.platform;
    const isImage = input.media.mimeType.startsWith("image/");
    if (isImage && platform !== "instagram" && platform !== "facebook") {
      throw new ConnectorError("permanent", "Imagens s\xF3 s\xE3o publicadas no Instagram e no Facebook. Nada foi publicado.", { code: "zernio_image_platform" });
    }
    let post;
    if (cp.zernio_post_id) {
      post = await this.call(() => this.client.getPost(cp.zernio_post_id), false);
    } else {
      await this.assertAccount(input);
      if (!input.media.url) throw new ConnectorError("transient", "URL tempor\xE1ria do v\xEDdeo indispon\xEDvel.", { code: "media_url" });
      cp = { ...cp, requested_at: cp.requested_at ?? this.now() };
      await io.save("publishing", cp);
      post = await this.call(
        () => this.client.createPost(
          {
            content: input.caption || void 0,
            // Imagem (ex.: Card Editorial) vira post de feed; vídeo vira Reel (shareToFeed só vale para Reels).
            mediaItems: [{ type: isImage ? "image" : "video", url: input.media.url }],
            platforms: [
              {
                platform,
                accountId: input.account.externalAccountId,
                ...platform === "instagram" && !isImage ? { platformSpecificData: { shareToFeed: true } } : {}
              }
            ],
            profileId: input.account.providerProfileId ?? void 0,
            publishNow: true,
            externalId: key
          },
          key
        ),
        true
      );
      cp = { ...cp, zernio_post_id: post._id };
      await io.save("publishing", cp);
    }
    const deadline = this.now() + this.pollBudgetMs;
    for (; ; ) {
      const target = this.target(post, input.account.externalAccountId);
      const outcome = await this.evaluate(post, target, cp, io);
      if (outcome.kind === "published") return outcome.result;
      if (outcome.kind === "retried") {
        cp = outcome.cp;
        post = outcome.post ?? post;
      }
      if (this.now() - (cp.requested_at ?? this.now()) > this.processingDeadlineMs) {
        throw new ConnectorError("unknown", "A Zernio ainda n\xE3o confirmou a publica\xE7\xE3o; acompanhamento continua pela reconcilia\xE7\xE3o.", {
          code: "zernio_unresolved",
          sideEffectStarted: true
        });
      }
      if (this.now() >= deadline) {
        throw new ConnectorError("transient", target?.errorMessage ? `Aguardando a Zernio: ${target.errorMessage}` : "Publica\xE7\xE3o em andamento na Zernio; nova verifica\xE7\xE3o em instantes.", {
          code: "zernio_processing",
          retryAfterSeconds: 60
        });
      }
      await this.sleep(this.pollIntervalMs);
      post = await this.call(() => this.client.getPost(cp.zernio_post_id), false);
    }
  }
  /** Conta existe, está ativa, é da plataforma certa e pertence ao perfil vinculado ao workspace. */
  async assertAccount(input) {
    if (!input.account.providerProfileId) {
      throw new ConnectorError("permanent", "Conta Zernio sem perfil vinculado. Nada foi publicado.", { code: "zernio_profile_missing" });
    }
    const acc = await this.call(() => this.client.getAccount(input.account.externalAccountId), false);
    if (zernioId(acc.profileId) !== input.account.providerProfileId || acc.platform !== input.account.platform) {
      throw new ConnectorError("permanent", "A conta na Zernio n\xE3o pertence ao perfil deste workspace. Nada foi publicado.", { code: "zernio_account_mismatch" });
    }
    if (acc.isActive === false) throw new ConnectorError("auth", "Conta desativada na Zernio. Reconecte a conta.", { code: "zernio_account_inactive" });
  }
  target(post, accountId) {
    return post.platforms?.find((t) => zernioId(t.accountId) === accountId) ?? (post.platforms?.length === 1 ? post.platforms[0] : void 0);
  }
  async evaluate(post, target, cp, io) {
    const st = target?.status ?? (post.status === "published" ? "published" : post.status);
    if (st === "published") {
      return { kind: "published", result: { externalId: target?.platformPostId || `zernio:${post._id}`, permalink: target?.platformPostUrl || null } };
    }
    if (st === "cancelled" || post.status === "cancelled") {
      throw new ConnectorError("permanent", "O post foi cancelado na Zernio. Nada foi publicado.", { code: "zernio_cancelled" });
    }
    if (st === "failed" || post.status === "failed") {
      const cat = target?.errorCategory ?? "unknown";
      const msg = target?.errorMessage ? `Instagram/Zernio: ${target.errorMessage}` : "A Zernio informou falha na publica\xE7\xE3o.";
      if (AUTH_CATEGORIES.has(cat)) throw new ConnectorError("auth", `${msg} Reconecte a conta na Zernio.`, { code: `zernio_${cat}` });
      if (TRANSIENT_CATEGORIES.has(cat) && (cp.remote_retries ?? 0) < this.maxRemoteRetries) {
        const next = { ...cp, remote_retries: (cp.remote_retries ?? 0) + 1 };
        await io.save("publishing", next);
        const again = await this.call(() => this.client.retryPost(post._id), false);
        return { kind: "retried", cp: next, post: again };
      }
      throw new ConnectorError("permanent", msg, { code: `zernio_${cat}` });
    }
    if (PENDING_STATES.has(st) || post.status === "partial") return { kind: "pending" };
    return { kind: "pending" };
  }
  /** Converte erros HTTP da Zernio. `sideEffect`: a chamada pode ter criado o post. */
  async call(fn, sideEffect) {
    try {
      return await fn();
    } catch (e) {
      throw classifyZernioError(e, sideEffect);
    }
  }
  async getStatus(account, checkpoint) {
    const cp = checkpoint;
    try {
      const post = cp.zernio_post_id ? await this.client.getPost(cp.zernio_post_id) : cp.idempotency_key ? await this.client.findPostByExternalId(cp.idempotency_key) : null;
      if (!post) return { state: "not_found" };
      const t = this.target(post, account.externalAccountId);
      const st = t?.status ?? post.status;
      if (st === "published") return { state: "published", externalId: t?.platformPostId || `zernio:${post._id}`, permalink: t?.platformPostUrl || null };
      if (st === "failed" || st === "cancelled") return { state: "not_found" };
      return { state: "processing" };
    } catch {
      return { state: "unknown" };
    }
  }
};
function classifyZernioError(e, sideEffect) {
  if (e instanceof ConnectorError) return e;
  if (!(e instanceof ZernioApiError)) {
    return new ConnectorError(sideEffect ? "unknown" : "transient", e instanceof Error ? e.message : String(e), { sideEffectStarted: sideEffect });
  }
  const tag = `zernio_${e.code ?? e.status}`;
  const opts = { code: tag, retryAfterSeconds: e.retryAfterSeconds ?? void 0 };
  if (e.status === 0 || e.status >= 500) {
    return sideEffect ? new ConnectorError(e.type === "timeout" ? "timeout" : "unknown", e.message, { ...opts, sideEffectStarted: true }) : new ConnectorError("transient", e.message, opts);
  }
  if (e.status === 429) return new ConnectorError("rate_limited", e.message, { ...opts, retryAfterSeconds: e.retryAfterSeconds ?? 60 });
  if (e.status === 409 && e.code === "idempotency_conflict") {
    return new ConnectorError("transient", e.message, { ...opts, retryAfterSeconds: e.retryAfterSeconds ?? 30 });
  }
  if (e.status === 409 && e.code === "duplicate_content") {
    return new ConnectorError("permanent", "Este v\xEDdeo com a mesma legenda j\xE1 foi enviado a esta conta nas \xFAltimas 24 h. Nada foi publicado de novo.", opts);
  }
  if (e.status === 401) return new ConnectorError("transient", "Chave da Zernio inv\xE1lida ou ausente no servidor.", { ...opts, code: "zernio_api_key", retryAfterSeconds: 900 });
  if (e.status === 402) return new ConnectorError("transient", "A Zernio exige pagamento para esta opera\xE7\xE3o (limite do plano).", { ...opts, code: "zernio_payment_required", retryAfterSeconds: 3600 });
  if (e.status === 403 && /DISCONNECTED|disconnected/.test(`${e.code} ${e.message}`)) return new ConnectorError("auth", "Conta desconectada na Zernio. Reconecte a conta.", opts);
  if (e.status === 404) return new ConnectorError("auth", "Conta ou post n\xE3o encontrado na Zernio.", opts);
  return new ConnectorError("permanent", e.message, opts);
}

// src/db.ts
function postgresJsDb(sql) {
  return {
    async query(text, values = []) {
      const res = await sql.unsafe(text, values);
      return { rows: [...res], rowCount: res.count ?? res.length };
    },
    end: () => sql.end({ timeout: 5 })
  };
}
var POSTGRES_JS_OPTIONS = {
  prepare: false,
  onnotice: () => {
  },
  types: {
    json: {
      to: 114,
      from: [114, 3802],
      serialize: (x) => typeof x === "string" ? x : JSON.stringify(x),
      parse: (x) => JSON.parse(x)
    }
  }
};

// src/log.ts
var SECRET_KEYS = /token|secret|key|authorization|password|signed/i;
function sanitize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = v.replace(/([?&](token|X-Amz-Signature)=)[^&\s]+/gi, "$1[redacted]").slice(0, 2e3);
    else out[k] = v;
  }
  return out;
}
function createLogger(base = {}, sink = (l) => process.stdout.write(l + "\n")) {
  const emit = (level) => (msg, fields = {}) => sink(JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg, ...sanitize({ ...base, ...fields }) }));
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

// src/publishing/credentials.ts
var PgCredentialProvider = class {
  constructor(db, cipher) {
    this.db = db;
    this.cipher = cipher;
  }
  db;
  cipher;
  async get(account) {
    if (account.platform === "mock") return null;
    const { rows } = await this.db.query(
      "select ciphertext, iv, auth_tag, key_version from public.social_account_tokens where social_account_id = $1",
      [account.id]
    );
    const row = rows[0];
    if (!row) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    if (!this.cipher) {
      throw new ConnectorError("transient", "Chave de criptografia de tokens n\xE3o configurada no worker.", { code: "cipher_missing", retryAfterSeconds: 900 });
    }
    try {
      return { accessToken: this.cipher.open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag, keyVersion: row.key_version }, `${account.platform}:${account.external_account_id}`) };
    } catch {
      throw new ConnectorError("transient", "N\xE3o foi poss\xEDvel decifrar as credenciais (chave ausente ou rotacionada).", { code: "cipher_failure", retryAfterSeconds: 900 });
    }
  }
};

// src/publishing/store.ts
var PgMockStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  async createUpload(accountId, uploadRef, caption) {
    const r = await this.db.query(
      `insert into public.mock_remote_posts (social_account_id, upload_ref, caption) values ($1, $2, $3)
       on conflict (upload_ref) do update set upload_ref = excluded.upload_ref returning id`,
      [accountId, uploadRef, caption]
    );
    return r.rows[0].id;
  }
  async publish(uploadRef) {
    await this.db.query("update public.mock_remote_posts set status = 'published', published_at = now() where upload_ref = $1", [uploadRef]);
  }
  async find(uploadRef) {
    const r = await this.db.query(
      "select id, status from public.mock_remote_posts where upload_ref = $1",
      [uploadRef]
    );
    return r.rows[0] ?? null;
  }
};

// src/storage.ts
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
var SupabaseStorage = class {
  constructor(url, serviceKey, bucket = "media") {
    this.bucket = bucket;
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  bucket;
  client;
  async download(objectPath, destFile) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(objectPath, 300);
    if (error || !data) throw new Error(`signed url failed: ${error?.message ?? "unknown"}`);
    const res = await fetch(data.signedUrl);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destFile));
  }
  async upload(objectPath, file, contentType) {
    const body = await readFile(file);
    const { error } = await this.client.storage.from(this.bucket).upload(objectPath, body, { contentType, upsert: true });
    if (error) throw new Error(`upload failed: ${error.message}`);
  }
  async remove(objectPaths) {
    for (let i = 0; i < objectPaths.length; i += 100) {
      const { error } = await this.client.storage.from(this.bucket).remove(objectPaths.slice(i, i + 100));
      if (error) throw new Error(`remove failed: ${error.message}`);
    }
  }
  async list(prefix) {
    const out = [];
    const walk = async (dir) => {
      for (let offset = 0; ; offset += 1e3) {
        const { data, error } = await this.client.storage.from(this.bucket).list(dir, { limit: 1e3, offset });
        if (error) throw new Error(`list failed: ${error.message}`);
        for (const item of data ?? []) {
          const full = dir ? `${dir}/${item.name}` : item.name;
          if (item.id === null) await walk(full);
          else out.push(full);
        }
        if (!data || data.length < 1e3) break;
      }
    };
    await walk(prefix.replace(/\/$/, ""));
    return out;
  }
  async signedUrl(objectPath, expiresInSeconds) {
    const { data } = await this.client.storage.from(this.bucket).createSignedUrl(objectPath, expiresInSeconds);
    return data?.signedUrl ?? null;
  }
  async exists(objectPath) {
    const dir = path.posix.dirname(objectPath);
    const name = path.posix.basename(objectPath);
    const { data, error } = await this.client.storage.from(this.bucket).list(dir, { search: name, limit: 10 });
    if (error) throw new Error(`exists failed: ${error.message}`);
    return (data ?? []).some((o) => o.name === name);
  }
};

// src/notify/email.ts
var EmailSendError = class extends Error {
  constructor(message, permanent) {
    super(message);
    this.permanent = permanent;
  }
  permanent;
};
var ResendSender = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  cfg;
  name = "resend";
  async send(msg) {
    const res = await (this.cfg.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to: [msg.to], subject: msg.subject, text: msg.text })
    });
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new EmailSendError(`HTTP ${res.status}`, permanent);
    }
  }
};
var SUBJECTS = {
  "publication.failed": "Uma publica\xE7\xE3o falhou",
  "publication.needs_review": "Uma publica\xE7\xE3o precisa da sua revis\xE3o",
  "publication.late": "Uma publica\xE7\xE3o atrasou e foi para revis\xE3o",
  "account.disconnected": "Uma conta precisa ser reconectada",
  "account.token_expiring": "A autoriza\xE7\xE3o de uma conta vai expirar",
  "system.worker_stalled": "Publica\xE7\xF5es em espera: processamento interrompido",
  "upload.failed": "Um v\xEDdeo enviado n\xE3o p\xF4de ser processado",
  "plan.limit_reached": "Limite do plano atingido"
};
var ACTION = {
  "publication.failed": "Veja o motivo na Fila de Publica\xE7\xF5es e, se quiser, reagende.",
  "publication.needs_review": "Abra a Fila de Publica\xE7\xF5es para decidir o que fazer.",
  "publication.late": "Abra a Fila de Publica\xE7\xF5es para reagendar ou descartar.",
  "account.disconnected": "Abra Contas Conectadas e reconecte a conta. As publica\xE7\xF5es dela aguardam.",
  "account.token_expiring": "Abra Contas Conectadas e renove a autoriza\xE7\xE3o.",
  "system.worker_stalled": "Nossa equipe j\xE1 foi alertada. As publica\xE7\xF5es vencidas aguardam e nada \xE9 publicado em rajada.",
  "upload.failed": "Abra a Biblioteca para ver o motivo e enviar outro arquivo.",
  "plan.limit_reached": "Abra Assinatura para ver o uso e os planos."
};
function composeEmail(p, appUrl) {
  const subject = `[ReelsFlow] ${SUBJECTS[p.type] ?? "Novo aviso"}`;
  const pick = (k) => typeof p.payload[k] === "string" ? String(p.payload[k]).slice(0, 120) : null;
  const lines = [`Workspace: ${p.workspace}`];
  if (pick("account")) lines.push(`Conta: ${pick("account")}`);
  if (pick("campaign")) lines.push(`Campanha: ${pick("campaign")}`);
  if (pick("media")) lines.push(`V\xEDdeo: ${pick("media")}`);
  lines.push("", ACTION[p.type] ?? "Abra o ReelsFlow para ver os detalhes.");
  if (appUrl) lines.push("", `${appUrl.replace(/\/$/, "")}/w/${p.slug}/notifications`);
  lines.push("", "Voc\xEA recebe este e-mail porque \xE9 membro do workspace. Ajuste em Notifica\xE7\xF5es \u2192 Prefer\xEAncias.");
  return { subject, text: lines.join("\n") };
}
async function deliverEmails(db, deps) {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const { rows } = await db.query(
    `select n.id, n.workspace_id, n.user_id, n.type, n.payload, n.email_attempts, u.email, w.name as workspace, w.slug,
            p.email_enabled, p.muted_types
       from public.notifications n
       join auth.users u on u.id = n.user_id
       join public.workspaces w on w.id = n.workspace_id
       left join public.notification_preferences p on p.user_id = n.user_id and p.workspace_id = n.workspace_id
      where n.email_status = 'pending' and n.created_at > now() - interval '24 hours'
      order by n.created_at limit $1`,
    [deps.batch ?? 20]
  );
  if (!rows.length) return out;
  const mark = (id, status, error) => db.query(
    `update public.notifications set email_status = $2, email_error = $3, email_attempts = email_attempts + case when $2 in ('sent', 'failed', 'pending') then 1 else 0 end,
              emailed_at = case when $2 = 'sent' then now() else emailed_at end
        where id = $1 and email_status = 'pending'`,
    [id, status, error]
  );
  const sentToday = Number((await db.query("select count(*) as n from public.notifications where emailed_at > now() - interval '24 hours'")).rows[0]?.n ?? 0);
  let budget = (deps.dailyCap ?? 90) - sentToday;
  for (const n of rows) {
    if (!deps.sender) {
      await mark(n.id, "skipped", "provider_not_configured");
      out.skipped++;
      continue;
    }
    if (!n.email) {
      await mark(n.id, "skipped", "no_email");
      out.skipped++;
      continue;
    }
    if (n.email_enabled === false || (n.muted_types ?? []).includes(n.type)) {
      await mark(n.id, "skipped", "user_preference");
      out.skipped++;
      continue;
    }
    const subjectKey = String(n.payload.account_id ?? n.payload.job_id ?? n.payload.campaign ?? "");
    const recent = await db.query(
      `select count(*) as total,
              count(*) filter (where type = $2 and coalesce(payload ->> 'account_id', payload ->> 'job_id', payload ->> 'campaign', '') = $3) as same
         from public.notifications where user_id = $1 and emailed_at > now() - interval '1 hour'`,
      [n.user_id, n.type, subjectKey]
    );
    if (Number(recent.rows[0]?.same ?? 0) > 0) {
      await mark(n.id, "skipped", "duplicate_recent");
      out.skipped++;
      continue;
    }
    if (Number(recent.rows[0]?.total ?? 0) >= (deps.perUserPerHour ?? 10) || budget <= 0) {
      await mark(n.id, "skipped", budget <= 0 ? "daily_cap" : "user_rate_limit");
      out.skipped++;
      continue;
    }
    try {
      await deps.sender.send({ to: n.email, ...composeEmail(n, deps.appUrl ?? null) });
      await mark(n.id, "sent", null);
      budget--;
      out.sent++;
    } catch (e) {
      const permanent = e instanceof EmailSendError ? e.permanent : false;
      const giveUp = permanent || n.email_attempts + 1 >= 3;
      await mark(n.id, giveUp ? "failed" : "pending", (e instanceof Error ? e.message : String(e)).slice(0, 300));
      if (giveUp) out.failed++;
      deps.log.warn("email delivery failed", { notification_id: n.id, provider: deps.sender.name, permanent, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (out.sent || out.failed) deps.log.info("emails delivered", out);
  return out;
}

// ../../packages/domain/src/validators.ts
import { z } from "npm:zod@4.6.7";
function isValidTimezone(tz) {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
var timezoneSchema = z.string().trim().refine(isValidTimezone, { message: "Fuso hor\xE1rio inv\xE1lido." });
var emailSchema = z.string().trim().toLowerCase().email({ message: "E-mail inv\xE1lido." }).max(254);
var passwordSchema = z.string().min(8, { message: "A senha deve ter pelo menos 8 caracteres." }).max(72, { message: "A senha deve ter no m\xE1ximo 72 caracteres." }).refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
  message: "Use letras e n\xFAmeros."
});
var displayNameSchema = z.string().trim().min(1, { message: "Informe um nome." }).max(80, { message: "M\xE1ximo de 80 caracteres." });
var workspaceNameSchema = z.string().trim().min(2, { message: "Use pelo menos 2 caracteres." }).max(80, { message: "M\xE1ximo de 80 caracteres." });
var signUpSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema
});
var signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { message: "Informe a senha." })
});
var forgotPasswordSchema = z.object({ email: emailSchema });
var resetPasswordSchema = z.object({ password: passwordSchema, confirm: z.string() }).refine((v) => v.password === v.confirm, { message: "As senhas n\xE3o coincidem.", path: ["confirm"] });
var createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  timezone: timezoneSchema
});
var updateProfileSchema = z.object({
  displayName: displayNameSchema,
  timezone: timezoneSchema
});
var updateMediaSchema = z.object({
  name: z.string().trim().min(1, { message: "Informe um nome." }).max(200, { message: "M\xE1ximo de 200 caracteres." }),
  caption: z.string().max(2200, { message: "M\xE1ximo de 2.200 caracteres." }),
  hashtags: z.string().max(4e3)
});
var collectionNameSchema = z.string().trim().min(1, { message: "Informe um nome." }).max(80, { message: "M\xE1ximo de 80 caracteres." });

// ../../packages/domain/src/media.ts
var DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
var TUS_CHUNK_SIZE = 6 * 1024 * 1024;
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`.replace(".", ",");
}
function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "\u2014";
  const total = Math.round(ms / 1e3);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
var ProbeError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ProbeError";
  }
  code;
};
function parseRate(rate) {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1e3) / 1e3 : null;
}
function parseFfprobe(raw) {
  if (!raw || typeof raw !== "object") throw new ProbeError("invalid_output");
  const out = raw;
  const streams = out.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) throw new ProbeError("no_video_stream");
  const audio = streams.find((s) => s.codec_type === "audio");
  const rawRotation = video.side_data_list?.find((d) => d.rotation !== void 0)?.rotation ?? video.tags?.rotate ?? 0;
  const rotation = (Math.round(Number(rawRotation) || 0) % 360 + 360) % 360;
  const w = video.width ?? 0;
  const h = video.height ?? 0;
  if (w <= 0 || h <= 0) throw new ProbeError("invalid_dimensions");
  const swap = rotation === 90 || rotation === 270;
  const duration = Number(out.format?.duration ?? video.duration ?? 0);
  const bitrate = Number(out.format?.bit_rate);
  return {
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1e3) : 0,
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    videoCodec: (video.codec_name ?? "unknown").toLowerCase(),
    audioCodec: audio?.codec_name?.toLowerCase() ?? null,
    hasAudio: Boolean(audio),
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    container: out.format?.format_name ?? "unknown"
  };
}
var PLATFORMS = ["instagram_reels", "facebook_reels", "tiktok", "youtube_shorts"];
var COMPATIBILITY_RULES_VERSION = "2026-11-19-meta-v27";
var MB_ = 1024 * 1024;
var SPECS = {
  // ig-user/media "Reel Specifications": MOV/MP4, HEVC/H264, AAC, 23–60 fps, largura máx. 1920, 3 s–15 min, 300 MB.
  instagram_reels: {
    verified: true,
    containers: ["mp4", "mov"],
    videoCodecs: ["h264", "hevc"],
    audioCodecs: ["aac"],
    minDurationS: 3,
    maxDurationS: 900,
    maxSizeBytes: 300 * MB_,
    minFps: 23,
    maxFps: 60,
    maxWidth: 1920,
    verticalRecommended: true
  },
  // Reels Publishing API: .mp4 recomendado, H.264/H.265/VP9/AV1, AAC, 24–60 fps, 3–90 s, mín. 540×960.
  facebook_reels: {
    verified: true,
    containers: ["mp4", "mov"],
    videoCodecs: ["h264", "hevc", "vp9", "av1"],
    audioCodecs: ["aac"],
    minDurationS: 3,
    maxDurationS: 90,
    minFps: 24,
    maxFps: 60,
    minShortSide: 540,
    minLongSide: 960,
    verticalRecommended: true
  },
  tiktok: {
    verified: false,
    containers: ["mp4", "mov", "webm"],
    videoCodecs: ["h264", "hevc", "vp8", "vp9"],
    audioCodecs: ["aac", "mp3", "opus", "vorbis"],
    durationNote: "A dura\xE7\xE3o m\xE1xima depende da conta e \xE9 verificada no momento da publica\xE7\xE3o.",
    verticalRecommended: true
  },
  youtube_shorts: {
    verified: false,
    containers: ["mp4", "mov", "webm"],
    videoCodecs: ["h264", "hevc", "vp8", "vp9", "av1"],
    audioCodecs: ["aac", "mp3", "opus", "vorbis"],
    maxDurationS: 180,
    durationNote: "Acima do limite, o YouTube pode tratar como v\xEDdeo comum, n\xE3o como Short.",
    verticalRecommended: true
  }
};
var IMAGE_RULES_VERSION = "2026-11-21-image-v1";
function evaluateImageCompatibility(img, sizeBytes) {
  const r = img.width / img.height;
  const ig = [];
  if (img.format !== "jpeg") ig.push({ level: "error", code: "image_format", message: "O Instagram aceita apenas JPEG." });
  if (r < 0.8 - 5e-3 || r > 1.91 + 5e-3) {
    ig.push({ level: "error", code: "image_ratio", message: "Propor\xE7\xE3o fora de 4:5 a 1,91:1: n\xE3o \xE9 aceita no feed do Instagram (use 4:5 ou 1:1)." });
  }
  if (sizeBytes && sizeBytes > 8 * MB_) ig.push({ level: "error", code: "too_large", message: "Imagem acima de 8 MB." });
  ig.push({ level: "warning", code: "feed_post", message: "Imagem: publicada no feed (n\xE3o como Reel), somente por contas conectadas via Zernio." });
  const fb = [{ level: "warning", code: "feed_post", message: "Imagem: publicada como foto na P\xE1gina, somente via Zernio." }];
  const no = (label) => ({ status: "error", verified: true, issues: [{ level: "error", code: "image_unsupported", message: `O ReelsFlow n\xE3o publica imagens no ${label}.` }] });
  const st = (issues) => issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : "ok";
  return {
    rulesVersion: IMAGE_RULES_VERSION,
    kind: "image",
    platforms: {
      instagram_reels: { status: st(ig), verified: false, issues: ig },
      facebook_reels: { status: st(fb), verified: false, issues: fb },
      tiktok: no("TikTok"),
      youtube_shorts: no("YouTube")
    }
  };
}
function containerOf(probe, ext) {
  if (probe.container.includes("webm") || probe.container.includes("matroska")) return "webm";
  if (probe.container.includes("mov") || probe.container.includes("mp4")) return ext === "mov" ? "mov" : "mp4";
  return probe.container;
}
function evaluateCompatibility(probe, originalExt, sizeBytes) {
  const container = containerOf(probe, originalExt.toLowerCase());
  const platforms = {};
  for (const p of PLATFORMS) {
    const spec = SPECS[p];
    const hard = spec.verified ? "error" : "warning";
    const suffix = spec.verified ? "" : " (limite preliminar)";
    const issues = [];
    if (!spec.containers.includes(container)) {
      issues.push({ level: "error", code: "container", message: `Formato ${container.toUpperCase()} n\xE3o aceito.` });
    }
    if (!spec.videoCodecs.includes(probe.videoCodec)) {
      issues.push({ level: "error", code: "video_codec", message: `Codec de v\xEDdeo ${probe.videoCodec.toUpperCase()} n\xE3o aceito.` });
    }
    if (probe.audioCodec && !spec.audioCodecs.includes(probe.audioCodec)) {
      issues.push({ level: hard, code: "audio_codec", message: `Codec de \xE1udio ${probe.audioCodec.toUpperCase()} n\xE3o aceito (use AAC).` });
    }
    const secs = probe.durationMs / 1e3;
    if (spec.minDurationS && secs < spec.minDurationS) {
      issues.push({ level: hard, code: "too_short", message: `Dura\xE7\xE3o abaixo de ${spec.minDurationS}s${suffix}.` });
    }
    if (spec.maxDurationS && secs > spec.maxDurationS) {
      issues.push({ level: hard, code: "too_long", message: spec.durationNote ?? `Dura\xE7\xE3o acima de ${formatDuration(spec.maxDurationS * 1e3)}${suffix}.` });
    }
    if (spec.maxSizeBytes && sizeBytes && sizeBytes > spec.maxSizeBytes) {
      issues.push({ level: hard, code: "too_large", message: `Arquivo acima de ${formatBytes(spec.maxSizeBytes)}.` });
    }
    if (probe.fps != null && (spec.minFps && probe.fps < spec.minFps - 0.01 || spec.maxFps && probe.fps > spec.maxFps + 0.01)) {
      issues.push({ level: hard, code: "fps", message: `Taxa de quadros ${probe.fps} fora de ${spec.minFps}\u2013${spec.maxFps} fps.` });
    }
    if (spec.maxWidth && probe.width > spec.maxWidth) {
      issues.push({ level: hard, code: "too_wide", message: `Largura acima de ${spec.maxWidth} px.` });
    }
    if (spec.minShortSide && spec.minLongSide) {
      const short = Math.min(probe.width, probe.height);
      const long = Math.max(probe.width, probe.height);
      if (short < spec.minShortSide || long < spec.minLongSide) {
        issues.push({ level: hard, code: "resolution", message: `Resolu\xE7\xE3o abaixo de ${spec.minShortSide}\xD7${spec.minLongSide}.` });
      }
    }
    if (spec.verticalRecommended && probe.width >= probe.height) {
      issues.push({ level: "warning", code: "not_vertical", message: "V\xEDdeo n\xE3o vertical; o formato recomendado \xE9 9:16." });
    }
    const status = issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : "ok";
    platforms[p] = { status, verified: spec.verified, issues };
  }
  return { rulesVersion: COMPATIBILITY_RULES_VERSION, platforms };
}
function thumbnailPathFor(storagePath) {
  return storagePath.replace(/\/[^/]+$/, "/thumb.jpg");
}

// ../../packages/domain/src/scheduling/schedule.ts
import { Temporal } from "npm:temporal-polyfill@1.0.8";
import { z as z2 } from "npm:zod@4.6.7";
var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var scheduleRuleSchema = z2.object({
  timezone: z2.string().refine(isValidTimezone, { message: "Fuso hor\xE1rio inv\xE1lido." }),
  weekdays: z2.array(z2.number().int().min(1).max(7)).min(1, { message: "Escolha ao menos um dia da semana." }).transform((d) => [...new Set(d)].sort()),
  times: z2.array(z2.string().regex(TIME_RE, { message: "Hor\xE1rio inv\xE1lido (use HH:MM)." })).min(1, { message: "Informe ao menos um hor\xE1rio." }).max(24, { message: "M\xE1ximo de 24 hor\xE1rios por dia." }).transform((t) => [...new Set(t)].sort()),
  startDate: z2.string().regex(DATE_RE, { message: "Data inicial inv\xE1lida." }),
  endDate: z2.string().regex(DATE_RE).nullish()
}).refine((r) => !r.endDate || r.endDate >= r.startDate, { message: "A data final deve ser igual ou posterior \xE0 inicial.", path: ["endDate"] });
function localToInstant(localDate, localTime, timezone) {
  const date = Temporal.PlainDate.from(localDate);
  const [h, m] = localTime.split(":").map(Number);
  const zdt = Temporal.ZonedDateTime.from(
    { timeZone: timezone, year: date.year, month: date.month, day: date.day, hour: h, minute: m },
    { disambiguation: "compatible" }
  );
  const dstAdjusted = zdt.hour !== h || zdt.minute !== m || !zdt.toPlainDate().equals(date);
  return { instant: zdt.toInstant(), dstAdjusted };
}
function generateSlots(rule, opts) {
  const out = [];
  if (opts.limit <= 0) return out;
  const notBefore = Temporal.Instant.fromEpochMilliseconds(opts.notBefore.getTime());
  const weekdays = new Set(rule.weekdays);
  const times = [...new Set(rule.times)].sort();
  const end = rule.endDate ? Temporal.PlainDate.from(rule.endDate) : null;
  const maxDays = opts.maxDays ?? 3660;
  const today = notBefore.toZonedDateTimeISO(rule.timezone).toPlainDate();
  let day = Temporal.PlainDate.from(rule.startDate);
  if (Temporal.PlainDate.compare(day, today) < 0) day = today;
  for (let i = 0; i < maxDays && out.length < opts.limit; i++, day = day.add({ days: 1 })) {
    if (end && Temporal.PlainDate.compare(day, end) > 0) break;
    if (!weekdays.has(day.dayOfWeek)) continue;
    for (const t of times) {
      const { instant, dstAdjusted } = localToInstant(day.toString(), t, rule.timezone);
      if (Temporal.Instant.compare(instant, notBefore) <= 0) continue;
      out.push({ localDate: day.toString(), localTime: t, scheduledAt: instant.toString(), dstAdjusted });
      if (out.length >= opts.limit) break;
    }
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

// ../../packages/domain/src/scheduling/precedence.ts
var ORDER = ["media", "campaign", "account", "global"];
function resolveContent(layers) {
  const pick = (key, isSet) => {
    for (const layer of ORDER) {
      const v = layers[layer]?.[key];
      if (v !== void 0 && v !== null && isSet(v)) return { value: v, source: layer };
    }
    return null;
  };
  const caption = pick("caption", (v) => typeof v === "string" && v.trim().length > 0);
  const hashtags = pick("hashtags", (v) => Array.isArray(v) && v.length > 0);
  return {
    caption: caption ? { value: caption.value, source: caption.source } : { value: "", source: "none" },
    hashtags: hashtags ? { value: hashtags.value, source: hashtags.source } : { value: [], source: "none" }
  };
}
function composeCaption(content, maxLength = 2200) {
  const tags = content.hashtags.join(" ");
  const full = [content.caption.trim(), tags].filter(Boolean).join("\n\n");
  if (full.length <= maxLength) return { text: full, truncated: false };
  return { text: full.slice(0, maxLength), truncated: true };
}

// ../../packages/domain/src/scheduling/plan.ts
import { Temporal as Temporal2 } from "npm:temporal-polyfill@1.0.8";
var COMPAT_KEY = {
  instagram: "instagram_reels",
  facebook: "facebook_reels",
  tiktok: "tiktok",
  youtube: "youtube_shorts",
  mock: null
};
function isCompatible(item, platform, provider = "native") {
  if (item.compatibility?.kind === "image" && platform !== "mock" && provider !== "zernio") return false;
  const key = COMPAT_KEY[platform];
  if (!key) return true;
  const status = item.compatibility?.platforms?.[key]?.status;
  return status !== "error";
}
function shift(iso, minutes, timezone) {
  if (!minutes) return null;
  const z3 = Temporal2.Instant.from(iso).add({ minutes }).toZonedDateTimeISO(timezone);
  return {
    scheduledAt: z3.toInstant().toString(),
    localDate: z3.toPlainDate().toString(),
    localTime: `${String(z3.hour).padStart(2, "0")}:${String(z3.minute).padStart(2, "0")}`
  };
}
var later = (a, b) => b && b.getTime() > a.getTime() ? b : a;
function buildPlan(input) {
  const maxJobs = input.maxJobs ?? 5e3;
  const jobs = [];
  const skipped = [];
  if (input.mode === "mirrored") {
    const notBefore = input.targets.reduce((acc, t) => later(acc, input.notBeforeByTarget?.[t.targetId]), input.notBefore);
    const slots = generateSlots(input.rule, { notBefore, limit: input.media.length });
    input.media.forEach((item, i) => {
      const slot = slots[i];
      for (const t of input.targets) {
        if (!slot) {
          skipped.push({ mediaId: item.mediaId, name: item.name, targetId: t.targetId, reason: "no_slot" });
          continue;
        }
        if (!isCompatible(item, t.platform, t.provider)) {
          skipped.push({ mediaId: item.mediaId, name: item.name, targetId: t.targetId, reason: "incompatible" });
          continue;
        }
        const s = shift(slot.scheduledAt, t.offsetMinutes, input.rule.timezone);
        jobs.push({
          campaignMediaId: item.campaignMediaId,
          mediaId: item.mediaId,
          targetId: t.targetId,
          accountId: t.accountId,
          localDate: s?.localDate ?? slot.localDate,
          localTime: s?.localTime ?? slot.localTime,
          timezone: input.rule.timezone,
          scheduledAt: s?.scheduledAt ?? slot.scheduledAt,
          dstAdjusted: slot.dstAdjusted,
          postGroupKey: `${slot.scheduledAt}`
        });
      }
    });
  } else {
    for (const t of input.targets) {
      const rule = t.rule ?? input.rule;
      const mine = input.media.filter((m) => m.targetId === t.targetId);
      const usable = [];
      for (const m of mine) {
        if (isCompatible(m, t.platform, t.provider)) usable.push(m);
        else skipped.push({ mediaId: m.mediaId, name: m.name, targetId: t.targetId, reason: "incompatible" });
      }
      const slots = generateSlots(rule, { notBefore: later(input.notBefore, input.notBeforeByTarget?.[t.targetId]), limit: usable.length });
      usable.forEach((m, i) => {
        const slot = slots[i];
        if (!slot) {
          skipped.push({ mediaId: m.mediaId, name: m.name, targetId: t.targetId, reason: "no_slot" });
          return;
        }
        const s = shift(slot.scheduledAt, t.offsetMinutes, rule.timezone);
        jobs.push({
          campaignMediaId: m.campaignMediaId,
          mediaId: m.mediaId,
          targetId: t.targetId,
          accountId: t.accountId,
          localDate: s?.localDate ?? slot.localDate,
          localTime: s?.localTime ?? slot.localTime,
          timezone: rule.timezone,
          scheduledAt: s?.scheduledAt ?? slot.scheduledAt,
          dstAdjusted: slot.dstAdjusted,
          postGroupKey: null
        });
      });
    }
  }
  jobs.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.targetId.localeCompare(b.targetId));
  const truncated = jobs.length > maxJobs;
  return { jobs: truncated ? jobs.slice(0, maxJobs) : jobs, skipped, truncated };
}

// ../../packages/domain/src/scheduling/job-state.ts
function publicationBackoffSeconds(attempt, opts = {}) {
  if (opts.retryAfterSeconds && opts.retryAfterSeconds > 0) return Math.min(24 * 3600, Math.ceil(opts.retryAfterSeconds));
  const base = Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));
  const r = opts.random ?? Math.random;
  return Math.round(base * (0.8 + r() * 0.4));
}
var RECONCILE_MAX_ATTEMPTS = 30;
function reconcileDelaySeconds(attemptsDone) {
  return Math.min(3600, 30 * 2 ** Math.max(0, attemptsDone));
}

// ../../packages/domain/src/editorial/layout.ts
var CARD_FORMATS = {
  feed: { width: 1080, height: 1350, label: "Feed 4:5 (1080\xD71350)" },
  square: { width: 1080, height: 1080, label: "Quadrado 1:1 (1080\xD71080)" },
  vertical: { width: 1080, height: 1920, label: "Vertical 9:16 (1080\xD71920)" }
};
var CARD_FORMAT_KEYS = Object.keys(CARD_FORMATS);

// src/publishing/rules.ts
var RULE_DEFAULTS = {
  append_from_collection: { enabled: true, params: {} },
  retry_transient: { enabled: true, params: { max_attempts: 6 } },
  low_content_alert: { enabled: true, params: { days: 3 } },
  complete_campaign: { enabled: true, params: {} },
  pause_on_auth_loss: { enabled: true, params: {} }
};
async function getRule(db, workspaceId, key) {
  const r = await db.query(
    "select enabled, params from public.automation_rules where workspace_id = $1 and rule_key = $2",
    [workspaceId, key]
  );
  const row = r.rows[0];
  return { enabled: row?.enabled ?? RULE_DEFAULTS[key].enabled, params: { ...RULE_DEFAULTS[key].params, ...row?.params ?? {} } };
}
async function recordRun(db, run2) {
  const r = await db.query(
    `insert into public.automation_runs (workspace_id, rule_key, subject_type, subject_id, outcome, details, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dedupe_key) do nothing`,
    [run2.workspaceId, run2.rule, run2.subjectType, run2.subjectId, run2.outcome, JSON.stringify(run2.details ?? {}), run2.dedupeKey ?? null]
  );
  return r.rowCount === 1;
}
async function notify(db, workspaceId, userIds, type, payload) {
  const ids = [...new Set(userIds.filter((u) => Boolean(u)))];
  for (const uid of ids) {
    await db.query(
      `insert into public.notifications (workspace_id, user_id, type, payload)
       select $1, $2, $3, $4 where exists (select 1 from public.workspace_members where workspace_id = $1 and user_id = $2)`,
      [workspaceId, uid, type, JSON.stringify(payload)]
    );
  }
}
async function workspaceAdmins(db, workspaceId) {
  const r = await db.query(
    "select user_id from public.workspace_members where workspace_id = $1 and role in ('admin', 'owner')",
    [workspaceId]
  );
  return r.rows.map((x) => x.user_id);
}

// src/publishing/automations.ts
var PENDING = "('draft','scheduled','queued','preparing','uploading','processing_remote','publishing','failed_retryable','uncertain','needs_review')";
async function appendFromCollections(db, log, now = /* @__PURE__ */ new Date()) {
  const { rows: campaigns } = await db.query(
    `select id, workspace_id, name, mode, timezone, weekdays, times, start_date::text, end_date::text, source_collection_id, created_by
       from public.campaigns where status = 'active' and source_collection_id is not null`
  );
  let total = 0;
  for (const c of campaigns) {
    if (!(await getRule(db, c.workspace_id, "append_from_collection")).enabled) continue;
    const targets = (await db.query(
      `select t.id, t.social_account_id, a.platform, t.offset_minutes, t.weekdays, t.times
           from public.campaign_targets t join public.social_accounts a on a.id = t.social_account_id
          where t.campaign_id = $1 and t.enabled`,
      [c.id]
    )).rows;
    if (!targets.length) continue;
    const fresh = (await db.query(
      `select m.id, m.name, m.compatibility from public.collection_items ci
           join public.media_assets m on m.id = ci.media_asset_id
          where ci.collection_id = $1 and m.status = 'ready' and m.deleted_at is null
            and not exists (select 1 from public.campaign_media cm where cm.campaign_id = $2 and cm.media_asset_id = m.id)
          order by ci.position, m.created_at`,
      [c.source_collection_id, c.id]
    )).rows;
    if (!fresh.length) continue;
    const maxPos = (await db.query("select coalesce(max(position), -1) as p from public.campaign_media where campaign_id = $1", [c.id])).rows[0].p;
    const items = [];
    let pos = maxPos + 1;
    for (const m of fresh) {
      const perTarget = c.mode === "independent" ? targets.map((t) => t.id) : [null];
      for (const targetId of perTarget) {
        const r = await db.query(
          "insert into public.campaign_media (campaign_id, workspace_id, media_asset_id, target_id, position) values ($1, $2, $3, $4, $5) returning id",
          [c.id, c.workspace_id, m.id, targetId, pos]
        );
        items.push({ campaignMediaId: r.rows[0].id, mediaId: m.id, name: m.name, compatibility: m.compatibility, targetId });
      }
      pos++;
    }
    const last = await db.query(
      `select target_id, max(scheduled_at) as at from public.publication_jobs
        where campaign_id = $1 and status <> 'cancelled' group by target_id`,
      [c.id]
    );
    const notBeforeByTarget = Object.fromEntries(last.rows.map((r) => [r.target_id, r.at]));
    const rule = { timezone: c.timezone, weekdays: c.weekdays, times: c.times, startDate: c.start_date, endDate: c.end_date };
    const planTargets = targets.map((t) => ({
      targetId: t.id,
      accountId: t.social_account_id,
      platform: t.platform,
      offsetMinutes: t.offset_minutes,
      rule: t.weekdays && t.times ? { ...rule, weekdays: t.weekdays, times: t.times } : void 0
    }));
    const plan = buildPlan({
      mode: c.mode,
      rule,
      targets: planTargets,
      media: items,
      notBefore: new Date(now.getTime() + 5 * 6e4),
      notBeforeByTarget
    });
    let inserted = 0;
    for (const j of plan.jobs) {
      const r = await db.query(
        `insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id,
                                              post_group_key, local_date, local_time, timezone, scheduled_at, dst_adjusted, status, next_attempt_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled', $11)
         on conflict (campaign_id, target_id, media_asset_id) where status <> 'cancelled' do nothing`,
        [c.workspace_id, c.id, j.campaignMediaId, j.targetId, j.accountId, j.mediaId, j.postGroupKey, j.localDate, j.localTime, j.timezone, j.scheduledAt, j.dstAdjusted]
      );
      inserted += r.rowCount ?? 0;
    }
    await recordRun(db, {
      workspaceId: c.workspace_id,
      rule: "append_from_collection",
      subjectType: "campaign",
      subjectId: c.id,
      outcome: "appended",
      details: { videos: fresh.length, publications: inserted, skipped: plan.skipped.length }
    });
    log.info("automation append", { campaign_id: c.id, videos: fresh.length, publications: inserted });
    total += inserted;
  }
  return total;
}
async function lowContentAlerts(db, now = /* @__PURE__ */ new Date()) {
  const { rows } = await db.query(
    `select c.id, c.workspace_id, c.name, c.created_by, c.end_date::text,
            (select max(j.scheduled_at) from public.publication_jobs j where j.campaign_id = c.id and j.status in ('scheduled','queued')) as last_at
       from public.campaigns c where c.status = 'active'`
  );
  let sent = 0;
  for (const c of rows) {
    const rule = await getRule(db, c.workspace_id, "low_content_alert");
    if (!rule.enabled) continue;
    const days = Number(rule.params.days) || 3;
    const horizon = now.getTime() + days * 864e5;
    if (c.end_date && Date.parse(`${c.end_date}T23:59:59Z`) < horizon) continue;
    if (c.last_at && c.last_at.getTime() >= horizon) continue;
    const fresh = await recordRun(db, {
      workspaceId: c.workspace_id,
      rule: "low_content_alert",
      subjectType: "campaign",
      subjectId: c.id,
      outcome: "notified",
      details: { days, last_scheduled_at: c.last_at },
      dedupeKey: `low_content:${c.id}:${now.toISOString().slice(0, 10)}`
    });
    if (fresh) {
      await notify(db, c.workspace_id, [c.created_by], "queue.low", { campaign_id: c.id, campaign: c.name, days, last_scheduled_at: c.last_at });
      sent++;
    }
  }
  return sent;
}
async function completeCampaigns(db, now = /* @__PURE__ */ new Date()) {
  const { rows } = await db.query(
    `select c.id, c.workspace_id, c.name, c.created_by from public.campaigns c
      where c.status = 'active'
        and exists (select 1 from public.publication_jobs j where j.campaign_id = c.id)
        and not exists (select 1 from public.publication_jobs j where j.campaign_id = c.id and j.status in ${PENDING})
        and (c.source_collection_id is null or (c.end_date is not null and c.end_date < ($1::timestamptz at time zone c.timezone)::date))`,
    [now.toISOString()]
  );
  let done2 = 0;
  for (const c of rows) {
    if (!(await getRule(db, c.workspace_id, "complete_campaign")).enabled) continue;
    const summary = (await db.query("select status::text, count(*)::int as n from public.publication_jobs where campaign_id = $1 group by status", [c.id])).rows.reduce((acc, r2) => ({ ...acc, [r2.status]: r2.n }), {});
    const r = await db.query("update public.campaigns set status = 'completed', completed_at = now(), summary = $2 where id = $1 and status = 'active'", [c.id, JSON.stringify(summary)]);
    if (r.rowCount !== 1) continue;
    await recordRun(db, { workspaceId: c.workspace_id, rule: "complete_campaign", subjectType: "campaign", subjectId: c.id, outcome: "completed", details: summary });
    await notify(db, c.workspace_id, [c.created_by], "campaign.completed", { campaign_id: c.id, campaign: c.name, summary });
    done2++;
  }
  return done2;
}

// src/publishing/execute.ts
var LeaseLost = class extends Error {
};
var NO_ATTEMPT_WAIT_CODES = /* @__PURE__ */ new Set(["ig_processing", "zernio_processing", "zernio_not_configured", "zernio_api_key", "zernio_payment_required"]);
var SERVER_CONFIG_CODES = {
  zernio_not_configured: "A chave da Zernio n\xE3o est\xE1 configurada no worker; publica\xE7\xF5es via Zernio est\xE3o em espera.",
  zernio_api_key: "A Zernio recusou a chave do servidor (inv\xE1lida ou revogada); publica\xE7\xF5es via Zernio est\xE3o em espera.",
  zernio_payment_required: "A Zernio exige pagamento/upgrade do plano; publica\xE7\xF5es via Zernio est\xE3o em espera."
};
var ZERNIO_MEDIA_URL_TTL = 24 * 3600;
var accountInput = (a) => ({
  id: a.id,
  platform: a.platform,
  externalAccountId: a.external_account_id,
  settings: a.settings,
  providerProfileId: a.provider_profile_id ?? null
});
async function loadContext(db, jobId) {
  const { rows } = await db.query(
    `select row_to_json(j.*) as job, row_to_json(a.*) as account, row_to_json(m.*) as media, row_to_json(c.*) as campaign,
            row_to_json(t.*) as target, row_to_json(cm.*) as cm, w.settings as workspace_settings
       from public.publication_jobs j
       join public.workspaces w on w.id = j.workspace_id
       join public.social_accounts a on a.id = j.social_account_id
       left join public.media_assets m on m.id = j.media_asset_id
       left join public.campaigns c on c.id = j.campaign_id
       left join public.campaign_targets t on t.id = j.target_id
       left join public.campaign_media cm on cm.id = j.campaign_media_id
      where j.id = $1`,
    [jobId]
  );
  const r = rows[0];
  return { job: r.job, account: r.account, media: r.media, campaign: r.campaign, target: r.target, cm: r.cm, workspaceSettings: r.workspace_settings ?? {} };
}
function effectiveContent(ctx) {
  const pickStr = (...v) => v.find((x) => typeof x === "string" && x.trim()) ?? null;
  const pickArr = (...v) => v.find((x) => Array.isArray(x) && x.length) ?? null;
  const ws = ctx.workspaceSettings;
  const acc = ctx.account.settings;
  const resolved = resolveContent({
    media: {
      caption: pickStr(ctx.job.caption_override, ctx.cm?.caption_override, ctx.media?.default_caption),
      hashtags: pickArr(ctx.cm?.hashtags_override, ctx.media?.default_hashtags)
    },
    campaign: { caption: pickStr(ctx.target?.caption_override, ctx.campaign?.caption), hashtags: pickArr(ctx.target?.hashtags_override, ctx.campaign?.hashtags) },
    account: { caption: acc.default_caption ?? null, hashtags: acc.default_hashtags ?? null },
    global: { caption: ws.default_caption ?? null, hashtags: ws.default_hashtags ?? null }
  });
  const composed = composeCaption({ caption: resolved.caption.value, hashtags: resolved.hashtags.value });
  return { resolved, composed };
}
async function transition(db, jobId, workerId, set, params) {
  const r = await db.query(`update public.publication_jobs set ${set} where id = $1 and lease_owner = $2`, [jobId, workerId, ...params]);
  if (r.rowCount !== 1) throw new LeaseLost(`lease lost for job ${jobId}`);
}
async function finishAttempt(db, attemptId, fields) {
  await db.query(
    `update public.publication_attempts
        set finished_at = now(), outcome = $2, phase_reached = coalesce($3, phase_reached), error_class = $4, error_code = $5,
            error_message = left($6, 1000), retry_after_seconds = $7, checkpoint = coalesce($8, checkpoint)
      where id = $1`,
    [
      attemptId,
      fields.outcome,
      fields.phase ?? null,
      fields.err?.errorClass ?? null,
      fields.err?.code ?? null,
      fields.err?.message ?? null,
      fields.err?.retryAfterSeconds ?? null,
      fields.checkpoint ? JSON.stringify(fields.checkpoint) : null
    ]
  );
}
async function executePublication(claimed, deps) {
  try {
    return await executeInner(claimed, deps);
  } catch (err) {
    deps.log.error(err instanceof LeaseLost ? "lease lost" : "publication crashed", { job_id: claimed.id, error: String(err) });
    return "aborted";
  }
}
async function executeInner(claimed, deps) {
  const { db, log, workerId } = deps;
  const ctx = await loadContext(db, claimed.id);
  const attempt = await db.query(
    "insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id) values ($1, $2, $3, $4) returning id::text",
    [claimed.id, claimed.workspace_id, claimed.attempt_count, workerId]
  );
  const attemptId = attempt.rows[0].id;
  const owners = [ctx.campaign?.created_by];
  if (!ctx.media || ctx.media.deleted_at || ctx.media.status !== "ready") {
    await transition(db, claimed.id, workerId, "status = 'failed_permanent', lease_owner = null, lease_expires_at = null, last_error_class = 'media_unavailable', last_error_message = 'V\xEDdeo exclu\xEDdo ou indispon\xEDvel.'", []);
    await finishAttempt(db, attemptId, { outcome: "permanent", err: new ConnectorError("permanent", "V\xEDdeo exclu\xEDdo ou indispon\xEDvel.", { code: "media_unavailable" }) });
    await notify(db, claimed.workspace_id, owners, "publication.failed", { job_id: claimed.id, reason: "media_unavailable" });
    return "failed_permanent";
  }
  const { resolved, composed } = effectiveContent(ctx);
  await transition(db, claimed.id, workerId, "effective_config = $3", [
    JSON.stringify({ caption: composed.text, truncated: composed.truncated, sources: { caption: resolved.caption.source, hashtags: resolved.hashtags.source } })
  ]);
  const beat = setInterval(() => {
    db.query("update public.publication_jobs set lease_expires_at = now() + make_interval(secs => $3) where id = $1 and lease_owner = $2", [claimed.id, workerId, deps.leaseSeconds]).catch(() => void 0);
  }, Math.max(1e3, deps.leaseSeconds * 1e3 / 3));
  let checkpoint = ctx.job.external_checkpoint;
  let phase = null;
  let connector;
  try {
    connector = deps.connectors.forAccount(ctx.account);
    const viaZernio = ctx.account.provider === "zernio";
    const credentials = viaZernio ? null : await deps.credentials?.get(ctx.account) ?? null;
    const mediaUrl = ctx.account.platform === "mock" ? null : await deps.mediaUrl?.(ctx.media.storage_path, viaZernio ? ZERNIO_MEDIA_URL_TTL : void 0) ?? null;
    const io = {
      save: async (p, cp) => {
        await transition(db, claimed.id, workerId, "status = $3, external_checkpoint = $4", [p, JSON.stringify(cp)]);
        checkpoint = cp;
        phase = p;
      }
    };
    const result = await connector.publish(
      {
        jobId: claimed.id,
        attemptNo: claimed.attempt_count,
        account: accountInput(ctx.account),
        media: { storagePath: ctx.media.storage_path, mimeType: ctx.media.mime_type, sizeBytes: ctx.media.size_bytes, durationMs: ctx.media.duration_ms, url: mediaUrl },
        caption: composed.text,
        checkpoint,
        credentials
      },
      io
    );
    await markPublished(db, claimed, ctx, result.externalId, result.permalink, "api", workerId);
    await finishAttempt(db, attemptId, { outcome: "published", phase, checkpoint });
    if (ctx.account.provider === "zernio") {
      await db.query("select app.resolve_ops_alert(k) from unnest($1::text[]) k", [Object.keys(SERVER_CONFIG_CODES)]);
    }
    log.info("published", { job_id: claimed.id, attempt: claimed.attempt_count });
    return "published";
  } catch (raw) {
    if (raw instanceof LeaseLost) {
      log.warn("lease lost; abandoning attempt", { job_id: claimed.id });
      await finishAttempt(db, attemptId, { outcome: "aborted", phase, checkpoint });
      return "aborted";
    }
    const err = toConnectorError(raw, checkpoint !== null);
    return await handleFailure(claimed, ctx, err, { attemptId, phase, checkpoint }, deps);
  } finally {
    clearInterval(beat);
  }
}
async function markPublished(db, claimed, ctx, externalId, permalink, source, workerId) {
  const r = await db.query(
    `update public.publication_jobs set status = 'published', published_at = now(), lease_owner = null, lease_expires_at = null,
            last_error_class = null, last_error_message = null
      where id = $1 and lease_owner = $2`,
    [claimed.id, workerId]
  );
  if (r.rowCount !== 1) throw new LeaseLost(`lease lost for job ${claimed.id}`);
  await db.query(
    `insert into public.external_publications (job_id, workspace_id, social_account_id, platform, external_id, permalink, source)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (job_id) do nothing`,
    [claimed.id, claimed.workspace_id, ctx.account.id, ctx.account.platform, externalId, permalink, source]
  );
  await notify(db, claimed.workspace_id, [ctx.campaign?.created_by], "publication.published", {
    job_id: claimed.id,
    media: ctx.media?.name,
    account: ctx.account.display_name,
    permalink
  });
}
async function handleFailure(claimed, ctx, err, a, deps) {
  const { db, workerId, log } = deps;
  const owners = [ctx.campaign?.created_by];
  const clear = "lease_owner = null, lease_expires_at = null, last_error_class = $3, last_error_message = left($4, 1000)";
  const base = [err.errorClass, err.message];
  if ((err.errorClass === "timeout" || err.errorClass === "unknown") && err.sideEffectStarted) {
    await transition(db, claimed.id, workerId, `status = 'uncertain', ${clear}`, base);
    await finishAttempt(db, a.attemptId, { outcome: "uncertain", phase: a.phase, err, checkpoint: a.checkpoint });
    log.warn("publication uncertain", { job_id: claimed.id, error: err.message });
    return "uncertain";
  }
  if (err.errorClass === "auth") {
    const rule2 = await getRule(db, claimed.workspace_id, "pause_on_auth_loss");
    await db.query("update public.social_accounts set status = 'needs_reauth' where id = $1", [ctx.account.id]);
    if (rule2.enabled) {
      await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now(), attempt_count = greatest(attempt_count - 1, 0), ${clear}`, base);
      await recordRun(db, {
        workspaceId: claimed.workspace_id,
        rule: "pause_on_auth_loss",
        subjectType: "social_account",
        subjectId: ctx.account.id,
        outcome: "account_paused",
        dedupeKey: `auth_loss:${ctx.account.id}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 13)}`
      });
    } else {
      await transition(db, claimed.id, workerId, `status = 'failed_permanent', ${clear}`, base);
    }
    await finishAttempt(db, a.attemptId, { outcome: rule2.enabled ? "retry" : "permanent", phase: a.phase, err, checkpoint: a.checkpoint });
    await notify(db, claimed.workspace_id, await workspaceAdmins(db, claimed.workspace_id), "account.disconnected", {
      account_id: ctx.account.id,
      account: ctx.account.display_name
    });
    return rule2.enabled ? "failed_retryable" : "failed_permanent";
  }
  if (err.code && NO_ATTEMPT_WAIT_CODES.has(err.code)) {
    const delay = Math.max(30, err.retryAfterSeconds ?? 60);
    if (SERVER_CONFIG_CODES[err.code]) {
      await db.query("select app.raise_ops_alert($1, 'critical', null, $2, $3::jsonb, $1)", [
        err.code,
        SERVER_CONFIG_CODES[err.code],
        JSON.stringify({ last_job_id: claimed.id, provider_message: err.message.slice(0, 200) })
      ]);
      log.error("server configuration problem; publication waiting", { job_id: claimed.id, code: err.code });
    }
    await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now() + make_interval(secs => $5), attempt_count = greatest(attempt_count - 1, 0), ${clear}`, [...base, delay]);
    await finishAttempt(db, a.attemptId, { outcome: "retry", phase: a.phase, err, checkpoint: a.checkpoint });
    log.info("publication waiting for remote processing", { job_id: claimed.id, delay_s: delay });
    return "failed_retryable";
  }
  const retryable = err.errorClass === "transient" || err.errorClass === "rate_limited" || err.errorClass === "timeout" || err.errorClass === "unknown";
  const rule = await getRule(db, claimed.workspace_id, "retry_transient");
  const maxAttempts = rule.enabled ? Math.min(claimed.max_attempts, Number(rule.params.max_attempts) || claimed.max_attempts) : 1;
  if (retryable && claimed.attempt_count < maxAttempts) {
    const delay = publicationBackoffSeconds(claimed.attempt_count, { retryAfterSeconds: err.retryAfterSeconds });
    await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now() + make_interval(secs => $5), ${clear}`, [...base, delay]);
    await finishAttempt(db, a.attemptId, { outcome: "retry", phase: a.phase, err, checkpoint: a.checkpoint });
    log.warn("publication retry scheduled", { job_id: claimed.id, attempt: claimed.attempt_count, delay_s: delay, error_class: err.errorClass });
    return "failed_retryable";
  }
  await transition(db, claimed.id, workerId, `status = 'failed_permanent', ${clear}`, base);
  await finishAttempt(db, a.attemptId, { outcome: "permanent", phase: a.phase, err, checkpoint: a.checkpoint });
  await notify(db, claimed.workspace_id, owners, "publication.failed", { job_id: claimed.id, reason: err.code ?? err.errorClass, message: err.message });
  log.error("publication failed permanently", { job_id: claimed.id, error_class: err.errorClass, attempts: claimed.attempt_count });
  return "failed_permanent";
}
async function reconcileUncertain(deps, limit = 20, minAgeSeconds = 30) {
  const { db, log, workerId } = deps;
  const { rows } = await db.query(
    `update public.publication_jobs j set lease_owner = $3, lease_expires_at = now() + interval '2 minutes'
      where j.id in (
        select id from public.publication_jobs
         where status = 'uncertain' and updated_at < now() - make_interval(secs => $2)
           and (reconcile_attempts = 0 or next_attempt_at <= now())
           and (lease_expires_at is null or lease_expires_at < now())
         order by updated_at limit $1 for update skip locked)
     returning j.id, j.workspace_id, j.external_checkpoint, j.reconcile_attempts`,
    [limit, minAgeSeconds, workerId]
  );
  for (const j of rows) {
    const ctx = await loadContext(db, j.id);
    const attemptNo = j.reconcile_attempts + 1;
    const att = await db.query(
      "insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id, kind) values ($1, $2, $3, $4, 'reconcile') returning id::text",
      [j.id, j.workspace_id, attemptNo, workerId]
    );
    const unlock = "lease_owner = null, lease_expires_at = null, reconcile_attempts = $3";
    const release = `${unlock}, next_attempt_at = now() + make_interval(secs => ${reconcileDelaySeconds(attemptNo)})`;
    let state;
    try {
      const status = j.external_checkpoint ? await deps.connectors.forAccount(ctx.account).getStatus(
        accountInput(ctx.account),
        j.external_checkpoint,
        ctx.account.provider === "zernio" ? null : await deps.credentials?.get(ctx.account) ?? null
      ) : { state: "not_found" };
      state = status.state;
      if (status.state === "published") {
        await db.query("update public.publication_jobs set reconcile_attempts = $3 where id = $1 and lease_owner = $2", [j.id, workerId, attemptNo]);
        await markPublished(db, { id: j.id, workspace_id: j.workspace_id }, ctx, status.externalId, status.permalink, "reconciled", workerId);
      } else if (status.state === "not_found") {
        await db.query(
          `update public.publication_jobs set status = 'failed_retryable', external_checkpoint = null, ${unlock}, next_attempt_at = now()
            where id = $1 and lease_owner = $2`,
          [j.id, workerId, attemptNo]
        );
      } else if (attemptNo >= RECONCILE_MAX_ATTEMPTS) {
        await db.query(
          `update public.publication_jobs set status = 'needs_review', review_reason = 'uncertain_unresolved', ${release}
            where id = $1 and lease_owner = $2`,
          [j.id, workerId, attemptNo]
        );
        await notify(db, j.workspace_id, [ctx.campaign?.created_by], "publication.needs_review", { job_id: j.id, reason: "uncertain_unresolved" });
      } else {
        await db.query(`update public.publication_jobs set ${release} where id = $1 and lease_owner = $2`, [j.id, workerId, attemptNo]);
        log.info("publication still unconfirmed", { job_id: j.id, check: attemptNo, remote_state: state, next_check_s: reconcileDelaySeconds(attemptNo) });
      }
    } catch (e) {
      state = "error";
      await db.query(`update public.publication_jobs set ${release} where id = $1 and lease_owner = $2`, [j.id, workerId, attemptNo]);
      log.warn("reconcile failed", { job_id: j.id, error: String(e) });
    }
    await db.query("update public.publication_attempts set finished_at = now(), outcome = $2 where id = $1", [
      att.rows[0].id,
      state === "published" ? "published" : state === "not_found" ? "not_found" : "unknown"
    ]);
  }
  return rows.length;
}

// src/publishing/tokens.ts
var REFRESH_WINDOW_DAYS = 15;
var WARN_WINDOW_DAYS = 7;
async function notifyOncePerDay(db, workspaceId, type, accountId, payload) {
  for (const uid of await workspaceAdmins(db, workspaceId)) {
    await db.query(
      `insert into public.notifications (workspace_id, user_id, type, payload)
       select $1, $2, $3, $4::jsonb
        where not exists (select 1 from public.notifications n
                           where n.user_id = $2 and n.type = $3 and n.payload ->> 'account_id' = $5 and n.created_at > now() - interval '1 day')`,
      [workspaceId, uid, type, JSON.stringify({ ...payload, account_id: accountId }), accountId]
    );
  }
}
async function maintainInstagramTokens(db, deps, limit = 5) {
  const expired = await db.query(
    `update public.social_accounts a set status = 'needs_reauth'
       from public.social_account_tokens t
      where t.social_account_id = a.id and t.token_type = 'ig_user' and a.status = 'active' and t.expires_at <= now()
      returning a.id, a.workspace_id, a.display_name`
  );
  for (const a of expired.rows) {
    deps.log.warn("instagram token expired", { account_id: a.id });
    await notifyOncePerDay(db, a.workspace_id, "account.disconnected", a.id, { account: a.display_name, reason: "token_expired" });
  }
  if (!deps.cipher) return { refreshed: 0, failed: 0, expired: expired.rowCount ?? 0 };
  const due = await db.query(
    `update public.social_account_tokens t set last_refresh_attempt_at = now()
       from public.social_accounts a
      where a.id = t.social_account_id
        and t.social_account_id in (
          select t2.social_account_id from public.social_account_tokens t2 join public.social_accounts a2 on a2.id = t2.social_account_id
           where t2.token_type = 'ig_user' and a2.status = 'active' and t2.expires_at > now()
             and t2.expires_at < now() + make_interval(days => $1)
             and t2.issued_at < now() - interval '24 hours'
             and (t2.last_refresh_attempt_at is null or t2.last_refresh_attempt_at < now() - interval '6 hours')
           order by t2.expires_at limit $2)
      returning t.social_account_id, a.workspace_id, a.external_account_id, a.display_name, t.ciphertext, t.iv, t.auth_tag, t.key_version`,
    [REFRESH_WINDOW_DAYS, limit]
  );
  let refreshed = 0;
  let failed = 0;
  for (const row of due.rows) {
    const aad = `instagram:${row.external_account_id}`;
    try {
      const current = deps.cipher.open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag, keyVersion: row.key_version }, aad);
      const next = await refreshInstagramToken(deps.graph, current);
      const profile = await fetchInstagramProfile(deps.graph, next.token);
      if (profile.userId !== row.external_account_id) throw new Error("token renovado pertence a outra conta");
      const sealed = deps.cipher.seal(next.token, aad);
      await db.query(
        `update public.social_account_tokens
            set ciphertext = $2, iv = $3, auth_tag = $4, key_version = $5, expires_at = $6, issued_at = now(), last_refresh_error = null
          where social_account_id = $1`,
        [row.social_account_id, sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyVersion, next.expiresAt]
      );
      await db.query(
        `update public.social_accounts
            set token_expires_at = $2, avatar_url = coalesce($3, avatar_url),
                settings = settings || jsonb_build_object('username', $4::text)
          where id = $1`,
        [row.social_account_id, next.expiresAt, profile.avatarUrl, profile.username]
      );
      refreshed++;
      deps.log.info("instagram token refreshed", { account_id: row.social_account_id });
    } catch (e) {
      failed++;
      const err = classifyMetaError(e, false);
      await db.query("update public.social_account_tokens set last_refresh_error = left($2, 500) where social_account_id = $1", [row.social_account_id, `${err.errorClass}: ${err.message}`]);
      deps.log.warn("instagram token refresh failed", { account_id: row.social_account_id, error_class: err.errorClass });
      if (err.errorClass === "auth") {
        await db.query("update public.social_accounts set status = 'needs_reauth' where id = $1", [row.social_account_id]);
        await notifyOncePerDay(db, row.workspace_id, "account.disconnected", row.social_account_id, { account: row.display_name, reason: "refresh_denied" });
      }
    }
  }
  const warn = await db.query(
    `select a.id, a.workspace_id, a.display_name, t.expires_at
       from public.social_account_tokens t join public.social_accounts a on a.id = t.social_account_id
      where t.token_type = 'ig_user' and a.status = 'active' and t.expires_at > now() and t.expires_at < now() + make_interval(days => $1)`,
    [WARN_WINDOW_DAYS]
  );
  for (const a of warn.rows) {
    await notifyOncePerDay(db, a.workspace_id, "account.token_expiring", a.id, { account: a.display_name, expires_at: a.expires_at });
  }
  return { refreshed, failed, expired: expired.rowCount ?? 0 };
}

// src/publishing/zernio-accounts.ts
var ZERNIO_HEALTH_EVERY_MINUTES = 10;
async function syncZernioAccounts(db, deps) {
  const due = await db.query(
    `select id, workspace_id, external_account_id, status, display_name from public.social_accounts
      where provider = 'zernio' and status in ('active', 'needs_reauth')
        and coalesce((settings ->> 'zernio_checked_at')::timestamptz, 'epoch') < now() - make_interval(mins => $1)`,
    [ZERNIO_HEALTH_EVERY_MINUTES]
  );
  if (!due.rows.length) return { checked: 0, changed: 0 };
  const health = new Map((await deps.zernio.accountsHealth()).map((h) => [h.accountId, h]));
  let changed = 0;
  for (const a of due.rows) {
    const h = health.get(a.external_account_id);
    const healthy = Boolean(h && h.canPost !== false && !h.needsReconnect);
    const next = healthy ? "active" : "needs_reauth";
    await db.query(
      `update public.social_accounts
          set status = $2, settings = settings || jsonb_build_object('zernio_checked_at', now(), 'zernio_health', $3::text)
        where id = $1 and provider = 'zernio'`,
      [a.id, next, h?.status ?? "missing"]
    );
    if (next !== a.status) {
      changed++;
      deps.log.warn("zernio account status changed", { account_id: a.id, from: a.status, to: next });
      if (next === "needs_reauth") {
        for (const uid of await workspaceAdmins(db, a.workspace_id)) {
          await db.query(
            `insert into public.notifications (workspace_id, user_id, type, payload)
             select $1, $2, 'account.disconnected', $3::jsonb
              where not exists (select 1 from public.notifications n where n.user_id = $2 and n.type = 'account.disconnected'
                                  and n.payload ->> 'account_id' = $4 and n.created_at > now() - interval '1 day')`,
            [a.workspace_id, uid, JSON.stringify({ account_id: a.id, account: a.display_name, reason: "zernio_needs_reconnect" }), a.id]
          );
        }
      }
    }
  }
  return { checked: due.rows.length, changed };
}

// src/publishing/scheduler.ts
async function promoteDue(db, prepLeadSeconds = 0) {
  const late = await db.query(
    `update public.publication_jobs j
        set status = 'needs_review', review_reason = 'late'
       from public.campaigns c
      where j.campaign_id = c.id and j.status in ('scheduled', 'queued')
        and c.status = 'active'
        and j.scheduled_at < now() - make_interval(mins => c.max_lateness_minutes)
     returning j.id, j.workspace_id, c.created_by, c.name as campaign_name`
  );
  for (const r of late.rows) {
    await notify(db, r.workspace_id, [r.created_by], "publication.late", { job_id: r.id, campaign: r.campaign_name });
  }
  const promoted = await db.query(
    `update public.publication_jobs j
        set status = 'queued', next_attempt_at = greatest(j.scheduled_at, now())
       from public.campaigns c, public.workspaces w, public.social_accounts a
      where j.campaign_id = c.id and w.id = j.workspace_id and a.id = j.social_account_id
        and j.status = 'scheduled'
        and j.scheduled_at <= now() + make_interval(secs => $1)
        and c.status = 'active' and not w.queue_paused and a.status = 'active' and not a.paused`,
    [prepLeadSeconds]
  );
  return { promoted: promoted.rowCount ?? 0, late: late.rowCount ?? 0 };
}
async function claimPublications(db, workerId, limit, leaseSeconds) {
  const r = await db.query(
    `update public.publication_jobs j
        set status = 'preparing', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
            attempt_count = j.attempt_count + 1
      where j.id in (
        select id from public.publication_jobs
         where id in (
           select id from (
             select j2.id, row_number() over (partition by j2.social_account_id order by j2.scheduled_at, j2.id) as rn
               from public.publication_jobs j2
               join public.social_accounts a on a.id = j2.social_account_id
               join public.workspaces w on w.id = j2.workspace_id
               left join public.campaigns c on c.id = j2.campaign_id
              where j2.status in ('queued', 'failed_retryable') and j2.next_attempt_at <= now()
                and a.status = 'active' and not a.paused and not w.queue_paused
                and (c.id is null or c.status = 'active')
                and not exists (select 1 from public.publication_jobs x
                                 where x.social_account_id = j2.social_account_id
                                   and x.status in ('preparing', 'uploading', 'processing_remote', 'publishing'))
                and not exists (select 1 from public.publication_jobs x
                                 where x.social_account_id = j2.social_account_id and x.status = 'published'
                                   and x.published_at > now() - make_interval(mins => a.min_spacing_minutes))
           ) ranked where rn = 1)
           -- Revalidado no n\xEDvel do lock: se outro worker acabou de reivindicar,
           -- a nova vers\xE3o da linha n\xE3o passa aqui (EvalPlanQual) e \xE9 ignorada.
           and status in ('queued', 'failed_retryable') and next_attempt_at <= now()
         order by scheduled_at
         for update skip locked
         limit $2)
        and j.status in ('queued', 'failed_retryable')
     returning j.id, j.workspace_id, j.campaign_id, j.social_account_id, j.media_asset_id, j.attempt_count, j.max_attempts, j.external_checkpoint`,
    [workerId, limit, leaseSeconds]
  );
  return r.rows;
}
async function reapPublicationLeases(db) {
  const requeued = await db.query(
    `update public.publication_jobs set status = 'queued', lease_owner = null, lease_expires_at = null,
            last_error_class = 'lease_expired'
      where status = 'preparing' and lease_expires_at < now() and external_checkpoint is null`
  );
  const uncertain = await db.query(
    `update public.publication_jobs set status = 'uncertain', lease_owner = null, lease_expires_at = null,
            last_error_class = 'lease_expired'
      where status in ('preparing', 'uploading', 'processing_remote', 'publishing') and lease_expires_at < now()`
  );
  return { requeued: requeued.rowCount ?? 0, uncertain: uncertain.rowCount ?? 0 };
}

// src/handlers/purge.ts
var handlePurge = async (job, { db, storage, log }) => {
  const paths = Array.isArray(job.payload.paths) ? job.payload.paths.filter((p) => typeof p === "string") : [];
  if (job.media_asset_id) {
    const { rows } = await db.query(
      "select deleted_at, status, thumbnail_path from public.media_assets where id = $1",
      [job.media_asset_id]
    );
    const m = rows[0];
    if (m && !m.deleted_at && !job.payload.keep_row && m.status !== "failed") {
      log.info("purge skipped (restored)", { job_id: job.id });
      return;
    }
    if (m?.thumbnail_path && !paths.includes(m.thumbnail_path)) paths.push(m.thumbnail_path);
  }
  if (paths.length) await storage.remove(paths);
  if (job.media_asset_id && !job.payload.keep_row) {
    await db.query("delete from public.media_assets where id = $1 and deleted_at is not null", [job.media_asset_id]);
  }
  log.info("purge done", { job_id: job.id, files: paths.length });
};

// src/handlers/probe.ts
import { mkdtemp, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import path2 from "node:path";

// src/ffmpeg.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var run = promisify(execFile);
async function ffprobeJson(paths, file) {
  const { stdout } = await run(paths.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    timeout: 6e4,
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout);
}
async function makeThumbnail(paths, file, out, durationMs) {
  const seek = Math.max(0, Math.min(1, durationMs / 1e3 * 0.1));
  await run(
    paths.ffmpeg,
    ["-v", "error", "-y", "-ss", seek.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out],
    { timeout: 6e4, maxBuffer: 1024 * 1024 }
  );
}

// src/media/mp4.ts
var MAX_MOOV_BYTES = 32 * 1024 * 1024;
var fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
function* boxes(view, buf, from, to) {
  let off = from;
  while (off + 8 <= to) {
    let size = view.getUint32(off);
    const type = fourcc(buf, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) return;
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header || off + size > to) return;
    yield { type, start: off, headerSize: header, size };
    off += size;
  }
}
var CODECS = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  av01: "av1",
  vp09: "vp9",
  vp08: "vp8",
  mp4v: "mpeg4",
  mp4a: "aac",
  ".mp3": "mp3",
  Opus: "opus",
  "ac-3": "ac3",
  "ec-3": "eac3",
  alac: "alac",
  lpcm: "pcm",
  sowt: "pcm",
  twos: "pcm"
};
function parseTrak(view, buf, box) {
  const t = { handler: "", codec: null, width: 0, height: 0, rotation: 0, timescale: 0, duration: 0, samples: 0, sampleDuration: 0 };
  const walk = (b) => {
    const body = b.start + b.headerSize;
    const end = b.start + b.size;
    switch (b.type) {
      case "mdia":
      case "minf":
      case "stbl":
        for (const c of boxes(view, buf, body, end)) walk(c);
        break;
      case "tkhd": {
        const v = buf[body];
        const m = body + 4 + (v === 1 ? 32 : 20) + 8 + 2 + 2 + 2 + 2;
        const a = view.getInt32(m) / 65536;
        const bb = view.getInt32(m + 4) / 65536;
        t.rotation = (Math.round(Math.atan2(bb, a) * 180 / Math.PI) % 360 + 360) % 360;
        t.width = view.getUint32(m + 36) / 65536;
        t.height = view.getUint32(m + 40) / 65536;
        break;
      }
      case "mdhd": {
        const v = buf[body];
        if (v === 1) {
          t.timescale = view.getUint32(body + 20);
          t.duration = Number(view.getBigUint64(body + 24));
        } else {
          t.timescale = view.getUint32(body + 12);
          t.duration = view.getUint32(body + 16);
        }
        break;
      }
      case "hdlr":
        if (!t.handler) t.handler = fourcc(buf, body + 8);
        break;
      case "stsd": {
        const first = boxes(view, buf, body + 8, end).next();
        if (!first.done) t.codec = CODECS[first.value.type] ?? first.value.type.trim().toLowerCase();
        break;
      }
      case "stts": {
        const n = view.getUint32(body + 4);
        let samples = 0;
        let dur = 0;
        for (let i = 0; i < n && body + 8 + i * 8 + 8 <= end; i++) {
          const count = view.getUint32(body + 8 + i * 8);
          const delta = view.getUint32(body + 12 + i * 8);
          samples += count;
          dur += count * delta;
        }
        t.samples = samples;
        t.sampleDuration = dur;
        break;
      }
    }
  };
  for (const c of boxes(view, buf, box.start + box.headerSize, box.start + box.size)) walk(c);
  return t;
}
async function readMoov(reader) {
  let off = 0;
  for (let guard = 0; off + 8 <= reader.size && guard < 1e3; guard++) {
    const head = await reader.read(off, Math.min(16, reader.size - off));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1 && head.byteLength >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = reader.size - off;
    if (size < 8) break;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) throw new ProbeError("invalid_output");
      return reader.read(off, size);
    }
    off += size;
  }
  throw new ProbeError("invalid_output");
}
async function probeMp4(reader) {
  if (reader.size < 16) throw new ProbeError("invalid_output");
  const first = await reader.read(0, 12);
  const brand = fourcc(first, 4);
  if (!["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"].includes(brand)) throw new ProbeError("invalid_output");
  const moov = await readMoov(reader);
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let movieDuration = 0;
  const tracks = [];
  for (const b of boxes(view, moov, 8, moov.byteLength)) {
    if (b.type === "mvhd") {
      const body = b.start + b.headerSize;
      const v = moov[body];
      const ts = view.getUint32(body + (v === 1 ? 20 : 12));
      const d = v === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
      movieDuration = ts ? d / ts : 0;
    } else if (b.type === "trak") {
      tracks.push(parseTrak(view, moov, b));
    }
  }
  const video = tracks.find((t) => t.handler === "vide" && t.width > 0 && t.height > 0);
  if (!video) throw new ProbeError("no_video_stream");
  const audio = tracks.find((t) => t.handler === "soun");
  const swap = video.rotation === 90 || video.rotation === 270;
  const durationS = movieDuration || (video.timescale ? video.duration / video.timescale : 0);
  const fps = video.sampleDuration && video.timescale ? Math.round(video.samples / (video.sampleDuration / video.timescale) * 1e3) / 1e3 : null;
  const w = Math.round(video.width);
  const h = Math.round(video.height);
  if (w <= 0 || h <= 0) throw new ProbeError("invalid_dimensions");
  return {
    durationMs: Math.round(durationS * 1e3),
    width: swap ? h : w,
    height: swap ? w : h,
    rotation: video.rotation,
    fps,
    videoCodec: video.codec ?? "unknown",
    audioCodec: audio?.codec ?? null,
    hasAudio: Boolean(audio),
    bitrate: durationS > 0 ? Math.round(reader.size * 8 / durationS) : null,
    // Mesma forma do ffprobe: a extensão original desambigua MP4 × MOV na compatibilidade.
    container: "mov,mp4,m4a,3gp,3g2,mj2"
  };
}
async function httpRangeReader(url, fetchImpl = fetch) {
  const head = await fetchImpl(url, { headers: { Range: "bytes=0-0" } });
  const range = head.headers.get("content-range");
  const size = range ? Number(range.split("/")[1]) : Number(head.headers.get("content-length"));
  await head.body?.cancel();
  if (!Number.isFinite(size) || size <= 0) throw new Error("tamanho do arquivo indispon\xEDvel");
  return {
    size,
    async read(offset, length) {
      const res = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`leitura por faixa falhou: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
    }
  };
}
function bufferReader(buf) {
  return { size: buf.byteLength, read: async (o, l) => buf.subarray(o, o + l) };
}

// src/media/image.ts
var ImageProbeError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ImageProbeError";
  }
  code;
};
async function probeJpeg(reader) {
  const head = await reader.read(0, Math.min(reader.size, 2));
  if (head.length < 2 || head[0] !== 255 || head[1] !== 216) throw new ImageProbeError("not_jpeg");
  let pos = 2;
  const limit = Math.min(reader.size, 4 * 1024 * 1024);
  while (pos + 4 <= limit) {
    const m = await reader.read(pos, 4);
    if (m[0] !== 255) throw new ImageProbeError("no_dimensions");
    const marker = m[1];
    if (marker === 216 || marker >= 208 && marker <= 215 || marker === 1 || marker === 255) {
      pos += marker === 255 ? 1 : 2;
      continue;
    }
    const len = m[2] << 8 | m[3];
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      const sof = await reader.read(pos + 4, 5);
      const height = sof[1] << 8 | sof[2];
      const width = sof[3] << 8 | sof[4];
      if (!width || !height) throw new ImageProbeError("no_dimensions");
      return { format: "jpeg", width, height };
    }
    if (marker === 218 || marker === 217 || len < 2) break;
    pos += 2 + len;
  }
  throw new ImageProbeError("no_dimensions");
}

// src/handlers/probe.ts
var PROBE_FAILURE_REASONS = {
  no_video_stream: "invalid_video",
  invalid_output: "invalid_video",
  invalid_dimensions: "invalid_video"
};
var handleProbe = async (job, deps, ctx) => {
  const { db, storage, log } = deps;
  const { rows } = await db.query(
    "select id, workspace_id, uploaded_by, name, storage_path, mime_type, size_bytes::float8 as size_bytes, status, deleted_at from public.media_assets where id = $1",
    [job.media_asset_id]
  );
  const media = rows[0];
  if (!media || media.deleted_at || !["uploaded", "processing"].includes(media.status)) {
    log.info("probe skipped", { job_id: job.id, media_id: job.media_asset_id, status: media?.status ?? "missing" });
    return;
  }
  if (media.status === "uploaded") {
    await db.query("update public.media_assets set status = 'processing' where id = $1", [media.id]);
  }
  const remote = deps.probeMode === "remote";
  if (media.mime_type.startsWith("image/")) return probeImage(deps, media, remote, ctx, job.id);
  const dir = remote ? null : await mkdtemp(path2.join(deps.tmpDir, "rf-probe-"));
  try {
    const ext = path2.extname(media.storage_path).slice(1);
    const local = dir ? path2.join(dir, `original.${ext}`) : "";
    let probe;
    try {
      if (remote) {
        const url = await storage.signedUrl(media.storage_path, 600);
        if (!url) throw new Error("URL tempor\xE1ria do v\xEDdeo indispon\xEDvel");
        probe = await probeMp4(await httpRangeReader(url, deps.fetchImpl));
      } else {
        await storage.download(media.storage_path, local);
        probe = parseFfprobe(await ffprobeJson(deps.ffmpeg, local));
      }
    } catch (err) {
      const permanent = err instanceof ProbeError || err.code === 1;
      if (!permanent) throw err;
      const reason = err instanceof ProbeError ? PROBE_FAILURE_REASONS[err.code] : "invalid_video";
      await markFailed(deps, media, reason);
      log.warn("probe invalid media", { job_id: job.id, media_id: media.id, reason });
      return;
    }
    let thumbPath = thumbnailPathFor(media.storage_path);
    if (remote) {
      if (!await storage.exists(thumbPath)) thumbPath = null;
    } else {
      const thumbLocal = path2.join(dir, "thumb.jpg");
      await makeThumbnail(deps.ffmpeg, local, thumbLocal, probe.durationMs);
      await storage.upload(thumbPath, thumbLocal, "image/jpeg");
    }
    const compat = evaluateCompatibility(probe, ext, Number(media.size_bytes));
    await db.query(
      `update public.media_assets
          set status = 'ready', failure_reason = null, duration_ms = $2, width = $3, height = $4, rotation = $5, fps = $6,
              video_codec = $7, audio_codec = $8, has_audio = $9, bitrate = $10, container = $11,
              thumbnail_path = $12, compatibility = $13, probed_at = now()
        where id = $1 and status = 'processing'`,
      [
        media.id,
        probe.durationMs,
        probe.width,
        probe.height,
        probe.rotation,
        probe.fps,
        probe.videoCodec,
        probe.audioCodec,
        probe.hasAudio,
        probe.bitrate,
        probe.container,
        thumbPath,
        JSON.stringify(compat)
      ]
    );
    await notifyBatchCompleted(deps, media);
    log.info("probe done", { job_id: job.id, media_id: media.id, duration_ms: probe.durationMs });
  } catch (err) {
    if (ctx.isFinalAttempt) await markFailed(deps, media, "processing_error");
    throw err;
  } finally {
    if (dir) await rm2(dir, { recursive: true, force: true });
  }
};
async function probeImage(deps, media, remote, ctx, jobId) {
  const { db, storage, log } = deps;
  let dir = null;
  try {
    let img;
    try {
      if (remote) {
        const url = await storage.signedUrl(media.storage_path, 600);
        if (!url) throw new Error("URL tempor\xE1ria da imagem indispon\xEDvel");
        img = await probeJpeg(await httpRangeReader(url, deps.fetchImpl));
      } else {
        dir = await mkdtemp(path2.join(deps.tmpDir, "rf-probe-"));
        const local = path2.join(dir, "original.jpg");
        await storage.download(media.storage_path, local);
        img = await probeJpeg(bufferReader(new Uint8Array(await readFile2(local))));
      }
    } catch (err) {
      if (!(err instanceof ImageProbeError)) throw err;
      await markFailed(deps, media, "invalid_image");
      log.warn("probe invalid image", { job_id: jobId, media_id: media.id, reason: err.code });
      return;
    }
    const compat = evaluateImageCompatibility(img, Number(media.size_bytes));
    await db.query(
      `update public.media_assets
          set status = 'ready', failure_reason = null, duration_ms = null, width = $2, height = $3, rotation = 0, fps = null,
              video_codec = null, audio_codec = null, has_audio = false, bitrate = null, container = 'jpeg',
              thumbnail_path = $4, compatibility = $5, probed_at = now()
        where id = $1 and status = 'processing'`,
      [media.id, img.width, img.height, media.storage_path, JSON.stringify(compat)]
    );
    await notifyBatchCompleted(deps, media);
    log.info("probe done (image)", { job_id: jobId, media_id: media.id, width: img.width, height: img.height });
  } catch (err) {
    if (ctx.isFinalAttempt) await markFailed(deps, media, "processing_error");
    throw err;
  } finally {
    if (dir) await rm2(dir, { recursive: true, force: true });
  }
}
async function markFailed(deps, media, reason) {
  await deps.db.query(
    "update public.media_assets set status = 'failed', failure_reason = $2 where id = $1 and status in ('uploaded', 'processing')",
    [media.id, reason]
  );
  if (media.uploaded_by) {
    await deps.db.query(
      "insert into public.notifications (workspace_id, user_id, type, payload) values ($1, $2, 'upload.failed', $3)",
      [media.workspace_id, media.uploaded_by, JSON.stringify({ media_id: media.id, name: media.name, reason })]
    );
  }
}
async function notifyBatchCompleted(deps, media) {
  if (!media.uploaded_by) return;
  await deps.db.query(
    `with pending as (
       select 1 from public.media_assets
        where workspace_id = $1 and uploaded_by = $2 and deleted_at is null
          and status in ('uploading', 'uploaded', 'processing')
        limit 1),
     last_notice as (
       select max(created_at) as at from public.notifications
        where workspace_id = $1 and user_id = $2 and type = 'upload.completed'),
     done as (
       select count(*)::int as n from public.media_assets, last_notice
        where workspace_id = $1 and uploaded_by = $2 and status = 'ready' and deleted_at is null
          and probed_at > coalesce(last_notice.at, '-infinity'))
     insert into public.notifications (workspace_id, user_id, type, payload)
     select $1, $2, 'upload.completed', jsonb_build_object('count', done.n)
       from done
      where not exists (select 1 from pending) and done.n > 0`,
    [media.workspace_id, media.uploaded_by]
  );
}

// src/maintenance.ts
async function expireStaleUploads(db, storage, log) {
  const { rows } = await db.query(
    `select id, workspace_id, storage_path from public.media_assets
      where status = 'uploading' and upload_expires_at < now()
      order by upload_expires_at limit 100`
  );
  for (const m of rows) {
    if (await storage.exists(m.storage_path)) {
      await db.query(
        "insert into public.media_jobs (workspace_id, kind, payload) values ($1, 'purge', jsonb_build_object('paths', jsonb_build_array($2::text)))",
        [m.workspace_id, m.storage_path]
      );
    }
    await db.query("delete from public.media_assets where id = $1 and status = 'uploading'", [m.id]);
  }
  if (rows.length) log.info("expired stale uploads", { count: rows.length });
  return rows.length;
}
async function processStorageGc(db, storage, log) {
  const { rows } = await db.query(
    "select id::text, prefix from public.storage_gc where done_at is null order by created_at limit 10"
  );
  for (const row of rows) {
    try {
      const files = await storage.list(row.prefix);
      if (files.length) await storage.remove(files);
      await db.query("update public.storage_gc set done_at = now(), last_error = null where id = $1", [row.id]);
      log.info("storage gc done", { gc_id: row.id, files: files.length });
    } catch (err) {
      await db.query("update public.storage_gc set last_error = left($2, 500) where id = $1", [row.id, String(err)]);
      log.error("storage gc failed", { gc_id: row.id, error: String(err) });
    }
  }
  return rows.length;
}

// src/queue.ts
async function claimJobs(db, workerId, limit, leaseSeconds) {
  const { rows } = await db.query(
    `update public.media_jobs j
        set status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
            attempts = j.attempts + 1
      where j.id in (
        select id from public.media_jobs
         where status = 'queued' and run_after <= now()
         order by run_after, id
         for update skip locked
         limit $2)
     returning j.id::text, j.workspace_id, j.media_asset_id, j.kind, j.payload, j.attempts, j.max_attempts`,
    [workerId, limit, leaseSeconds]
  );
  return rows;
}
async function heartbeat(db, jobId, workerId, leaseSeconds) {
  const r = await db.query(
    `update public.media_jobs set lease_expires_at = now() + make_interval(secs => $3)
      where id = $1 and lease_owner = $2 and status = 'running'`,
    [jobId, workerId, leaseSeconds]
  );
  return r.rowCount === 1;
}
async function completeJob(db, jobId, workerId) {
  await db.query(
    `update public.media_jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, last_error = null
      where id = $1 and lease_owner = $2`,
    [jobId, workerId]
  );
}
function backoffSeconds(attempt, random = Math.random) {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}
async function failJob(db, job, workerId, error) {
  const final = job.attempts >= job.max_attempts;
  await db.query(
    `update public.media_jobs
        set status = $3, lease_owner = null, lease_expires_at = null, last_error = left($4, 1000),
            run_after = case when $3 = 'queued' then now() + make_interval(secs => $5) else run_after end
      where id = $1 and lease_owner = $2`,
    [job.id, workerId, final ? "failed" : "queued", error, backoffSeconds(job.attempts)]
  );
  return final;
}
async function reapExpiredLeases(db) {
  const r = await db.query(
    `update public.media_jobs
        set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
            last_error = coalesce(last_error, '') || case when last_error is null then '' else ' | ' end || 'lease expired',
            lease_owner = null, lease_expires_at = null
      where status = 'running' and lease_expires_at < now()`
  );
  return r.rowCount ?? 0;
}

// src/worker.ts
var HANDLERS = { probe: handleProbe, purge: handlePurge };
async function runJob(job, deps, opts) {
  const log = deps.log;
  const beat = setInterval(() => {
    heartbeat(deps.db, job.id, opts.workerId, opts.leaseSeconds).catch((e) => log.warn("heartbeat failed", { job_id: job.id, error: String(e) }));
  }, Math.max(1e3, opts.leaseSeconds * 1e3 / 3));
  try {
    await HANDLERS[job.kind](job, deps, { isFinalAttempt: job.attempts >= job.max_attempts });
    await completeJob(deps.db, job.id, opts.workerId);
  } catch (err) {
    const final = await failJob(deps.db, job, opts.workerId, err instanceof Error ? err.message : String(err));
    log[final ? "error" : "warn"]("job failed", { job_id: job.id, kind: job.kind, attempt: job.attempts, final, error: String(err) });
  } finally {
    clearInterval(beat);
  }
}
async function tick(deps, opts, state) {
  const now = Date.now();
  if (now - state.lastMaintenance >= (opts.maintenanceEveryMs ?? 6e4)) {
    state.lastMaintenance = now;
    await reapExpiredLeases(deps.db);
    await reapPublicationLeases(deps.db);
    await expireStaleUploads(deps.db, deps.storage, deps.log);
    await processStorageGc(deps.db, deps.storage, deps.log);
    if (deps.connectors) {
      await appendFromCollections(deps.db, deps.log);
      await lowContentAlerts(deps.db);
      await completeCampaigns(deps.db);
    }
    if (deps.zernio) {
      try {
        await syncZernioAccounts(deps.db, { zernio: deps.zernio, log: deps.log });
      } catch (e) {
        deps.log.error("zernio account sync failed", { error: String(e) });
      }
    }
    if (deps.instagramTokens) {
      try {
        await maintainInstagramTokens(deps.db, { ...deps.instagramTokens, log: deps.log });
      } catch (e) {
        deps.log.error("instagram token maintenance failed", { error: String(e) });
      }
    }
    if (deps.email) {
      try {
        await deliverEmails(deps.db, { sender: deps.email.sender, appUrl: deps.email.appUrl, log: deps.log });
      } catch (e) {
        deps.log.error("email delivery step failed", { error: String(e) });
      }
    }
    await deps.db.query(
      `insert into public.worker_heartbeats (worker_id, kind, last_seen_at) values ($1, 'worker', now())
       on conflict (worker_id) do update set last_seen_at = now()`,
      [opts.workerId]
    );
  }
  const jobs = await claimJobs(deps.db, opts.workerId, opts.concurrency, opts.leaseSeconds);
  await Promise.all(jobs.map((j) => runJob(j, deps, opts)));
  let processed = jobs.length;
  if (deps.connectors) {
    const pub = {
      db: deps.db,
      connectors: deps.connectors,
      log: deps.log,
      workerId: opts.workerId,
      leaseSeconds: opts.leaseSeconds,
      credentials: deps.credentials,
      mediaUrl: deps.mediaUrl
    };
    await promoteDue(deps.db);
    const claimed = await claimPublications(deps.db, opts.workerId, opts.concurrency, opts.leaseSeconds);
    await Promise.all(claimed.map((c) => executePublication(c, pub)));
    processed += claimed.length;
    processed += await reconcileUncertain(pub, 20, opts.reconcileMinAgeSeconds ?? 30);
  }
  return processed;
}

// src/edge.ts
async function runEdgeTick(env, postgres, invocationId) {
  const log = createLogger({ service: "reelsflow-worker-edge", invocation: invocationId }, (l) => console.log(l));
  const db = postgresJsDb(postgres(env.databaseUrl, { ...POSTGRES_JS_OPTIONS, max: 4 }));
  const storage = new SupabaseStorage(env.supabaseUrl, env.serviceRoleKey);
  const graph = new GraphClient({ version: env.graphVersion });
  const connectors = new ConnectorRegistry().register(new InstagramConnector(graph, { pollIntervalMs: 1e4, pollBudgetMs: 4e4 })).register(new FacebookConnector(graph));
  if (env.simulatedAccounts !== false) connectors.register(new MockConnector(new PgMockStore(db)));
  const zernio = env.zernioApiKey ? new ZernioClient({ apiKey: env.zernioApiKey }) : null;
  if (zernio) connectors.register(new ZernioConnector(zernio, { pollBudgetMs: 4e4, pollIntervalMs: 1e4 }));
  let cipher = null;
  if (env.tokenEncryptionKey) {
    try {
      cipher = TokenCipher.fromEnv({ TOKEN_ENCRYPTION_KEY: env.tokenEncryptionKey });
    } catch (e) {
      log.warn("token cipher invalid; real publications will wait", { error: String(e) });
    }
  }
  const opts = {
    workerId: "edge-worker",
    concurrency: 3,
    // Lease curto: se a função for encerrada pelo limite de tempo, o reaper devolve o job logo.
    leaseSeconds: 120,
    pollMs: 0,
    maintenanceEveryMs: 0
  };
  const started = Date.now();
  try {
    const processed = await tick(
      {
        db,
        storage,
        log,
        connectors,
        credentials: new PgCredentialProvider(db, cipher),
        instagramTokens: { cipher, graph },
        zernio,
        mediaUrl: (p, ttl) => storage.signedUrl(p, ttl ?? 2 * 3600),
        ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" },
        tmpDir: "/tmp",
        probeMode: "remote",
        email: { sender: env.resendApiKey && env.emailFrom ? new ResendSender({ apiKey: env.resendApiKey, from: env.emailFrom }) : null, appUrl: env.appUrl ?? null }
      },
      opts,
      { lastMaintenance: 0 }
    );
    log.info("tick done", { processed, ms: Date.now() - started, zernio_configured: zernio !== null, email_configured: Boolean(env.resendApiKey && env.emailFrom) });
    return { processed, ms: Date.now() - started };
  } finally {
    await db.end();
  }
}
export {
  runEdgeTick
};
