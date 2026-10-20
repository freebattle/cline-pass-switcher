// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { name, key, enabled } —— Cline Pass 账号池：启用的账号按请求轮询
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/deepseek-v4.1-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstreams: string[]（有序优先列表，空=自动）, exclude: string[]（排除列表，优先级高于勾选）,
  //              pinMode: 'strict'|'preferred', sort: 'cost'|'ttft'|'tps'|null, retries: 1..5（每个渠道的尝试次数）,
  //              officialOnly: boolean（只使用命中官方渠道的 key）, officialProviders: string[]（官方渠道 slug，空=按 canonicalSlug 自动推断） }
  // 请求按 upstreams 顺序逐个钉住尝试：同一渠道先重试 retries 次（默认 1 = 不重试），仍失败才顺切下一个，
  // 全部失败才把最后一个错误透传给客户端；exclude 中的上游永不被使用（自动模式下注入排除偏好）。
  // 确定性错误（不可钉 / key 失效）不浪费重试次数，直接跳到下一个渠道。
  // upstream 为旧版单上游兼容镜像（取列表第一个），maxRetries 已退役（旧值仅作回滚兼容保留在文件里）。
  // officialOnly：同一模型在不同 key 下可能命中不同上游（例如官方 deepseek vs 第三方/私有渠道），
  // 开启后只在「探测到可命中官方渠道」的 key 之间轮询；其余 key 跳过并限频复检是否恢复，另有定时全量检测兜底。
  perModel: {},
  hiddenModels: [],       // 控制台仅隐藏的前端模型 ID（纯展示偏好：不影响代理路由，/v1/models 仍照常返回）
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null, quota: {} });
if (!META.quota) META.quota = {};
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const saveMeta = () => fs.writeFileSync(META_PATH, JSON.stringify(META, null, 2));
// 旧版单 apiKey 迁移为账号池
if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
  config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
  saveConfig();
}
// 旧版账号策略字段（单账号 / 会话粘性）已退役：现在固定为「启用的账号按请求轮询」。
(function dropLegacyAccountPolicy() {
  let dirty = false;
  for (const k of ['accountMode', 'activeAccount', 'stickyAccount']) {
    if (k in config) { delete config[k]; dirty = true; }
  }
  if (dirty) saveConfig();
})();

// perModel 配置升级：旧版单 upstream 迁移为有序多上游列表（upstream 保留为回滚兼容镜像）
(function migratePerModel() {
  let dirty = false;
  for (const c of Object.values(config.perModel || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.upstreams === undefined) { c.upstreams = c.upstream ? [c.upstream] : []; dirty = true; }
    if (c.exclude === undefined) { c.exclude = []; dirty = true; }
    if (!Array.isArray(c.upstreams)) { c.upstreams = []; dirty = true; }
    if (!Array.isArray(c.exclude)) { c.exclude = []; dirty = true; }
  }
  if (dirty) saveConfig();
})();

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [{ name: 'env-account', key: k, enabled: true }, ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

// 账号选择：只做一件事——在启用的账号之间按请求轮询。
// 不提供会话粘性，也不做加权 / 最少使用数之类的负载均衡：每次请求取下一个启用账号。
//
// 例外是「按模型的官方渠道过滤」：某些模型（如 deepseek-v4.1-flash）在不同 key 下会被网关
// 路由到不同上游——有的 key 走官方 deepseek，有的走第三方/私有渠道。开启 perModel[model].officialOnly 后，
// 只在使用「已知能命中官方渠道」的 key；其余 key 在轮询到它时跳过，并顺带发起一次限频恢复探测
// （看它是否已恢复成官方渠道），此外还有定时全量检测。
let RR_COUNTER = 0;
function enabledAccounts() {
  return (config.accounts || []).filter((a) => a && a.key && a.enabled !== false);
}

// 每模型 × 每 key 的实际路由结果存在 META.models[model].keyRouting（以 key 的 SHA-256 指纹为键，不落明文）。
const ACCOUNT_ROUTE_REFRESH_MINUTES = Number(process.env.ACCOUNT_ROUTE_REFRESH_MINUTES ?? 15);
const ACCOUNT_ROUTE_RECOVERY_SECONDS = Number(process.env.ACCOUNT_ROUTE_RECOVERY_SECONDS ?? 300);
const KEY_PROBE_INFLIGHT = new Map();      // `${model}\0${fp}` -> Promise
const KEY_FALLBACK_WARN_AT = new Map();    // modelId -> ts

function accountRouteRecord(modelId, acc) {
  if (!modelId || !acc?.key) return null;
  return (META.models?.[modelId]?.keyRouting || {})[quotaFingerprint(acc.key)] || null;
}

// 「官方渠道」：优先用 perModel.officialProviders 显式配置；否则取 canonicalSlug 的第一段
// （如 deepseek/deepseek-v4.1-flash → deepseek）。canonicalSlug 缺失或为私有前缀时，用模型名的第一段猜。
function officialProvidersFor(modelId) {
  const cfg = config.perModel?.[modelId] || {};
  const explicit = (cfg.officialProviders || []).filter((u) => typeof u === 'string' && u);
  if (explicit.length) return explicit;
  const meta = META.models?.[modelId] || {};
  const slug = String(meta.canonicalSlug || meta.openrouterSlug || '');
  let p = slug.split('/')[0];
  if (!p || p === 'cline-pass' || p === 'private' || p === 'openai-compatible-private') {
    p = String(modelId).replace(/^cline-pass\//, '').split('-')[0];
  }
  return p ? [p] : [];
}

// 0 = 已知命中官方渠道；1 = 尚未检测 / 探测失败（未知）；2 = 已确认非官方渠道。
function keyRouteTier(modelId, acc) {
  const cfg = config.perModel?.[modelId] || {};
  if (!cfg.officialOnly) return 0;
  const official = officialProvidersFor(modelId);
  if (!official.length) return 0;
  const rec = accountRouteRecord(modelId, acc);
  if (!rec || !rec.ok) return 1;
  // 以「实际命中」为准：探测到了 provider 就直接判定。
  // 注意不能因为凭证池（plannedProviders）里含官方渠道就放行——例如 deepseek-v4.1-flash-1017
  // 的所有 key 池里都有 deepseek 作为后备，但有的 key（如 账号6）实际首选是 pareto，
  // 放行会导致请求真的落到非官方渠道。
  if (rec.provider) return official.includes(rec.provider) ? 0 : 2;
  // 只有拿不到实际 provider 时才退回凭证池判断。
  if ((rec.plannedProviders || []).some((p) => official.includes(p))) return 0;
  return 2;
}

// 官方过滤是否生效 / 当前是否有可用的官方 key（用于代理入口的严格拦截）。
function officialFilterState(modelId) {
  const cfg = config.perModel?.[modelId] || {};
  const official = cfg.officialOnly ? officialProvidersFor(modelId) : [];
  if (!cfg.officialOnly || !official.length) return { active: false, ok: true, official, eligible: enabledAccounts().length, total: enabledAccounts().length };
  const list = enabledAccounts();
  const eligible = list.filter((a) => keyRouteTier(modelId, a) === 0);
  return { active: true, ok: eligible.length > 0, official, eligible: eligible.length, total: list.length };
}

function keyRouteView(modelId) {
  const cfg = config.perModel?.[modelId] || {};
  const official = officialProvidersFor(modelId);
  return {
    officialOnly: !!cfg.officialOnly,
    officialProviders: official,
    accounts: (config.accounts || []).filter((a) => a && a.key).map((a) => {
      const rec = accountRouteRecord(modelId, a);
      return {
        name: a.name,
        enabled: a.enabled !== false,
        tier: official.length ? keyRouteTier(modelId, a) : 0,
        provider: rec?.provider || null,
        canonical: rec?.canonical || null,
        plannedProviders: rec?.plannedProviders || [],
        ok: rec ? !!rec.ok : null,
        error: rec?.error || null,
        checkedAt: rec?.checkedAt || null,
      };
    }),
  };
}

// 用一条最小流式请求探测该 key 在该模型下实际命中的上游（流式可规避推理模型非流式空内容导致的 500）。
async function detectAccountRoute(modelId, acc, { timeoutMs = 45000, trigger = null } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(acc.key),
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: true }),
      signal: ctrl.signal,
    });
    const ctype = res.headers.get('content-type') || '';
    if (res.status !== 200 || !ctype.includes('event-stream')) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = errText(j?.error) || msg; } catch { /* 非 JSON 错误文本 */ }
      noteInternal('key-route', modelId, { acc, ms: Date.now() - t0, stream: true, trigger, error: msg });
      return { ok: false, status: res.status, ms: Date.now() - t0, error: msg || `HTTP ${res.status}` };
    }
    const out = await collectStreamAsChat(res);
    noteInternal('key-route', modelId, { acc, json: out, ms: Date.now() - t0, stream: true, trigger });
    const r = parseRouting(out);
    if (!r.pipeline) {
      return { ok: false, status: 200, ms: Date.now() - t0, error: '未返回路由元数据（provider_metadata.gateway.routing 缺失）' };
    }
    const plan = r.plan || '';
    return {
      ok: true,
      status: 200,
      ms: Date.now() - t0,
      pipeline: r.pipeline,
      finalProvider: r.finalProvider,
      canonicalSlug: r.canonicalSlug,
      fallbacks: r.fallbacks,
      plannedProviders: parsePlannedProviders(plan),
      plan: plan.slice(0, 600),
      error: null,
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 同一 model+key 的探测去重（并发请求只打一次上游）。
function probeAccountForModel(modelId, acc, { source = 'auto', save = true, timeoutMs = 45000 } = {}) {
  const fp = quotaFingerprint(acc.key);
  const inflightKey = `${modelId}\u0000${fp}`;
  const running = KEY_PROBE_INFLIGHT.get(inflightKey);
  if (running) return running;
  const p = (async () => {
    const r = await detectAccountRoute(modelId, acc, { timeoutMs, trigger: source });
    const meta = (META.models[modelId] ||= {});
    const record = {
      name: acc.name,
      ok: !!r.ok,
      status: r.status ?? 0,
      provider: r.finalProvider || null,
      canonical: r.canonicalSlug || null,
      pipeline: r.pipeline || null,
      plannedProviders: r.plannedProviders || [],
      fallbacks: r.fallbacks || [],
      plan: r.plan || '',
      error: r.error || null,
      ms: r.ms ?? null,
      checkedAt: Date.now(),
      source,
    };
    meta.keyRouting = { ...(meta.keyRouting || {}), [fp]: record };
    if (save) saveMeta();
    return { ...record, fp };
  })().finally(() => KEY_PROBE_INFLIGHT.delete(inflightKey));
  KEY_PROBE_INFLIGHT.set(inflightKey, p);
  return p;
}

// 轮询跳过非官方 key 时的即时复检：限频（默认 5 分钟一次），避免每个请求都打上游。
function scheduleAccountProbe(modelId, acc, { force = false, source = 'rotation-skip' } = {}) {
  // ACCOUNT_ROUTE_RECOVERY_SECONDS=0 表示关闭「轮询跳过时的即时复检」（定时检测/手动检测仍可单独使用）
  if (!force && !(ACCOUNT_ROUTE_RECOVERY_SECONDS > 0)) return null;
  const rec = accountRouteRecord(modelId, acc);
  const minMs = ACCOUNT_ROUTE_RECOVERY_SECONDS * 1000;
  if (!force && rec?.checkedAt && Date.now() - rec.checkedAt < minMs) return null;
  return probeAccountForModel(modelId, acc, { source }).catch((e) => {
    console.warn(`[key路由] 复检 ${acc.name} × ${modelId} 失败：${e.message}`);
    return null;
  });
}

// 首次请求兜底：如果还有未检测的 key 且当前没有已知官方 key，先把它们探清楚再决定选谁。
async function ensureKeyRouting(modelId) {
  const cfg = config.perModel?.[modelId] || {};
  if (!cfg.officialOnly) return;
  if (!officialProvidersFor(modelId).length) return;
  const list = enabledAccounts();
  const unknown = list.filter((a) => !accountRouteRecord(modelId, a));
  if (!unknown.length) return;
  const hasOfficial = list.some((a) => keyRouteTier(modelId, a) === 0);
  if (hasOfficial) {
    unknown.forEach((a) => scheduleAccountProbe(modelId, a, { force: true, source: 'background' }));
    return;
  }
  await Promise.all(unknown.map((a) => probeAccountForModel(modelId, a, { source: 'bootstrap', timeoutMs: 15000 }).catch(() => null)));
}

// 定时全量检测：只针对开启了 officialOnly 的模型，逐 key 探测实际命中的上游。
async function refreshKeyRouting({ models = null, includeDisabled = false, force = true, source = 'scheduled' } = {}) {
  const targets = models
    ? [...new Set(models.filter(Boolean))]
    : (config.knownModels || []).filter((id) => config.perModel?.[id]?.officialOnly);
  if (!targets.length) return { models: [], probed: 0 };
  const list = includeDisabled
    ? (config.accounts || []).filter((a) => a && a.key)
    : enabledAccounts();
  let probed = 0;
  for (const modelId of targets) {
    for (let i = 0; i < list.length; i += 3) {
      await Promise.all(list.slice(i, i + 3).map(async (acc) => {
        const rec = accountRouteRecord(modelId, acc);
        if (!force && rec?.checkedAt && Date.now() - rec.checkedAt < ACCOUNT_ROUTE_REFRESH_MINUTES * 60e3) return;
        await probeAccountForModel(modelId, acc, { source, save: false }).catch(() => null);
        probed++;
      }));
    }
  }
  saveMeta();
  return { models: targets, probed };
}

function noteKeyFilterFallback(modelId, acc) {
  const now = Date.now();
  if (now - (KEY_FALLBACK_WARN_AT.get(modelId) || 0) < 60e3) return;
  KEY_FALLBACK_WARN_AT.set(modelId, now);
  console.warn(`[key路由] ${modelId} 没有已知可用的官方渠道 key，临时回退到非官方/未知 key：${acc.name}`);
}

// 纯轮询：每次调用取下一个启用账号。传入 modelId 时，若该模型开启了 officialOnly，
// 则优先选已知官方 key（tier 0）→ 未检测 key（tier 1）→ 已知非官方 key（tier 2，仅兜底）。
function pickAccount(modelId = null, { allowFallback = true } = {}) {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '' };
  const cfg = modelId ? (config.perModel?.[modelId] || {}) : {};
  const filterOn = !!cfg.officialOnly && officialProvidersFor(modelId).length > 0;
  const start = RR_COUNTER % list.length;
  if (!filterOn) {
    const chosen = list[start];
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
    return { ...chosen };
  }
  let chosen = null;
  let chosenTier = 2;
  const skipped = new Set();               // 本次轮询真正跳过的 key（只复检它们，不碰未经过的 key）
  const maxPass = allowFallback ? 2 : 0;   // 严格模式只接受 tier 0（已知官方 key）
  for (let pass = 0; pass <= maxPass && !chosen; pass++) {
    for (let i = 0; i < list.length; i++) {
      const acc = list[(start + i) % list.length];
      const tier = keyRouteTier(modelId, acc);
      if (tier !== pass) {
        if (tier > 0) skipped.add(acc);
        continue;
      }
      chosen = acc;
      chosenTier = pass;
      RR_COUNTER = (start + i + 1) % 1000000000;
      break;
    }
  }
  // 只对本次轮询路径上被跳过的非官方/未知 key 发起限频复检；恢复了就自动重新加入轮询。
  for (const acc of skipped) scheduleAccountProbe(modelId, acc);
  if (!chosen) {
    if (!allowFallback) return null;      // 严格模式：绝不回退到非官方 / 未知 key
    chosen = list[start];
    chosenTier = keyRouteTier(modelId, chosen);
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
  }
  if (chosenTier > 0) noteKeyFilterFallback(modelId, chosen);
  const rec = accountRouteRecord(modelId, chosen);
  return {
    ...chosen,
    keyFilter: chosenTier === 0 ? 'official' : chosenTier === 1 ? 'unknown' : 'fallback',
    keyProvider: rec?.provider || null,
  };
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  return bearer === PROXY_KEY || admin === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- 账号额度（Cline usage-limits）----------
// 官方接口：GET {upstreamBase}/users/me/plan/usage-limits
// 响应：{ data: { limits: [{ type: five_hour|weekly|monthly, percentUsed, resetsAt }] } }
// 只需使用比例与更新时间。缓存写入 META.quota，以 key 指纹为键，避免明文 key 落盘。
const quotaFingerprint = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
const QUOTA_WINDOW_KEY = { five_hour: 'fiveHour', weekly: 'weekly', monthly: 'monthly' };
const QUOTA_REFRESH_MINUTES = Number(process.env.QUOTA_REFRESH_MINUTES ?? 10);

async function fetchQuotaForKey(key) {
  const base = String(config.upstreamBase || '').replace(/\/+$/, '');
  const { status, json } = await fetchJSON(`${base}/users/me/plan/usage-limits`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
  }, 30000);
  const limits = json?.data?.limits;
  if (status < 200 || status >= 300 || !Array.isArray(limits)) {
    const msg = json?.error?.message || json?.error || `HTTP ${status}`;
    throw new Error(String(msg).slice(0, 160));
  }
  const windows = {};
  for (const l of limits) {
    const k = QUOTA_WINDOW_KEY[l?.type];
    if (!k) continue;
    const pct = Number(l.percentUsed);
    windows[k] = {
      percent: Number.isFinite(pct) ? pct : null,
      resetsAt: typeof l.resetsAt === 'string' && l.resetsAt ? l.resetsAt : null,
    };
  }
  return { updatedAt: Date.now(), error: null, windows };
}

// 并行刷新所有账号额度；单个账号失败只记录错误，不影响其他账号。
async function refreshQuotas() {
  const accounts = (config.accounts || []).filter((a) => a && a.key);
  await Promise.all(accounts.map(async (a) => {
    const fp = quotaFingerprint(a.key);
    try {
      META.quota[fp] = await fetchQuotaForKey(a.key);
    } catch (e) {
      const prev = META.quota[fp] || {};
      META.quota[fp] = { ...prev, error: String(e?.message || e).slice(0, 200), updatedAt: Date.now() };
    }
  }));
  saveMeta();
  return META.quota;
}

function quotaFor(acc) {
  return (acc && acc.key && META.quota[quotaFingerprint(acc.key)]) || null;
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
  }
  return ids;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = String(e.tag || '').split('/')[0] || (e.provider_name || '').toLowerCase().replace(/\s+/g, '-');
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name, endpoints: 0, context: 0, uptime: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_30m || 0));
  }
  return { slug: real, endpoints: Object.values(detail) };
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
  };
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
// - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的 "Available providers are: ..."
async function harvestAvailableProviders(modelId, pipeline) {
  const acc = pickAccount(modelId);
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const t0 = Date.now();
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000);
  // 正常情况下路由层拒绝、不耗 token；only 被网关忽略时会照常生成，这时要记一笔
  noteInternal('harvest', modelId, { acc, json, ms: Date.now() - t0, pinned: '__probe__' });
  const err = json?.error;
  if (typeof err !== 'string') return null;
  if (pipeline === 'planner') {
    const m = /Available providers are:\s*([^.]+)/.exec(err);
    if (!m) return null;
    // 错误文本里可能混有 JSON 片段（如 ","type":"invalid_request_error"），必须按 slug 格式过滤
    const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    return toks.length ? toks : null;
  }
  const i = err.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(err.slice(i))?.error?.metadata?.available_providers || null;
  } catch { return null; }
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

// ---------- 钉住健康度告警 ----------
// Cline 网关可能悄悄忽略 planner 管道的 providerOptions.gateway.only（实测 2026-09-20：
// 非法渠道 __probe__ 都不再被路由层拒绝，任何 only 都返回同一上游）。这里把“钉住是否生效”
// 持久化到 META.models[id].pinHealth，并由 /api/models 汇总成 alerts 供控制台横幅告警。
function setPinHealth(modelId, patch) {
  const meta = (META.models[modelId] ||= {});
  const prev = meta.pinHealth || {};
  const next = { ...prev, ...patch };
  // 无变化就不写盘，避免每次请求都落盘
  if (prev.ok === next.ok && prev.reason === next.reason && prev.actual === next.actual && prev.requested === next.requested) return;
  meta.pinHealth = next;
  saveMeta();
}

// 运行时判定：严格钉住某渠道却命中另一个上游 ⇒ only 被忽略（仅在 planner 管道、strict 模式）。
// 注意：匹配时不能据此判定“钉住生效”（网关默认就可能选它），因此只向上报警、不自动清除；
// 清除告警只交给权威哨兵 verifyPin / probeModel 的探测结果。
function notePinOutcome(modelId, attempt, routing) {
  if (!attempt?.upstream || attempt.strict === false || !routing || routing.pipeline !== 'planner') return;
  const actual = routing.finalProvider;
  if (!actual || actual === attempt.upstream) return;
  setPinHealth(modelId, {
    ok: false, pipeline: 'planner', requested: attempt.upstream, actual,
    reason: `严格钉住 ${attempt.upstream}，实际上游却是 ${actual}：providerOptions.gateway.only 已被 Cline 网关忽略`,
    checkedAt: Date.now(),
  });
  console.warn(`[钉住失效] ${modelId} 请求钉 ${attempt.upstream}，实际命中 ${actual}（providerOptions.gateway.only 被忽略）`);
}

// 零 token 哨兵：向网关发送非法渠道 only=["__probe__"]。
// 若 only 仍被遵守 → 路由层报错并列出可用渠道；若被忽略 → 请求照常执行（200 或耗尽 token 的 empty response）。
// 按管道选参数：planner 用 providerOptions.gateway，direct 用顶层 provider（两者行为不同，不能混用）。
async function verifyPin(modelId) {
  const meta0 = META.models[modelId] || {};
  const isDirect = meta0.pipeline === 'direct';
  const pipeline = isDirect ? 'direct' : 'planner';
  const keyPath = isDirect ? 'provider' : 'providerOptions.gateway';
  const acc = pickAccount(modelId);
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = isDirect
    ? { ...base, provider: { only: ['__probe__'] } }
    : { ...base, providerOptions: { gateway: { only: ['__probe__'] } } };
  const t0 = Date.now();
  const { status, json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
  }, 60000).catch(() => ({ status: 0, json: { error: 'network error' } }));
  noteInternal('pin-check', modelId, { acc, json, ms: Date.now() - t0, pinned: '__probe__' });
  const rawErr = json?.error;
  const errStr = typeof rawErr === 'string' ? rawErr : rawErr ? JSON.stringify(rawErr) : '';
  const m = /Available providers are:\s*([^.]+)/.exec(errStr);
  const available = m ? m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t)) : null;
  const honored = status >= 400 && (/no allowed providers|no available providers/i.test(errStr) || !!(available && available.length));
  let actual = null;
  if (!honored) {
    const d = json?.data && json.data.choices ? json.data : json;
    const rt = d?.choices?.[0]?.message?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
    actual = rt.finalProvider || (typeof d?.provider === 'string' ? slugify(d.provider) : null);
  }
  const health = honored
    ? { ok: true, pipeline, requested: '__probe__', actual: null, available: available || [], reason: `${keyPath}.only 正常生效：非法渠道被路由层拒绝（可用渠道 ${available?.length ?? 0} 个）`, checkedAt: Date.now() }
    : { ok: false, pipeline, requested: '__probe__', actual, reason: `向网关发送非法渠道 ${keyPath}.only=["__probe__"] 未被路由层拒绝（请求照常执行），说明 ${keyPath}.only 已被 Cline 网关忽略，钉住参数不生效`, checkedAt: Date.now() };
  if (available?.length) {
    const meta = (META.models[modelId] ||= {});
    meta.availableProviders = available;
    meta.upstreams = [...new Set([...(meta.upstreams || []), ...available])];
  }
  const prev = META.models[modelId]?.pinHealth || {};
  META.models[modelId] = { ...(META.models[modelId] || {}), pinHealth: { ...prev, ...health } };
  saveMeta();
  return { model: modelId, ...health };
}

async function probeModel(modelId) {
  const acc = pickAccount(modelId);
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(acc.key),
    body: JSON.stringify(body),
  }, 180000);
  const ms = Date.now() - t0;
  noteInternal('probe', modelId, { acc, json, ms });
  if (json?.error && !json?.data) {
    return { ok: false, error: typeof json.error === 'string' ? json.error : JSON.stringify(json.error) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline !== 'planner' && r.canonicalSlug) {
    // 规划器管道的钉住发生在 Vercel 侧，OpenRouter 的 endpoint 明细仅对直连管道有参考意义
    try {
      const res = await orEndpoints(r.canonicalSlug);
      endpoints = res.endpoints;
      orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  const prev = META.models[modelId] || {};
  const detail = { ...prev.upstreamDetail };
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  // 规划器管道的钉住健康度：非法渠道能被路由层拒绝 ⇒ only 仍被识别；否则说明参数已被网关忽略
  const pinHealth = r.pipeline === 'planner'
    ? (harvest
      ? { ok: true, pipeline: 'planner', available: harvest, reason: `探测到可用渠道清单（${harvest.length} 个），only 参数可被网关识别`, checkedAt: Date.now() }
      : { ok: false, pipeline: 'planner', reason: '探测未返回渠道清单：非法渠道 only=["__probe__"] 未被路由层拒绝，钉住参数可能已被 Cline 网关忽略', checkedAt: Date.now() })
    : prev.pinHealth;
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    pinHealth,
    availableProviders: harvest || prev.availableProviders || [],
    canonicalSlug: r.canonicalSlug,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 按账号探测同一模型：逐个账号各发一条最小流式请求，抓取该账号实际命中的上游供应商，
// 并从规划器返回的 planningReasoning 里解析出该账号「凭证池」中的可用渠道集合。
// 用途：把每个账号实际命中的上游可视化，并作为「仅官方渠道 key」过滤的判定依据
// （判定与定时复检见 detectAccountRoute / refreshKeyRouting）。
// 用流式 + collectStreamAsChat 规避推理模型非流式空内容被网关 500 的问题。
function parsePlannedProviders(plan) {
  const m = /System credentials planned for:\s*([^.]+)/.exec(plan || '');
  if (!m) return [];
  return m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
}
async function probeAccounts(modelId, { includeDisabled = false } = {}) {
  const all = (config.accounts || []).filter((a) => a && a.key && (includeDisabled || a.enabled !== false));
  const run = async (acc) => {
    // 探测结果会同时写入 keyRouting，供代理按模型过滤 key 使用
    const r = await probeAccountForModel(modelId, acc, { source: 'manual-accounts', save: false, timeoutMs: 60000 });
    return {
      name: acc.name, enabled: acc.enabled !== false, ok: r.ok, status: r.status, ms: r.ms,
      pipeline: r.pipeline, finalProvider: r.provider, canonicalSlug: r.canonical,
      fallbacks: r.fallbacks, plannedProviders: r.plannedProviders, plan: r.plan, error: r.error,
    };
  };
  // 小并发（3）避免瞬时打满；账号数很少，整体仍在数秒内完成
  const results = [];
  for (let i = 0; i < all.length; i += 3) results.push(...await Promise.all(all.slice(i, i + 3).map(run)));
  const groups = {};
  for (const r of results) {
    const key = r.ok ? (r.finalProvider || 'unknown') : `error:${r.status || 'net'}`;
    (groups[key] ||= []).push(r.name);
  }
  const meta = (META.models[modelId] ||= {});
  meta.accountRouting = { updatedAt: Date.now(), results, groups };
  saveMeta();
  return { model: modelId, updatedAt: Date.now(), results, groups, includeDisabled };
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'ok';                     // 请求已到达模型（推理耗尽 max_tokens 导致内容为空）
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  const prev = (meta.upstreamStatus || {})[upstream] || {};
  // 保留「校验」实测出的 ms（这里没有可比的端到端计时，不要把延迟抹掉）
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, ms: prev.ms, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const m = /Available providers are:\s*([^.]+)/.exec(String(errMsg || ''));
  if (!m) return;
  const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性与实测延迟
// 延迟 = 该渠道端到端耗时（含排队/首字/16 token 生成），并发 5 条测同一批，仅供横向对比
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount(modelId);
  const results = {};
  const batch = 5;
  // 规划器管道：先用非法渠道哨兵验证 only 是否仍被网关遵守。若已被忽略，逐渠道 only 校验毫无意义
  // （每次都会成功），必须把结果标为不可信，避免给出“全部可用”的假绿。
  let pinBroken = false;
  if (pipeline === 'planner') {
    const harvest = await harvestAvailableProviders(modelId, 'planner');
    pinBroken = !harvest;
    setPinHealth(modelId, harvest
      ? { ok: true, pipeline: 'planner', available: harvest, reason: `网关按 only 限制路由（可用渠道 ${harvest.length} 个）`, checkedAt: Date.now() }
      : { ok: false, pipeline: 'planner', reason: '非法渠道 only=["__probe__"] 未被路由层拒绝，providerOptions.gateway.only 已被忽略，钉住与校验结果均不可信', checkedAt: Date.now() });
  }
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      noteInternal('validate', modelId, { acc, json, ms: Date.now() - t0, pinned: slug });
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = msg.slice(0, 160);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      if (pinBroken) {
        status = 'unknown';
        note = '钉住参数已被网关忽略，无法验证该渠道是否真正被使用（结果不可信）';
      }
      results[slug] = { status, ms: Date.now() - t0, note, checkedAt: Date.now() };
    }));
  }
  META.models[modelId] = { ...(META.models[modelId] || meta), upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, pinBroken, validatedAt: Date.now() };
  saveMeta();
  return { results, pinBroken };
}

// 从官方接口、官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  const addModel = (value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string') return;
    const normalized = id.trim().toLowerCase();
    if (normalized.startsWith('cline-pass/')) found.add(normalized);
  };
  // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
  try {
    const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', {}, 30000);
    const list = json?.clinePass || json?.data?.clinePass;
    if (Array.isArray(list) && list.length) {
      list.forEach(addModel);
      sources.push('cline.api');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'] || json?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => addModel(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 官方文档表格兜底
  try {
    const res = await fetch('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

// 请求历史按来源分开限额：代理请求（客户端经代理发起）与内部请求（测试 / 探测 / 校验 / key 路由检测）。
// 定时 key 路由检测每轮「官方过滤模型数 × 启用 key 数」条，共用一个上限会把真实请求挤出去。
// 没有 source 字段的旧记录按代理请求算。
const HISTORY_LIMIT = { proxy: 100, internal: 200 };
const historyKind = (h) => (!h.source || h.source === 'proxy' ? 'proxy' : 'internal');
function pushHistory(entry) {
  META.history.unshift(entry);
  const seen = { proxy: 0, internal: 0 };
  META.history = META.history.filter((h) => ++seen[historyKind(h)] <= HISTORY_LIMIT[historyKind(h)]);
}

// 内部请求（探测、校验、测试 key 等）同样消耗账号额度，也记进请求历史，但不改模型的「最近命中」和账号统计。
// 只记上游真正跑了模型的请求：返回了补全或 usage，或是推理耗尽 max_tokens 的 empty response；
// 路由层直接拒绝（如 only=["__probe__"] 被拒）没有 token 消耗，不记。
// json 是上游原始应答（非流式带 data 包裹，或 collectStreamAsChat 聚合出的结构）。
function noteInternal(source, modelId, { acc = null, json = null, ms = null, stream = false, pinned = null, trigger = null, error = null } = {}) {
  const d = json?.data && json.data.choices ? json.data : json;
  const errMsg = error || (d?.error && !d?.choices ? errText(d.error) : null);
  const ran = !!(d?.choices || d?.usage) || /empty response content/i.test(errMsg || '');
  if (!ran) return;
  const r = d?.choices ? parseRouting(d) : {};
  const usage = usageMetrics(d?.usage);
  const tps = usage ? tpsOf(usage.completion, ms) : null;
  pushHistory({
    ts: Date.now(), model: modelId, source, trigger, pinned,
    provider: r.finalProvider || null, canonical: r.canonicalSlug || null,
    ms, stream, error: errMsg ? errMsg.slice(0, 300) : null,
    account: acc?.name || null, attempts: [], trace: [],
    usage, ttftMs: null, tps, tpsApprox: tps != null,
  });
  saveMeta();
}

function record(modelId, info) {
  // lastProvider/lastMs 是控制台「最近命中」展示的字段。历史原因只有探测（probeModel）写它，
  // 代理/测试请求只写 provider/ms，导致钉住后列表仍显示上一次自动探测的渠道。
  // 这里统一以真实请求为准同步一份，失败请求（provider 为空）不覆盖上一次命中。
  const { source = 'proxy', ...rest } = info;
  const patch = rest.provider ? { ...rest, lastProvider: rest.provider, lastMs: rest.ms } : { ...rest };
  META.models[modelId] = { ...(META.models[modelId] || {}), ...patch };
  pushHistory({ ts: Date.now(), model: modelId, source, ...rest });
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}

// ---------- 请求指标（上下文 / 缓存命中 / TTFT / TPS）----------
// usage 是上游的 OpenAI 兼容结构：非流式在应答顶层，流式在最后一个 chunk（实测不带 stream_options 也会给）。
// 上下文 = prompt_tokens；缓存命中取 prompt_tokens_details.cached_tokens，Anthropic 风格的 cache_read_input_tokens 兜底。
function usageMetrics(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  if (prompt == null && completion == null) return null;
  return {
    prompt,
    cached: num(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens),
    completion,
    reasoning: num(u.completion_tokens_details?.reasoning_tokens),
  };
}

// TPS 只算生成阶段：completion_tokens / (结束 - 首 token)。生成段太短（整段几乎一次到达）时算出来的值没有意义，不给。
const TPS_MIN_GEN_MS = 200;
function tpsOf(completion, genMs) {
  if (!completion || !(genMs >= TPS_MIN_GEN_MS)) return null;
  return Math.round((completion / genMs) * 10000) / 10;
}

// 非流式拿不到首 token 时间：TTFT 留空，TPS 用成功那次尝试的整段耗时估算（含预填充，偏低），标记 tpsApprox。
function nonStreamMetrics(out, trace) {
  const usage = usageMetrics(out?.usage);
  const ok = [...(trace || [])].reverse().find((t) => t.status === 200);
  const tps = usage ? tpsOf(usage.completion, ok?.ms) : null;
  return { usage, ttftMs: null, tps, tpsApprox: tps != null };
}

// 流式首 token：第一个带非空 content / reasoning / tool_calls 增量的 chunk 到达的时刻（只有 role 或元数据的 chunk 不算）。
// 按到达顺序喂入原始字节，找到后不再解析。
function firstTokenProbe() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let at = null;
  return {
    get at() { return at; },
    feed(chunk, ts) {
      if (at != null) return;
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let c;
        try { c = JSON.parse(payload); } catch { continue; }
        const d = c?.choices?.[0]?.delta;
        if (d && (d.content || d.reasoning || d.reasoning_content || (Array.isArray(d.tool_calls) && d.tool_calls.length))) {
          at = ts;
          pending = '';
          return;
        }
      }
    },
  };
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return { status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  const r = parseRouting(d);
  return { status: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort, try, tries }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，每个渠道连续尝试 retries 次后才换下一个，排除的永不在候选中
// - 未勾选：自动模式单候选（同样按 retries 重试），排除换算成 only 白名单注入（见 injectPrefs）
const RETRY_MAX = 5;
function normRetries(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, RETRY_MAX) : 1;
}
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const tries = normRetries(cfg?.retries);
  const base = { strict, sort, excludeList: exclude, tries };
  // 同一渠道的重试连续展开在一起：a,a,a → b,b,b（用完次数才顺切）
  const repeat = (a) => Array.from({ length: tries }, (_, k) => ({ ...a, try: k + 1 }));
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.flatMap((u, i) => repeat({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return repeat({ ...base, upstream: null, orderRest: [], excludeList: exclude });
}

// 确定性失败（渠道不可钉 / key 失效）重试没有意义，直接放弃该渠道剩余次数；
// 限流、5xx、网络失败、超时属于瞬时问题，值得重试。
function retryWorthwhile(msg) {
  const st = classifyUpstreamError(msg);
  return st !== 'bad' && st !== 'auth';
}
const RETRY_BACKOFF_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

// 把一段 SSE 文本聚合成与上游非流式一致的 chat.completion 对象。
// Cline 网关的非流式应答会把 content / tool_calls / usage / provider_metadata 都放进一个对象，
// 这里按 chunk 语义还原，保证下游客户端拿到的结构与直接非流式一致。
async function collectStreamAsChat(res) {
  const text = await res.text();
  const agg = { id: null, created: null, model: null, content: '', reasoning: '', reasoningDetails: [], toolCalls: [], finishReason: null, role: 'assistant', usage: null, providerMetadata: null };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk.id) agg.id = agg.id || chunk.id;
    if (chunk.created) agg.created = agg.created || chunk.created;
    if (chunk.model) agg.model = agg.model || chunk.model;
    if (chunk.usage) agg.usage = chunk.usage;
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (typeof d.content === 'string') agg.content += d.content;
    if (typeof d.reasoning === 'string') agg.reasoning += d.reasoning;
    if (Array.isArray(d.reasoning_details)) agg.reasoningDetails.push(...d.reasoning_details);
    if (d.provider_metadata) agg.providerMetadata = d.provider_metadata;
    if (d.role) agg.role = d.role;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        const slot = (agg.toolCalls[idx] ||= { id: undefined, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (tc.function) {
          if (tc.function.name) slot.function.name = tc.function.name;
          if (typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
        }
      }
    }
    if (ch.finish_reason) agg.finishReason = ch.finish_reason;
  }
  const toolCalls = agg.toolCalls.filter(Boolean);
  const message = { role: agg.role, content: agg.content || (toolCalls.length ? null : '') };
  if (agg.reasoning) { message.reasoning = agg.reasoning; message.reasoning_content = agg.reasoning; }
  if (agg.reasoningDetails.length) message.reasoning_details = agg.reasoningDetails;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (agg.providerMetadata) message.provider_metadata = agg.providerMetadata;
  const body = {
    id: agg.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: agg.created || Math.floor(Date.now() / 1000),
    model: agg.model || null,
    choices: [{ index: 0, message, logprobs: null, finish_reason: agg.finishReason || 'stop' }],
  };
  if (agg.usage) body.usage = agg.usage;
  return body;
}

// 探测流式首块里的错误帧。Cline 网关可能返回 200 + text/event-stream，
// 但内容是 data: {"id":...,"choices":[],"error":{...}}——错误对象嵌在正常 chunk 里，
// 只判断开头是否为 {"error" 会漏掉，导致错误帧被当成正常 SSE 透传。
// 逐条解析首个数据块里的 data: 行，命中 error 字段即返回错误信息；否则返回 null（真 SSE）。
function inspectSSEHead(text) {
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; } // 分块截断/未完整：跳过，不误判
    if (chunk && chunk.error) return errText(chunk.error) || 'stream error';
  }
  return null;
}

// 非流式兼容降级：Cline 网关在「模型只产出推理、content 为空且无 tool_calls」时，
// 非流式接口会直接 500 {"error":"empty response content"}，但同一请求改走流式却 200（SSE 只含 reasoning 增量）。
// 这里在原非流式请求报该错时自动改走流式并把 SSE 聚合成非流式结构返回，避免下游拿到 5xx。
async function attemptStreamCompat(modelId, body, attempt, signal, acc) {
  const send = injectPrefs({ ...body, stream: true }, modelId, attempt);
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const ctype = res.headers.get('content-type') || '';
    if (res.status !== 200 || !ctype.includes('event-stream')) return null;
    const out = await collectStreamAsChat(res);
    return { status: 200, out, routing: parseRouting(out), netError: null, acc, compat: 'stream-fallback' };
  } catch {
    return null;
  }
}

// 单次向上游网关发起非流式请求；返回 { status, out, routing, netError, acc }
// 异常（网络错误/非 JSON/非 200）不抛出，由调用方决定切换
async function attemptOnce(modelId, body, attempt, signal, { strictKey = false } = {}) {
  const send = injectPrefs(body, modelId, attempt);
  const acc = pickAccount(modelId, { allowFallback: !strictKey });
  if (!acc) {
    return {
      status: 503,
      out: { error: { message: `模型 ${modelId} 已启用「仅官方渠道 key」，当前没有可用的官方 key`, type: 'key_filter_error' } },
      routing: {}, netError: 'no official key', acc: null,
    };
  }
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) return { status: 502, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc };
    const { status, body: out, routing } = unwrap(json);
    // 非流式空内容错误：改走流式聚合成一条成功的非流式应答（见 attemptStreamCompat 注释）
    if (status !== 200 && /empty response content/i.test(errText(out?.error?.message))) {
      const fb = await attemptStreamCompat(modelId, body, attempt, signal, acc);
      if (fb) return fb;
    }
    return { status, out, routing, netError: null, acc };
  } catch (e) {
    return { status: 502, out: { error: { message: `upstream fetch failed: ${e.message}`, type: 'upstream_error' } }, routing: {}, netError: e.message, acc };
  }
}

// 顺序故障转移：依次执行候选（同一渠道先重试 retries 次），非 200 / 网络失败 / 超时即换下一次；全部失败返回最后一次结果。
// 确定性错误（不可钉 / key 失效）不消耗剩余重试次数，直接跳到下一个渠道。
// 流式：首包前（网关以 JSON 而非 SSE 应答错误）仍可切换；SSE 一旦开始即透传，无法重试。
// 每次尝试有独立的超时中止（attemptTimeoutMs）；客户端断开会中止当前尝试。
// 返回 { status, out, routing, acc, trace, streamUp? } —— trace 为逐次尝试 [{ upstream, status, ms, note, try, tries }]
async function runChatChain(req, body, modelId, cfg, { stream = false, attemptTimeoutMs = 120000, res = null } = {}) {
  const attempts = buildAttempts(modelId, cfg);
  const strictKey = !!cfg?.officialOnly && officialProvidersFor(modelId).length > 0;
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeCtrl = null;            // 当前尝试的 AbortController；流式成功后保持指向该次 fetch，用于断连时中止上游 body
  let keepCloseHook = false;        // 流式 SSE 建立后，close 钩子要保留到流结束
  const giveUp = new Set();         // 确定性失败的渠道：剩余重试直接跳过
  const onClientClose = () => { if (activeCtrl) activeCtrl.abort(); };
  req.on('close', onClientClose);
  try {
    for (const attempt of attempts) {
      const who = attempt.upstream || 'auto';
      if (attempt.try > 1) {
        if (giveUp.has(who)) continue;                                  // 确定性错误，不浪费重试
        // 客户端已走就别重试了（注意：req.destroyed 在读完 body 后就是 true，不能当作断连判据）
        if (res && (res.destroyed || res.writableEnded)) break;
        await sleep(Math.min(RETRY_BACKOFF_MS * (attempt.try - 1), 1500)); // 递增退避，给限流一点恢复时间
      }
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          const acc = pickAccount(modelId, { allowFallback: !strictKey });
          if (!acc) {
            trace.push({ upstream: attempt.upstream, status: 503, ms: 0, note: 'no official key', try: attempt.try, tries: attempt.tries });
            last = { status: 503, out: { error: { message: `模型 ${modelId} 已启用「仅官方渠道 key」，当前没有可用的官方 key`, type: 'key_filter_error' } }, routing: {}, acc: null, netError: null };
            break;
          }
          let up = null;
          let netError = null;
          try {
            up = await fetch(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal: ctrl.signal });
          } catch (e) { netError = e.message; }
          const ctype = up?.headers?.get('content-type') || '';
          let isSSE = !!up && up.status === 200 && ctype.includes('event-stream');
          // 网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}：
          // 探测首块，真正的 SSE 第一行是 "data: {...}" 且非错误对象。
          // 注意：错误帧可能较大，单次 read 只截到半行会导致 JSON 解析不完整而漏判，
          // 因此读到出现换行（首个完整 SSE 事件）或达到上限为止。
          const SSE_HEAD_MAX = 64 * 1024;
          let firstChunk = null;
          let firstChunkAt = null;
          if (isSSE) {
            let reader = null;
            try {
              reader = up.body.getReader();
              const parts = [];
              let total = 0;
              while (total < SSE_HEAD_MAX) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value?.length) {
                  parts.push(Buffer.from(value));
                  total += value.length;
                  if (parts.some((b) => b.includes(10))) break; // 已出现换行，足够判定首个事件
                }
              }
              if (!parts.length) {
                isSSE = false;
                netError = 'empty stream';
              } else {
                firstChunk = Buffer.concat(parts);
                firstChunkAt = Date.now();
                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);
                if (head.startsWith('data:')) {
                  // 错误帧形如 data: {"id":...,"choices":[],"error":{...}}，需解析 error 字段而非只看开头
                  const streamErr = inspectSSEHead(firstChunk.toString('utf8'));
                  if (streamErr) { isSSE = false; netError = `stream error: ${streamErr.slice(0, 160)}`; }
                } else {
                  isSSE = false;
                  netError = `unexpected stream head: ${head.slice(0, 60)}`;
                }
              }
            } catch (e) {
              isSSE = false;
              netError = e.message;
            } finally {
              try { reader?.releaseLock(); } catch {}
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let text = '';
            let json = null;
            if (firstChunk) {
              // 已消费的块 + 剩余 body 拼回完整错误文本
              const rest = await up.text().catch(() => '');
              text = firstChunk.toString('utf8') + rest;
            } else {
              text = await up.text();
            }
            try { json = JSON.parse(text); } catch {}
            const msg = errText(json?.error) || netError || text.slice(0, 160);
            trace.push({ upstream: attempt.upstream, status: up.status, ms, note: msg.slice(0, 160), try: attempt.try, tries: attempt.tries });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            if (!retryWorthwhile(msg)) giveUp.add(who);
            // 网关偶尔对流式请求回非 SSE 的完整 JSON：走与非流式一致的解包（去掉 data 包裹、统一错误形式）
            const u = json ? unwrap(json) : null;
            last = u
              ? { status: u.status, out: u.body, routing: u.routing, acc, netError: null }
              : { status: 502, out: { error: { message: netError || text.slice(0, 400) || 'stream error', type: 'upstream_error' } }, routing: {}, acc, netError: null };
            // 无 error 的完整 JSON 就是一次成功应答，不要再重试/换渠道
            if (last.status === 200) break;
            continue; // 错误：还未向客户端写任何字节，可切换下一候选
          }
          if (!up) {
            trace.push({ upstream: attempt.upstream, status: 502, ms, note: netError || 'no response', try: attempt.try, tries: attempt.tries });
            last = { status: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc, netError: netError || 'no response' };
            continue;
          }
          // 真 SSE：firstChunk 与剩余 body 串联透传（SSE 开始后无法重试）；close 钩子保留用于客户端断开时中止上游
          keepCloseHook = true;
          trace.push({ upstream: attempt.upstream, status: 200, ms, note: 'stream', try: attempt.try, tries: attempt.tries });
          return { status: 200, streamUp: up, streamHead: firstChunk, streamHeadAt: firstChunkAt, acc, trace, t0 };
        }
        // 非流式
        const r = await attemptOnce(modelId, body, attempt, ctrl.signal, { strictKey });
        const ms = Date.now() - t1;
        const note = r.compat ? `${r.compat} (upstream empty content compat)` : (r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok'));
        trace.push({ upstream: attempt.upstream, status: r.status, ms, note, try: attempt.try, tries: attempt.tries });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        if (r.status !== 200 && !r.netError && !retryWorthwhile(errText(r.out?.error?.message))) giveUp.add(who);
        last = r;
        if (r.status === 200) {
          notePinOutcome(modelId, attempt, r.routing);
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!keepCloseHook) req.off('close', onClientClose);
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  const modelId = body.model;
  if (!modelId) return sendJSON(res, 400, { error: { message: 'model is required' } });

  const cfg = config.perModel[modelId] || {};
  const targets = [...new Set(buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean))];
  const isStream = !!body.stream;
  // 开启「仅官方渠道 key」的模型：首次请求前先把未检测的 key 探清楚（没有已知官方 key 时才等待）
  await ensureKeyRouting(modelId);
  const kf = officialFilterState(modelId);
  if (kf.active && !kf.ok) {
    // 严格模式：没有可用的官方 key 时直接报错，绝不回退到非官方 key。
    // 同时触发一轮复检，key 恢复后下一个请求即可自动继续。
    enabledAccounts().forEach((a) => scheduleAccountProbe(modelId, a, { source: 'no-official' }));
    const msg = `模型 ${modelId} 启用了「仅使用命中官方渠道的 key」，但当前没有可用的官方 key（官方渠道：${kf.official.join(', ')}；已启用 key ${kf.total} 个）`;
    record(modelId, { provider: null, canonical: null, ms: 0, stream: isStream, attempts: [], trace: [], error: msg, account: null, keyFilter: 'no-official' });
    return sendJSON(res, 503, { error: { message: msg, type: 'key_filter_error' } }, { 'X-Cline-Key-Filter': 'no-official' });
  }

  const chain = await runChatChain(req, body, modelId, cfg, { stream: isStream, res });

  if (isStream && chain.streamUp) {
    // 流式透传：先写已探测的首块，再接剩余 body；tap 在结束时回读路由元数据并记录
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    const ctype = up.headers.get('content-type') || 'text/event-stream';
    res.writeHead(up.status, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
      'X-Cline-Key-Filter': config.perModel[modelId]?.officialOnly ? (acc.keyFilter || 'unknown') : 'off',
      'X-Cline-Key-Route': headerSafe(acc.keyProvider || 'unknown'),
    });
    if (chain.streamHead) res.write(chain.streamHead);
    const ft = firstTokenProbe();
    if (chain.streamHead) ft.feed(chain.streamHead, chain.streamHeadAt ?? Date.now());
    const buf = [];
    const tap = new Transform({
      transform(c, enc, cb) { ft.feed(c, Date.now()); buf.push(c); cb(null, c); },
      flush(cb) {
        const endAt = Date.now();
        const text = Buffer.concat(buf).toString('utf8');
        let provider = null, canonical = null, streamPipeline = null;
        // direct 管道：最后一个 chunk 顶层带 provider（显示名）与 model
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10 && !provider; i--) {
          const l = lines[i];
          if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
          try {
            const c = JSON.parse(l.slice(6));
            if (typeof c.provider === 'string') { provider = slugify(c.provider); canonical = c.model || null; streamPipeline = 'direct'; }
          } catch { /* 跳过不完整行 */ }
        }
        // planner 管道：final chunk 的 provider_metadata.gateway.routing
        if (!provider) {
          const fp = /"finalProvider":"([^"]+)"/.exec(text);
          const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
          provider = fp ? fp[1] : null;
          canonical = cs ? cs[1] : null;
          if (provider) streamPipeline = 'planner';
        }
        // 流式也做运行时钉住校验：严格钉的渠道与实际命中不一致 ⇒ only 被忽略
        if (streamPipeline === 'planner' && provider) {
          const okAttempt = chain.trace.find((t) => t.status === 200);
          const cfgNow = config.perModel[modelId] || {};
          if (okAttempt?.upstream) notePinOutcome(modelId, { upstream: okAttempt.upstream, strict: (cfgNow.pinMode || 'strict') === 'strict' }, { pipeline: 'planner', finalProvider: provider });
        }
        // usage 在最后一个带 usage 的 chunk；首块（streamHead）不在 buf 里，但它不会是最后一块
        let usage = null;
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 30 && !usage; i--) {
          const l = lines[i];
          if (!l.startsWith('data:') || !l.includes('"usage"')) continue;
          try { usage = usageMetrics(JSON.parse(l.slice(5)).usage); } catch { /* 跳过不完整行 */ }
        }
        const ttftMs = ft.at != null ? ft.at - t0 : null;
        const tps = usage && ft.at != null ? tpsOf(usage.completion, endAt - ft.at) : null;
        record(modelId, { provider, canonical, ms: endAt - t0, stream: true, error: null, account: acc.name, keyProvider: acc.keyProvider || null, keyFilter: acc.keyFilter || null, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, usage, ttftMs, tps, tpsApprox: false });
        cb();
      },
    });
    Readable.fromWeb(up.body).pipe(tap).pipe(res);
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  // 客户端实际使用成功的新订阅模型自动收录进列表
  if (status === 200 && /^cline-pass\//.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
    keyProvider: acc?.keyProvider || null,
    keyFilter: acc?.keyFilter || null,
    ...(status === 200 ? nonStreamMetrics(out, chain.trace) : {}),
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
    'X-Cline-Key-Filter': config.perModel[modelId]?.officialOnly ? (acc?.keyFilter || 'unknown') : 'off',
    'X-Cline-Key-Route': headerSafe(acc?.keyProvider || 'unknown'),
  });
  res.end(JSON.stringify(out));
}

// ---------- HTTP 服务 ----------
function sendJSON(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(JSON.stringify(obj));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/') || CHAT_PATHS.has(p)) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const sub = config.knownModels.map((id) => ({ id, config: config.perModel[id] || {}, meta: META.models[id] || null, keyFilter: keyRouteView(id) }));
      // 汇总钉住失效告警：planner 管道官方已忽略 providerOptions.gateway.only 的模型
      const alerts = [];
      for (const id of config.knownModels) {
        const ph = META.models[id]?.pinHealth;
        if (ph && ph.ok === false) {
          alerts.push({ model: id, pipeline: ph.pipeline || 'planner', reason: ph.reason || '', actual: ph.actual || null, requested: ph.requested || null, checkedAt: ph.checkedAt || null });
        }
      }
      return sendJSON(res, 200, { subscription: sub, hiddenModels: config.hiddenModels || [], catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null, alerts });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/probe-accounts') {
      // 账号维度探测：同一模型在账号池中每个账号下实际命中的上游供应商
      const { model, includeDisabled } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      if (!(config.accounts || []).some((a) => a && a.key && (includeDisabled || a.enabled !== false))) {
        return sendJSON(res, 400, { error: { message: '没有可探测的账号（检查是否已启用或勾选「包含未启用账号」）' } });
      }
      const r = await probeAccounts(model, { includeDisabled: !!includeDisabled });
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'POST' && p === '/api/key-routing') {
      // 立即检测某模型下每个 key 实际命中的上游，并刷新「仅官方渠道 key」的判定结果
      const { model, includeDisabled } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      if (!(config.accounts || []).some((a) => a && a.key && (includeDisabled || a.enabled !== false))) {
        return sendJSON(res, 400, { error: { message: '没有可检测的账号（检查是否已启用）' } });
      }
      const r = await refreshKeyRouting({ models: [model], includeDisabled: !!includeDisabled, force: true, source: 'manual' });
      return sendJSON(res, 200, { ok: true, probed: r.probed, updatedAt: Date.now(), ...keyRouteView(model) });
    }
    if (req.method === 'POST' && p === '/api/check-pin') {
      // 零 token 哨兵：判断 providerOptions.gateway.only 是否仍被网关遵守（专治静默失效）
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const r = await verifyPin(model);
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'POST' && p === '/api/test') {
      // 临时配置可带 upstreams/exclude（数组）或旧版 upstream（单值）、retries，完整走故障转移链路
      const { model, upstream, upstreams, exclude, retries } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const t0 = Date.now();
      const cfg = { ...(config.perModel[model] || {}) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      if (retries !== undefined) cfg.retries = retries;
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      await ensureKeyRouting(model);
      const kfs = officialFilterState(model);
      if (kfs.active && !kfs.ok) {
        enabledAccounts().forEach((a) => scheduleAccountProbe(model, a, { source: 'no-official' }));
        return sendJSON(res, 200, { ok: false, error: `没有可用的官方渠道 key（官方渠道：${kfs.official.join(', ')}），已拒绝回退到非官方 key`, targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace: [] });
      }
      const chain = await runChatChain(req, body, model, cfg, { stream: false, attemptTimeoutMs: 180000, res });
      const trace = chain.trace || [];
      if (chain.status !== 200) {
        record(model, { source: 'test', provider: null, canonical: null, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), trace, error: (chain.out?.error?.message || 'upstream error').slice?.(0, 300) || 'upstream error', account: chain.acc?.name || null, keyProvider: chain.acc?.keyProvider || null, keyFilter: chain.acc?.keyFilter || null });
        return sendJSON(res, 200, {
          ok: false, error: (chain.out?.error?.message || 'upstream error').slice?.(0, 400) || 'upstream error',
          targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace,
        });
      }
      const r = parseRouting(chain.out);
      record(model, { source: 'test', provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), trace, error: null, account: chain.acc?.name || null, keyProvider: chain.acc?.keyProvider || null, keyFilter: chain.acc?.keyFilter || null, ...nonStreamMetrics(chain.out, trace) });
      return sendJSON(res, 200, {
        ok: true, ms: Date.now() - t0,
        targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [],
        actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null,
        canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120),
        account: chain.acc?.name || null, trace,
      });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJSON(res, 200, {
        accounts: (config.accounts || []).map((a) => ({ ...a, quota: quotaFor(a) })),
        rotation: 'roundrobin',   // 仅按请求轮询，无会话粘性 / 无其它负载均衡策略
        stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const accs = (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a, i) => ({
          name: String(a.name || `账号${i + 1}`).slice(0, 50),
          key: String(a.key || '').trim(),
          enabled: a.enabled !== false,
        }))
        .filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      config.accounts = accs;
      saveConfig();
      RR_COUNTER = 0;
      refreshQuotas().catch(() => {}); // 保存后后台刷新额度，不阻塞响应
      // 新增/换 key 后，对开启了「仅官方渠道 key」的模型重新检测
      refreshKeyRouting({ source: 'accounts-save' }).catch(() => {});
      return sendJSON(res, 200, { ok: true, accounts: config.accounts.length, rotation: 'roundrobin' });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = JSON.parse(await readBody(req).then((b) => b.toString()));
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      // 测试的 key 可能还没保存进账号池，这时账号列显示「未保存的 key」
      const known = (config.accounts || []).find((a) => a.key === k);
      noteInternal('account-test', model, { acc: { name: known ? known.name : '未保存的 key' }, json, ms: Date.now() - t0 });
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'POST' && p === '/api/quota/refresh') {
      await refreshQuotas();
      return sendJSON(res, 200, { ok: true, quota: META.quota });
    }
    if (req.method === 'GET' && p === '/api/security') {
      return sendJSON(res, 200, { proxyKey: config.proxyKey || '', publicBaseUrl: config.publicBaseUrl || '', authRequired: !!PROXY_KEY, exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.proxyKey !== undefined) config.proxyKey = String(body.proxyKey).trim();
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, { ok: true, proxyKey: config.proxyKey, publicBaseUrl: config.publicBaseUrl, authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const { results, pinBroken } = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, pinBroken, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels, hiddenModels: config.hiddenModels || [] });
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.hiddenModels) {
        // 控制台“隐藏模型”只是前端展示偏好：保存到顶层列表，不写入 perModel，也不影响代理。
        config.hiddenModels = [...new Set((Array.isArray(body.hiddenModels) ? body.hiddenModels : [])
          .map((s) => String(s).trim()).filter(Boolean))];
        saveConfig();
      }
      if (body.perModel) {
        const keyFilterChanged = [];
        for (const [m, c] of Object.entries(body.perModel)) {
          const normalize = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
          let upstreams = normalize(c.upstreams);
          const exclude = normalize(c.exclude);
          const excl = new Set(exclude);
          upstreams = upstreams.filter((u) => !excl.has(u)); // 同时出现以 exclude 为准
          const upstream = upstreams[0] || null; // 旧字段兼容镜像
          const officialOnly = !!c.officialOnly;
          config.perModel[m] = {
            upstream,
            upstreams,
            exclude,
            pinMode: c.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: ['cost', 'ttft', 'tps'].includes(c.sort) ? c.sort : null,
            retries: normRetries(c.retries),
            officialOnly,
            officialProviders: normalize(c.officialProviders).slice(0, 5),
          };
          if (officialOnly) keyFilterChanged.push(m);
        }
        saveConfig();
        // 刚开启过滤的模型：后台立即做一次 key 路由检测，避免首个请求等待
        if (keyFilterChanged.length) refreshKeyRouting({ models: keyFilterChanged, source: 'config' }).catch(() => {});
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog())])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, 500, { error: { message: e.message } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

server.on('error', (e) => {
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1`);
});

// ---------- 订阅模型清单自动同步 ----------
// knownModels 只是 config.example.json 里的静态种子清单，官方上新（如 cline-pass/deepseek-v4.1-flash）
// 时不会自动出现，只能靠手动点「拉取官方最新模型」，很容易漏。这里启动后拉一次并定时复查，
// 只增不删、失败静默，不影响服务启动。设 MODELS_REFRESH_HOURS=0 可关闭。
const MODELS_REFRESH_HOURS = Number(process.env.MODELS_REFRESH_HOURS ?? 6);
async function autoRefreshModels() {
  try {
    const r = await fetchOfficialModels();
    if (r.added?.length) console.log(`[模型同步] 新增 ${r.added.length} 个订阅模型：${r.added.join('、')}`);
    else if (!r.sources.length) console.warn('[模型同步] 所有来源均不可达，清单保持不变');
  } catch (e) {
    console.warn(`[模型同步] 拉取失败（不影响服务）：${e.message}`);
  }
}
if (Number.isFinite(MODELS_REFRESH_HOURS) && MODELS_REFRESH_HOURS > 0) {
  setTimeout(autoRefreshModels, 3000).unref();
  setInterval(autoRefreshModels, MODELS_REFRESH_HOURS * 3600 * 1000).unref();
}

// ---------- 账号额度定时刷新 ----------
// 启动后拉一次，之后每 QUOTA_REFRESH_MINUTES 分钟自动刷新；失败静默（错误已记入 META.quota）。
if (Number.isFinite(QUOTA_REFRESH_MINUTES) && QUOTA_REFRESH_MINUTES > 0) {
  setTimeout(() => refreshQuotas().catch(() => {}), 1500).unref();
  setInterval(() => refreshQuotas().catch(() => {}), QUOTA_REFRESH_MINUTES * 60 * 1000).unref();
}

// ---------- 按 key 的路由定时检测 ----------
// 只检测开启了「仅官方渠道 key」（perModel[].officialOnly）的模型：逐 key 发一条最小流式请求，
// 记录该 key 当前实际命中的上游。用于自动发现 key 从非官方恢复为官方（或反过来），
// 无需人工点「检测 key 路由」。设 ACCOUNT_ROUTE_REFRESH_MINUTES=0 可关闭。
if (Number.isFinite(ACCOUNT_ROUTE_REFRESH_MINUTES) && ACCOUNT_ROUTE_REFRESH_MINUTES > 0) {
  setTimeout(() => {
    refreshKeyRouting({ source: 'startup' })
      .then((r) => { if (r.models.length) console.log(`[key路由] 启动检测完成：${r.models.length} 个模型 / ${r.probed} 次探测`); })
      .catch((e) => console.warn(`[key路由] 启动检测失败（不影响服务）：${e.message}`));
  }, 4000).unref();
  setInterval(() => {
    refreshKeyRouting({ source: 'scheduled' })
      .then((r) => { if (r.models.length) console.log(`[key路由] 定时检测完成：${r.models.length} 个模型 / ${r.probed} 次探测`); })
      .catch((e) => console.warn(`[key路由] 定时检测失败（不影响服务）：${e.message}`));
  }, ACCOUNT_ROUTE_REFRESH_MINUTES * 60 * 1000).unref();
}
