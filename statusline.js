#!/usr/bin/env node
/**
 * statusline.js — Claude Code statusline.
 *
 * Reads JSON from stdin (Claude Code passes session info), renders one line:
 *   model | dir | git-branch | billing | ctx
 *
 * billing segment (price table in statusline-pricing.json):
 *   - Anthropic subscription (rate_limits present): 5h / 7d window usage with
 *     reset time, usage-credit spend if any; the API-equivalent $ only with STATUSLINE_API_COST=1.
 *     Optional per-model weekly windows come from the local OAuth credentials and
 *     an undocumented usage endpoint; off by default, enable with STATUSLINE_MODEL_LIMITS=1.
 *   - Anthropic API key (no rate_limits): cost.total_cost_usd.
 *   - Other vendor (ANTHROPIC_BASE_URL matches a `vendors` entry): a
 *     subscription label, or the cost summed from the transcript's usage
 *     records (main + subagents, deduplicated by requestId, peak/off-peak by
 *     record timestamp). Incremental: byte offsets and the running total are
 *     cached in $TMP/claude-statusline-cost-<session_id>.json.
 *
 * ctx segment: context_window.used_percentage / context_window_size from
 * Claude Code; falls back to the transcript tail on old versions.
 * cache segment: last request's cache-hit share (context_window.current_usage),
 * uncached tokens, and prompt_cache expiry.
 * Override the assumed window with CLAUDE_CTX_LIMIT (tokens).
 *
 * Wire up in settings.json:
 *   "statusLine": { "type": "command", "command": "node \"$HOME/.claude/hooks/statusline.js\"" }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const PRICING_PATH = process.env.STATUSLINE_PRICING || path.join(__dirname, 'statusline-pricing.json');
const GIT_CACHE_TTL_MS = 5000;
const SEEN_IDS_KEPT = 1000; // duplicate requestIds are adjacent; a small window suffices

const C = {
  cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', magenta: '\x1b[35m',
  red: '\x1b[1;31m', gray: '\x1b[90m', reset: '\x1b[0m',
};
const paint = (color, s) => `${color}${s}${C.reset}`;
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- git

function gitCachePath(dir) {
  const key = String(dir).replace(/[^A-Za-z0-9_\-]/g, '-');
  return path.join(os.tmpdir(), `claude-statusline-git-${key}.json`);
}

function cachedGitInfo(dir) {
  const cachePath = gitCachePath(dir);
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - c.ts < GIT_CACHE_TTL_MS) return { branch: c.branch, dirty: c.dirty };
  } catch { /* recompute */ }
  const branch = gitBranch(dir);
  const dirty = branch ? gitDirty(dir) : false;
  try { fs.writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), branch, dirty })); } catch { /* ok */ }
  return { branch, dirty };
}

function gitBranch(dir) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 1000 });
  if (r.status !== 0) return null;
  const b = (r.stdout || '').trim();
  return b && b !== 'HEAD' ? b : null;
}

function gitDirty(dir) {
  const r = spawnSync('git', ['status', '--porcelain', '-uno'], { cwd: dir, encoding: 'utf8', timeout: 1000 });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

// ---------------------------------------------------------------- pricing

function loadPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8')); } catch { return { vendors: {} }; }
}

function detectVendor(pricing) {
  const base = (process.env.ANTHROPIC_BASE_URL || '').toLowerCase();
  if (!base) return { key: 'anthropic' };
  for (const [key, cfg] of Object.entries(pricing.vendors || {})) {
    const pats = [].concat(cfg.match || []);
    if (pats.some((p) => base.includes(String(p).toLowerCase()))) return { key, cfg };
  }
  return { key: 'unknown', base };
}

function normModel(id) {
  return String(id || '').toLowerCase().replace(/\[1m\]$/, '').trim();
}

function findRate(models, modelId) {
  if (!models) return null;
  const m = normModel(modelId);
  if (models[m]) return models[m];
  let best = null;
  for (const k of Object.keys(models)) {
    if (m.startsWith(k.toLowerCase()) && (!best || k.length > best.length)) best = k;
  }
  return best ? models[best] : null;
}

// Rates in the table are off-peak; a request inside a peak window is multiplied.
function peakFactor(cfg, tsMs) {
  const p = cfg.peak;
  if (!p) return 1;
  const d = new Date(tsMs + (p.tz_offset_hours || 0) * 3600e3);
  if (p.weekdays && !p.weekdays.includes(d.getUTCDay())) return 1;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const inWindow = (p.windows || []).some(([a, b]) => h >= a && h < b);
  return inWindow ? (p.multiplier || 1) : 1;
}

function recordCost(cfg, usage, modelId, tsMs) {
  const r = findRate(cfg.models, modelId);
  if (!r) return null;
  const sum = (usage.input_tokens || 0) * r.input
    + (usage.output_tokens || 0) * r.output
    + (usage.cache_read_input_tokens || 0) * r.cacheRead
    + (usage.cache_creation_input_tokens || 0) * r.cacheWrite;
  return peakFactor(cfg, tsMs) * sum / 1e6;
}

// ---------------------------------------------------------------- transcript cost (non-Anthropic vendors)

function costCachePath(sessionId) {
  const key = String(sessionId).replace(/[^A-Za-z0-9_\-]/g, '-');
  return path.join(os.tmpdir(), `claude-statusline-cost-${key}.json`);
}

// Reads the complete lines appended since state.offset and adds their cost to acc.
// With observe=true also measures prompt-cache survival: a second request that
// still read from cache is a lower bound on the vendor's cache lifetime
// (acc.obs.longestHit); a request that read no cache after a gap of 5+ minutes
// is a candidate expiry (acc.obs.shortestMiss). acc.obs.last keeps the latest
// qualifying observation so a shortened TTL can lower the estimate.
function scanFile(file, state, seen, cfg, acc, observe) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (state.offset > size) state.offset = 0; // file rewritten
  if (size === state.offset) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - state.offset);
  fs.readSync(fd, buf, 0, buf.length, state.offset);
  fs.closeSync(fd);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return; // no complete line yet
  const text = buf.toString('utf8', 0, lastNl + 1);
  state.offset += lastNl + 1;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o && o.message && o.message.usage;
    if (!u || u.input_tokens == null) continue;
    const rid = o.requestId || (o.message && o.message.id) || null;
    if (rid) {
      if (seen.has(rid)) continue; // one API response is logged once per content block
      seen.add(rid);
    }
    const ts = Date.parse(o.timestamp) || Date.now();
    const c = recordCost(cfg, u, o.message.model, ts);
    if (c === null) acc.unpriced += 1; else acc.cost += c;
    if (observe) {
      const model = normModel(o.message.model);
      const hit = u.cache_read_input_tokens || 0;
      const fresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      // A gap counts only between two requests to the same model (a /model
      // switch mid-session would otherwise mix two cache policies).
      if (state.prevTs && model && state.prevModel === model) {
        const gap = Math.round((ts - state.prevTs) / 1000);
        const ob = acc.obs[model] || (acc.obs[model] = { longestHit: 0, shortestMiss: 0, last: null });
        if (hit >= 1000 && gap > ob.longestHit) ob.longestHit = gap;
        if (hit === 0 && fresh >= 1000 && gap >= 300 && (!ob.shortestMiss || gap < ob.shortestMiss)) ob.shortestMiss = gap;
        if (hit >= 1000 && gap > 0) ob.last = { type: 'hit', gap };
        else if (hit === 0 && fresh >= 1000 && gap >= 300) ob.last = { type: 'miss', gap };
      }
      state.prevTs = ts;
      state.prevModel = model;
    }
  }
}

const CACHE_DIR = process.env.STATUSLINE_CACHE_DIR || path.join(os.homedir(), '.claude', 'cache');
const OBSERVED_PATH = path.join(CACHE_DIR, 'statusline-cache-observed.json');

function loadObserved() {
  try { return JSON.parse(fs.readFileSync(OBSERVED_PATH, 'utf8')); } catch { return {}; }
}

// Merge this session's observations into the per-vendor, per-model record
// (max hit gap, min miss gap, latest observation). obsByModel:
// { model: { longestHit, shortestMiss, last: {type, gap} } }.
function saveObserved(vendorKey, obsByModel) {
  const models = Object.keys(obsByModel);
  if (!models.length) return;
  const all = loadObserved();
  const v = all[vendorKey] || (all[vendorKey] = {});
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const m of models) {
    const obs = obsByModel[m];
    const r = v[m] || (v[m] = {});
    let modelChanged = false;
    if (obs.longestHit > (r.longest_hit_gap_s || 0)) {
      r.longest_hit_gap_s = obs.longestHit;
      modelChanged = true;
    }
    if (obs.shortestMiss && (!r.shortest_miss_gap_s || obs.shortestMiss < r.shortest_miss_gap_s)) {
      r.shortest_miss_gap_s = obs.shortestMiss;
      modelChanged = true;
    }
    // Bidirectional estimate: a hit raises the lower bound, a miss after a
    // shorter gap lowers the upper bound. The latest qualifying observation
    // decides the final adjustment.
    let est = r.ttl_estimate_s || r.longest_hit_gap_s || 0;
    if (obs.longestHit) est = Math.max(est, obs.longestHit);
    if (obs.shortestMiss) est = Math.min(est, obs.shortestMiss);
    if (obs.last) {
      if (obs.last.type === 'hit') est = Math.max(est, obs.last.gap);
      else est = Math.min(est, obs.last.gap);
    }
    if (est > 0 && est !== r.ttl_estimate_s) {
      r.ttl_estimate_s = est;
      r.ttl_source = obs.last ? obs.last.type : (obs.shortestMiss ? 'miss' : 'hit');
      modelChanged = true;
    }
    if (modelChanged) {
      r.updated = today;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    fs.mkdirSync(path.dirname(OBSERVED_PATH), { recursive: true });
    fs.writeFileSync(OBSERVED_PATH, JSON.stringify(all, null, 2));
  } catch { /* ok */ }
}

function vendorCost(input, vendor) {
  const tp = input.transcript_path;
  if (!tp) return null;
  const cfg = vendor.cfg;
  const sid = input.session_id || path.basename(tp, '.jsonl');
  const cachePath = costCachePath(sid);
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
  cache.files = cache.files || {};
  const seen = new Set(cache.seen || []);
  const acc = { cost: cache.cost || 0, unpriced: cache.unpriced || 0, obs: {} };

  const files = [tp];
  const subDir = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents');
  try {
    for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
  } catch { /* no subagents yet */ }
  for (const f of files) {
    const st = cache.files[f] || (cache.files[f] = { offset: 0 });
    scanFile(f, st, seen, cfg, acc, f === tp); // cache survival is measured on the main conversation only
  }
  cache.seen = Array.from(seen).slice(-SEEN_IDS_KEPT);
  cache.cost = acc.cost;
  cache.unpriced = acc.unpriced;
  try { fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* ok */ }
  saveObserved(vendor.key, acc.obs);
  return acc;
}

// ---------------------------------------------------------------- billing segment

// Reset time: HH:MM when inside 24h, otherwise M/D.
function fmtReset(epochSec) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  if (d.getTime() - Date.now() > 86400e3) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pctColor(p) {
  if (p >= 90) return C.red;
  if (p >= 70) return C.yellow;
  return C.green;
}

function windowPart(name, w) {
  if (!w || w.used_percentage == null) return null;
  const reset = fmtReset(w.resets_at);
  return paint(pctColor(w.used_percentage), `${name} ${Math.round(w.used_percentage)}%`)
    + (reset ? paint(C.gray, ` @${reset}`) : '');
}

// ---------------------------------------------------------------- per-model weekly windows

// Claude Code (2.1.301, same in 2.1.302) passes only five_hour / seven_day / spend_limit to the
// status line. Optional per-model weekly windows are rows of limits[]
// with kind "weekly_scoped" in GET /api/oauth/usage, the endpoint behind /usage.
// A detached child fetches it so the status line never waits on the network;
// the result is cached account-wide (one file per config dir) in $TMP.
// STATUSLINE_MODEL_LIMITS=0 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turns it off.
const USAGE_TTL_MS = 180e3;
const USAGE_BACKOFF_MS = 600e3; // after a failed fetch (expired token, 429)
const USAGE_TIMEOUT_MS = 8000;
const USAGE_STALE_MS = 1800e3; // older data is shown gray with "?"

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function usageCachePath() {
  const key = configDir().replace(/[^A-Za-z0-9_\-]/g, '-');
  return path.join(os.tmpdir(), `claude-statusline-usage-${key}.json`);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Cached windows [{ name, used_percentage, resets_at, stale }]; starts a
// background refresh when the cache is due and no refresh is running.
function modelWindows() {
  if (process.env.STATUSLINE_MODEL_LIMITS === '0' || process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return [];
  const cachePath = usageCachePath();
  const c = readJson(cachePath) || {};
  const now = Date.now();
  const due = (c.checked_at || 0) + (c.error ? USAGE_BACKOFF_MS : USAGE_TTL_MS) <= now;
  const running = c.started_at && now - c.started_at < USAGE_TIMEOUT_MS * 2;
  if (due && !running) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ ...c, started_at: now }));
      spawn(process.execPath, [__filename, '--refresh-usage'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { /* ok */ }
  }
  const stale = !c.ok_at || now - c.ok_at > USAGE_STALE_MS;
  return (c.windows || [])
    .filter((w) => !w.resets_at || w.resets_at * 1000 > now) // Claude Code also drops a window once it resets
    .map((w) => ({ ...w, stale }));
}

// Child process: one GET /api/oauth/usage, result written to the cache.
function refreshUsage() {
  const cachePath = usageCachePath();
  const prev = readJson(cachePath) || {};
  delete prev.started_at;
  const finish = (patch) => {
    try { fs.writeFileSync(cachePath, JSON.stringify({ ...prev, ...patch, checked_at: Date.now() })); } catch { /* ok */ }
  };
  const cred = (readJson(path.join(configDir(), '.credentials.json')) || {}).claudeAiOauth || {};
  // Never refresh the OAuth token here: that rotates the refresh token Claude Code holds.
  // An expired token waits for Claude Code to renew it.
  if (!cred.accessToken || (cred.expiresAt && cred.expiresAt <= Date.now())) return finish({ error: 'token' });
  const req = https.request({
    host: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: USAGE_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) return finish({ error: `http ${res.statusCode}` });
      let j;
      try { j = JSON.parse(body); } catch { return finish({ error: 'json' }); }
      const windows = (Array.isArray(j.limits) ? j.limits : [])
        .filter((l) => l && l.kind === 'weekly_scoped' && l.scope && l.scope.model && typeof l.scope.model.display_name === 'string')
        .map((l) => ({
          name: l.scope.model.display_name,
          used_percentage: typeof l.percent === 'number' ? l.percent : null,
          resets_at: l.resets_at ? Math.floor(Date.parse(l.resets_at) / 1000) || null : null,
        }));
      finish({ error: null, ok_at: Date.now(), windows });
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => finish({ error: String(e.message || e).slice(0, 80) }));
  req.end();
}

// Currency symbol for a vendor's cost: explicit CNY -> ¥, USD -> $,
// otherwise the vendor's symbol (fallback $).
function moneySymbol(cfg) {
  if (cfg.currency === 'CNY') return '¥';
  if (cfg.currency === 'USD') return '$';
  return cfg.symbol || '$';
}

// Returns a list of segments; the caller joins them with the separator.
// acc: result of vendorCost() for non-Anthropic vendors, else null.
function billingSegments(input, vendor, acc) {
  const cost = input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;

  if (vendor.key === 'anthropic') {
    const rl = input.rate_limits || {};
    const parts = [windowPart('5h', rl.five_hour), windowPart('7d', rl.seven_day)].filter(Boolean);
    if (parts.length && process.env.STATUSLINE_MODEL_LIMITS === '1') {
      for (const w of modelWindows()) {
        const p = windowPart(w.name, w);
        if (p) parts.push(w.stale ? paint(C.gray, `${w.name} ${Math.round(w.used_percentage)}%?`) : p);
      }
    }
    if (rl.spend_limit && rl.spend_limit.used_percentage != null) {
      const s = rl.spend_limit;
      const usd = s.used_usd != null && s.limit_usd != null ? paint(C.gray, ` $${s.used_usd.toFixed(0)}/${s.limit_usd}`) : '';
      parts.push(paint(pctColor(s.used_percentage), `credits ${Math.round(s.used_percentage)}%`) + usd);
    }
    if (parts.length) {
      // Subscription: the dollar figure is only what the same usage would cost on the API.
      // Hidden unless STATUSLINE_API_COST=1.
      if (cost !== null && process.env.STATUSLINE_API_COST === '1') parts.push(paint(C.gray, `api $${cost.toFixed(2)}`));
      return parts;
    }
    return cost !== null ? [paint(C.magenta, `$${cost.toFixed(2)}`)] : [];
  }

  if (!vendor.cfg) {
    const host = String(vendor.base || '').replace(/^https?:\/\//, '').split('/')[0];
    return [paint(C.gray, `${host} ?`)];
  }
  const cfg = vendor.cfg;
  const label = cfg.label || vendor.key;
  if (cfg.subscription) return [paint(C.magenta, `${label} ${cfg.subscription}`)];
  if (!acc) return [paint(C.gray, label)];
  let s = paint(C.magenta, `${label} ${moneySymbol(cfg)}${acc.cost.toFixed(2)}`);
  if (cfg.peak) {
    s += paint(C.gray, ' ' + (peakFactor(cfg, Date.now()) > 1 ? (cfg.peak.label_peak || 'peak') : (cfg.peak.label_offpeak || 'off-peak')));
  }
  if (acc.unpriced) s += paint(C.gray, ` +${acc.unpriced}?`);
  return [s];
}

// ---------------------------------------------------------------- ctx segment

// Fallback for Claude Code versions that don't pass context_window: last usage
// record in the transcript tail (input + cache_creation + cache_read).
function contextTokens(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const u = obj && obj.message && obj.message.usage;
      if (u && u.input_tokens != null) {
        return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
    }
  } catch { /* no transcript yet */ }
  return null;
}

function contextLimit(modelId) {
  if (process.env.CLAUDE_CTX_LIMIT) {
    const ov = parseInt(process.env.CLAUDE_CTX_LIMIT, 10);
    if (ov > 0) return ov;
  }
  return /1m/i.test(modelId || '') ? 1000000 : 200000;
}

function ctxSegment(input) {
  const cw = input.context_window || {};
  let pct = cw.used_percentage;
  let limit = cw.context_window_size;
  let tokens = cw.total_input_tokens;
  if (process.env.CLAUDE_CTX_LIMIT) limit = contextLimit(input.model && input.model.id);
  if (pct == null || process.env.CLAUDE_CTX_LIMIT) {
    if (tokens == null || tokens === 0) tokens = input.transcript_path ? contextTokens(input.transcript_path) : null;
    if (tokens === null) return null;
    limit = limit || contextLimit(input.model && input.model.id);
    pct = (tokens / limit) * 100;
  }
  pct = Math.round(pct);
  const detail = tokens != null ? paint(C.gray, ` ${Math.round(tokens / 1000)}k`) : '';
  if (pct >= 80) return paint(C.red, `ctx ${pct}%!`) + detail;
  if (pct >= 60) return paint(C.yellow, `ctx ${pct}%`) + detail;
  return paint(C.green, `ctx ${pct}%`) + detail;
}

// ---------------------------------------------------------------- cache segment

// Timestamp (ms) of the last usage record in the transcript tail; null if none.
function lastRequestTs(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      if (obj && obj.message && obj.message.usage && obj.timestamp) {
        const t = Date.parse(obj.timestamp);
        if (t) return t;
      }
    }
  } catch { /* no transcript yet */ }
  return null;
}

// Cache expiry: Anthropic -> prompt_cache.expires_at (Claude Code knows the TTL
// it requested). Other vendors -> last request + the vendor's cache_ttl_minutes
// from the price table; with no TTL configured, the bidirectional observed
// estimate (cache/statusline-cache-observed.json), marked with "~".
// Returns { text, expired } or null. text is the expiry time (prefixed "~" when
// estimated) or "cold" when the time is unknown; expired=true -> shown in red.
function cacheExpiry(input, vendor) {
  const pc = input.prompt_cache;
  if (vendor.key === 'anthropic') {
    if (!pc) return null;
    const expired = pc.warm === false || (pc.expires_at && pc.expires_at * 1000 <= Date.now());
    if (!pc.expires_at) return expired ? { text: 'cold', expired: true } : null;
    return { text: fmtReset(pc.expires_at), expired };
  }
  if (!input.transcript_path) return null;
  const cfg = vendor.cfg || {};
  const model = normModel(input.model && input.model.id);
  // TTL: the model row's cache_ttl_minutes, else the vendor's, else the longest
  // cache-surviving gap observed for this vendor+model.
  const row = findRate(cfg.models, model);
  const ttlMin = (row && row.cache_ttl_minutes) || cfg.cache_ttl_minutes || 0;
  let ttlMs = ttlMin * 60e3;
  let estimated = false;
  if (!ttlMs) {
    const ob = (loadObserved()[vendor.key] || {})[model];
    const observed = ob && (ob.ttl_estimate_s || ob.longest_hit_gap_s);
    if (observed >= 60) { ttlMs = observed * 1000; estimated = true; }
  }
  if (!ttlMs) return null;
  const last = lastRequestTs(input.transcript_path);
  if (!last) return null;
  const exp = last + ttlMs;
  return { text: (estimated ? '~' : '') + fmtReset(Math.floor(exp / 1000)), expired: exp <= Date.now() };
}

// Last request: share of input served from the prompt cache, tokens that were
// not (fresh input + cache writes), and when the warm cache expires.
function cacheSegment(input, vendor) {
  const cu = input.context_window && input.context_window.current_usage;
  if (!cu) return null;
  const hit = cu.cache_read_input_tokens || 0;
  const miss = (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
  const total = hit + miss;
  if (!total) return null;
  const pct = Math.round((hit / total) * 100);
  const color = pct >= 80 ? C.green : pct >= 50 ? C.yellow : C.red;
  let s = paint(color, `cache ${pct}%`);
  if (miss >= 1000) s += paint(C.gray, ` miss ${Math.round(miss / 1000)}k`);
  const exp = cacheExpiry(input, vendor);
  if (exp) {
    const t = exp.text === 'cold' ? ' cold' : ` @${exp.text}`;
    s += paint(exp.expired ? C.red : C.gray, t); // red: the cached prefix has expired
  }
  return s;
}

// ---------------------------------------------------------------- main

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* ok */ }

  const model = ((input.model && (input.model.display_name || input.model.id)) || 'claude').replace(/\[1m\]$/, '');
  const cwd = (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) || process.cwd();
  const { branch, dirty } = cachedGitInfo(cwd);
  const vendor = detectVendor(loadPricing());
  // Scan the transcript for every known non-Anthropic vendor: cost for priced
  // ones, cache-survival observation for all of them.
  const acc = vendor.key !== 'anthropic' && vendor.cfg ? vendorCost(input, vendor) : null;

  const parts = [];
  parts.push(paint(C.cyan, model));
  parts.push(paint(C.yellow, path.basename(cwd)) + (branch ? paint(C.gray, ` ${branch}${dirty ? '*' : ''}`) : ''));
  parts.push(...billingSegments(input, vendor, acc));
  const ctx = ctxSegment(input);
  if (ctx) parts.push(ctx);
  const cache = cacheSegment(input, vendor);
  if (cache) parts.push(cache);

  process.stdout.write(parts.join(paint(C.gray, ' · ')));
}

if (process.argv[2] === '--refresh-usage') refreshUsage();
else main();
