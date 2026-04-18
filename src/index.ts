/**
 * WHOOP → Athlete Management System · Cloudflare Worker OAuth proxy
 * --------------------------------------------------------------------
 * Responsibilities:
 *   1. Own the WHOOP client_secret (never exposed to the browser).
 *   2. Run the OAuth 2.0 authorization-code flow per athlete.
 *   3. Store refresh tokens in KV, AES-GCM encrypted with ENC_KEY.
 *   4. Transparently refresh short-lived access tokens (~1h).
 *   5. Proxy WHOOP v2 reads and normalize the shape the HTML consumes
 *      (matches pdvGetWhoopSeries row schema exactly).
 *   6. Lock down with a shared APP_SECRET header so randos on the
 *      internet can't use your proxy to hit WHOOP.
 *
 * API (what the HTML calls):
 *   GET  /auth/start?athleteId=X            → 302 → WHOOP consent screen
 *   GET  /auth/callback?code=...&state=...  → 302 → REDIRECT_AFTER_AUTH
 *   GET  /api/recovery?athleteId=X&days=30  → normalized recovery rows
 *   GET  /api/sleep?athleteId=X&days=30     → normalized sleep rows
 *   GET  /api/cycle?athleteId=X&days=30     → cycle + strain rows
 *   GET  /api/workout?athleteId=X&days=30   → workout rows
 *   GET  /api/profile?athleteId=X           → basic profile + body
 *   GET  /api/series?athleteId=X&days=90    → merged row per day
 *                                              (drop-in for mock schema)
 *   GET  /api/status?athleteId=X            → { connected: bool, ... }
 *   POST /webhooks/whoop                    → WHOOP webhook receiver
 *                                              (verify signature, cache)
 *
 * WHOOP v2 endpoints used (confirmed April 2026, post-v1 deprecation):
 *   https://api.prod.whoop.com/developer/v2/recovery
 *   https://api.prod.whoop.com/developer/v2/cycle
 *   https://api.prod.whoop.com/developer/v2/activity/sleep
 *   https://api.prod.whoop.com/developer/v2/activity/workout
 *   https://api.prod.whoop.com/developer/v2/user/profile/basic
 *   https://api.prod.whoop.com/developer/v2/user/measurement/body
 *
 * Scopes requested (includes `offline` for refresh tokens):
 *   read:recovery read:sleep read:workout read:cycles
 *   read:body_measurement read:profile offline
 */

export interface Env {
  // KV namespace — stores encrypted tokens + athleteId→whoopUserId map + cache
  WHOOP_KV: KVNamespace;

  // From WHOOP developer portal — both secrets, set with `wrangler secret put`
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;

  // Where this Worker is deployed (no trailing slash).
  // e.g. "https://whoop-proxy.les.workers.dev"
  SELF_ORIGIN: string;

  // Where the athlete lands after consent. Usually the URL of the HTML app.
  // e.g. "https://aos.les-spellman.com/#connected"
  REDIRECT_AFTER_AUTH: string;

  // Allowed browser origin for CORS. The HTML app's origin.
  // Use "*" only in dev.
  ALLOWED_ORIGIN: string;

  // Shared secret the HTML sends in `X-App-Secret` header. Blocks unauth'd use.
  APP_SECRET: string;

  // 32-byte hex key (64 chars) used for AES-GCM encryption of refresh tokens.
  // Generate once: `openssl rand -hex 32`
  ENC_KEY: string;

  // Optional — set when configuring webhooks in WHOOP dashboard
  WHOOP_WEBHOOK_SECRET?: string;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const WHOOP_AUTH  = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API   = 'https://api.prod.whoop.com/developer/v2';

const SCOPES = [
  'read:recovery',
  'read:sleep',
  'read:workout',
  'read:cycles',
  'read:body_measurement',
  'read:profile',
  'offline', // required for refresh_token
].join(' ');

// KV key helpers
const kTok   = (id: string) => `tok:${id}`;           // encrypted tokens blob
const kMap   = (id: string) => `map:${id}`;           // athleteId → whoopUserId
const kState = (s: string)  => `state:${s}`;          // one-time CSRF state
const kCache = (id: string, kind: string, days: number) =>
  `cache:${id}:${kind}:${days}`;

const CACHE_TTL_SECONDS = 15 * 60; // 15 min — recovery refreshes ~1x/day anyway

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // CORS preflight — the HTML runs in a browser
    if (req.method === 'OPTIONS') return corsPreflight(env);

    try {
      if (p === '/auth/start')    return authStart(req, env);
      if (p === '/auth/callback') return authCallback(req, env);
      if (p === '/webhooks/whoop') return webhookReceive(req, env);

      // Everything under /api/* requires APP_SECRET
      if (p.startsWith('/api/')) {
        const shared = req.headers.get('X-App-Secret') || url.searchParams.get('k');
        if (shared !== env.APP_SECRET) {
          return json({ error: 'unauthorized' }, 401, env);
        }
        if (p === '/api/status')   return apiStatus(req, env);
        if (p === '/api/recovery') return apiRecovery(req, env);
        if (p === '/api/sleep')    return apiSleep(req, env);
        if (p === '/api/cycle')    return apiCycle(req, env);
        if (p === '/api/workout')  return apiWorkout(req, env);
        if (p === '/api/profile')  return apiProfile(req, env);
        if (p === '/api/series')   return apiSeries(req, env);
      }

      if (p === '/' || p === '/health') {
        return json({ ok: true, service: 'whoop-proxy', ts: Date.now() }, 200, env);
      }
      return json({ error: 'not_found' }, 404, env);
    } catch (err: any) {
      console.error('worker error', err?.stack || err);
      return json({ error: 'internal', message: String(err?.message || err) }, 500, env);
    }
  },
};

// --------------------------------------------------------------------------
// OAuth: /auth/start
// --------------------------------------------------------------------------
// Redirect the athlete to WHOOP's consent screen. The `state` is a random
// token we store in KV with the athleteId, so the callback can verify it
// came from us and tie the resulting tokens to the right athlete.
async function authStart(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const athleteId = (url.searchParams.get('athleteId') || '').trim();
  if (!athleteId) return json({ error: 'missing_athleteId' }, 400, env);
  if (athleteId.length > 64) return json({ error: 'athleteId_too_long' }, 400, env);

  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  // Short TTL — the callback should happen within minutes.
  await env.WHOOP_KV.put(kState(state), athleteId, { expirationTtl: 600 });

  const auth = new URL(WHOOP_AUTH);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.WHOOP_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.SELF_ORIGIN + '/auth/callback');
  auth.searchParams.set('scope', SCOPES);
  auth.searchParams.set('state', state);

  return Response.redirect(auth.toString(), 302);
}

// --------------------------------------------------------------------------
// OAuth: /auth/callback
// --------------------------------------------------------------------------
// WHOOP redirects here with ?code=...&state=.... We exchange the code for
// tokens, encrypt+store them keyed by our athleteId, and bounce the user
// back to the HTML app.
async function authCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  if (err) return redirectWithHash(env.REDIRECT_AFTER_AUTH, { whoop: 'error', reason: err });
  if (!code || !state) return json({ error: 'missing_code_or_state' }, 400, env);

  const athleteId = await env.WHOOP_KV.get(kState(state));
  if (!athleteId) return json({ error: 'invalid_or_expired_state' }, 400, env);
  await env.WHOOP_KV.delete(kState(state));

  // Exchange code → tokens
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
    redirect_uri: env.SELF_ORIGIN + '/auth/callback',
  });
  const res = await fetch(WHOOP_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('token_exchange_failed', res.status, text);
    return redirectWithHash(env.REDIRECT_AFTER_AUTH, { whoop: 'error', reason: 'token_exchange_failed' });
  }
  const tok = await res.json() as WhoopTokenResponse;

  // Persist — encrypt refresh token at rest
  await saveTokens(env, athleteId, tok);

  // Resolve and cache the WHOOP user_id so we can tag webhook events later
  try {
    const profile = await whoopGet<{ user_id: number; email?: string; first_name?: string; last_name?: string }>(
      env, athleteId, '/user/profile/basic'
    );
    if (profile?.user_id) {
      await env.WHOOP_KV.put(kMap(athleteId), String(profile.user_id));
    }
  } catch (e) {
    console.warn('profile_fetch_after_auth_failed', e);
  }

  return redirectWithHash(env.REDIRECT_AFTER_AUTH, { whoop: 'connected', athleteId });
}

// --------------------------------------------------------------------------
// Token storage (AES-GCM encrypted in KV)
// --------------------------------------------------------------------------

interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
}

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
  scope?: string;
  updated_at: number;
}

async function saveTokens(env: Env, athleteId: string, tok: WhoopTokenResponse): Promise<StoredTokens> {
  const stored: StoredTokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in - 60) * 1000, // 1-min safety margin
    scope: tok.scope,
    updated_at: Date.now(),
  };
  const enc = await encryptJSON(stored, env.ENC_KEY);
  await env.WHOOP_KV.put(kTok(athleteId), enc);
  return stored;
}

async function loadTokens(env: Env, athleteId: string): Promise<StoredTokens | null> {
  const raw = await env.WHOOP_KV.get(kTok(athleteId));
  if (!raw) return null;
  try { return await decryptJSON<StoredTokens>(raw, env.ENC_KEY); }
  catch (e) { console.error('decrypt_failed', e); return null; }
}

async function ensureFreshAccessToken(env: Env, athleteId: string): Promise<string> {
  let tokens = await loadTokens(env, athleteId);
  if (!tokens) throw new HttpError(401, 'not_connected');
  if (Date.now() < tokens.expires_at) return tokens.access_token;

  // Refresh
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
    scope: SCOPES, // WHOOP requires scope on refresh
  });
  const res = await fetch(WHOOP_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('refresh_failed', res.status, text);
    // Refresh token likely revoked → force re-auth
    if (res.status === 400 || res.status === 401) {
      await env.WHOOP_KV.delete(kTok(athleteId));
    }
    throw new HttpError(401, 'refresh_failed');
  }
  const tok = await res.json() as WhoopTokenResponse;
  tokens = await saveTokens(env, athleteId, tok);
  return tokens.access_token;
}

// --------------------------------------------------------------------------
// WHOOP API caller with auto-refresh + retry
// --------------------------------------------------------------------------
async function whoopGet<T = any>(
  env: Env,
  athleteId: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const access = await ensureFreshAccessToken(env, athleteId);
  const u = new URL(WHOOP_API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  const doFetch = async (tok: string) => fetch(u.toString(), {
    headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' },
  });
  let res = await doFetch(access);
  // On 401, force-refresh once and retry
  if (res.status === 401) {
    const stored = await loadTokens(env, athleteId);
    if (stored) {
      stored.expires_at = 0;
      await env.WHOOP_KV.put(kTok(athleteId), await encryptJSON(stored, env.ENC_KEY));
    }
    const fresh = await ensureFreshAccessToken(env, athleteId);
    res = await doFetch(fresh);
  }
  if (res.status === 429) throw new HttpError(429, 'rate_limited');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, `whoop_upstream_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// Paginated collection fetcher — WHOOP uses `next_token` cursor pagination.
async function whoopPaginate<T>(
  env: Env,
  athleteId: string,
  path: string,
  params: Record<string, string | number | undefined>,
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await whoopGet<{ records: T[]; next_token?: string }>(env, athleteId, path, {
      ...params,
      nextToken,
      limit: 25,
    });
    if (Array.isArray(res.records)) out.push(...res.records);
    if (!res.next_token) break;
    nextToken = res.next_token;
  }
  return out;
}

// --------------------------------------------------------------------------
// API handlers — return shapes matched to the HTML's pdvGetWhoopSeries rows
// --------------------------------------------------------------------------

async function apiStatus(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const tokens = await loadTokens(env, athleteId);
  const whoopUserId = await env.WHOOP_KV.get(kMap(athleteId));
  return json({
    connected: !!tokens,
    whoopUserId: whoopUserId || null,
    tokenUpdatedAt: tokens?.updated_at || null,
    scope: tokens?.scope || null,
  }, 200, env);
}

async function apiRecovery(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const days = clamp(num(req, 'days', 30), 1, 180);
  const cached = await readCache(env, athleteId, 'recovery', days);
  if (cached) return json(cached, 200, env, true);

  const { start, end } = windowIso(days);
  const records = await whoopPaginate<WhoopRecovery>(env, athleteId, '/recovery', { start, end });

  const rows = records.map(mapRecovery);
  await writeCache(env, athleteId, 'recovery', days, rows);
  return json(rows, 200, env);
}

async function apiSleep(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const days = clamp(num(req, 'days', 30), 1, 180);
  const cached = await readCache(env, athleteId, 'sleep', days);
  if (cached) return json(cached, 200, env, true);

  const { start, end } = windowIso(days);
  const records = await whoopPaginate<WhoopSleep>(env, athleteId, '/activity/sleep', { start, end });
  const rows = records.map(mapSleep);
  await writeCache(env, athleteId, 'sleep', days, rows);
  return json(rows, 200, env);
}

async function apiCycle(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const days = clamp(num(req, 'days', 30), 1, 180);
  const cached = await readCache(env, athleteId, 'cycle', days);
  if (cached) return json(cached, 200, env, true);

  const { start, end } = windowIso(days);
  const records = await whoopPaginate<WhoopCycle>(env, athleteId, '/cycle', { start, end });
  const rows = records.map(mapCycle);
  await writeCache(env, athleteId, 'cycle', days, rows);
  return json(rows, 200, env);
}

async function apiWorkout(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const days = clamp(num(req, 'days', 30), 1, 180);
  const { start, end } = windowIso(days);
  const records = await whoopPaginate<WhoopWorkout>(env, athleteId, '/activity/workout', { start, end });
  return json(records.map(mapWorkout), 200, env);
}

async function apiProfile(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const [basic, body] = await Promise.all([
    whoopGet<any>(env, athleteId, '/user/profile/basic').catch(() => null),
    whoopGet<any>(env, athleteId, '/user/measurement/body').catch(() => null),
  ]);
  return json({
    whoopUserId: basic?.user_id || null,
    email: basic?.email || null,
    firstName: basic?.first_name || null,
    lastName: basic?.last_name || null,
    heightMeter: body?.height_meter ?? null,
    weightKg: body?.weight_kilogram ?? null,
    maxHr: body?.max_heart_rate ?? null,
  }, 200, env);
}

// THE important endpoint — merges recovery + sleep + cycle by calendar day
// into the same row shape pdvGetWhoopSeries returns, so the HTML can swap
// mock→real with zero downstream changes.
async function apiSeries(req: Request, env: Env): Promise<Response> {
  const athleteId = requireAthleteId(req);
  const days = clamp(num(req, 'days', 90), 7, 180);

  const cached = await readCache(env, athleteId, 'series', days);
  if (cached) return json(cached, 200, env, true);

  const { start, end } = windowIso(days);
  const [recoveries, sleeps, cycles] = await Promise.all([
    whoopPaginate<WhoopRecovery>(env, athleteId, '/recovery', { start, end }),
    whoopPaginate<WhoopSleep>(env, athleteId, '/activity/sleep', { start, end }),
    whoopPaginate<WhoopCycle>(env, athleteId, '/cycle', { start, end }),
  ]);

  // Index everything by calendar day (local midnight of cycle start_day_date)
  const byDay = new Map<string, SeriesRow>();
  const ensure = (d: string): SeriesRow => {
    if (!byDay.has(d)) {
      byDay.set(d, {
        athleteId, date: d,
        recoveryPct: null, hrvRmssd: null, rhr: null, spo2: null, skinTempC: null,
        sleepHours: null, sleepEfficiency: null, sleepPerformance: null,
        sleepDebtH: null, sleepConsistency: null,
        strain: null, avgHr: null, maxHr: null, kilojoules: null,
        cyclePhase: null, cycleDay: null, isFemale: false,
        syncSource: 'whoop', syncStatus: 'ok',
        fetchedAt: new Date().toISOString(),
      });
    }
    return byDay.get(d)!;
  };

  for (const c of cycles) {
    const d = isoDay(c.start);
    const row = ensure(d);
    if (c.score) {
      row.strain    = c.score.strain ?? row.strain;
      row.avgHr     = c.score.average_heart_rate ?? row.avgHr;
      row.maxHr     = c.score.max_heart_rate ?? row.maxHr;
      row.kilojoules = c.score.kilojoule ?? row.kilojoules;
    }
  }
  for (const r of recoveries) {
    // Recovery is associated with the cycle whose sleep produced it.
    // WHOOP returns created_at + cycle_id; the day is cycle.start's day.
    const d = isoDay(r.created_at || r.updated_at || new Date().toISOString());
    const row = ensure(d);
    if (r.score) {
      row.recoveryPct = r.score.recovery_score ?? row.recoveryPct;
      row.hrvRmssd    = r.score.hrv_rmssd_milli ?? row.hrvRmssd;
      row.rhr         = r.score.resting_heart_rate ?? row.rhr;
      row.spo2        = r.score.spo2_percentage ?? row.spo2;
      row.skinTempC   = r.score.skin_temp_celsius ?? row.skinTempC;
    }
  }
  for (const s of sleeps) {
    // Use the END day (morning the athlete wakes up) — matches how WHOOP
    // displays "today's recovery."
    const d = isoDay(s.end);
    const row = ensure(d);
    if (s.score) {
      const stageMs = s.score.stage_summary;
      const totalSleepMs = stageMs ? (stageMs.total_in_bed_time_milli || 0) - (stageMs.total_awake_time_milli || 0) : 0;
      row.sleepHours        = totalSleepMs > 0 ? +(totalSleepMs / 3_600_000).toFixed(2) : row.sleepHours;
      row.sleepEfficiency   = s.score.sleep_efficiency_percentage ?? row.sleepEfficiency;
      row.sleepPerformance  = s.score.sleep_performance_percentage ?? row.sleepPerformance;
      row.sleepConsistency  = s.score.sleep_consistency_percentage ?? row.sleepConsistency;
      const need = s.score.sleep_needed?.need_from_recent_strain_milli ?? 0;
      const debtMilli = s.score.sleep_needed?.baseline_milli
        ? Math.max(0, (s.score.sleep_needed.baseline_milli + need) - (stageMs?.total_in_bed_time_milli || 0))
        : null;
      row.sleepDebtH = debtMilli != null ? +(debtMilli / 3_600_000).toFixed(2) : row.sleepDebtH;
    }
  }

  const out = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeCache(env, athleteId, 'series', days, out);
  return json(out, 200, env);
}

// --------------------------------------------------------------------------
// Row shape — mirrors the fields pdvGetWhoopSeries already produces
// --------------------------------------------------------------------------
interface SeriesRow {
  athleteId: string;
  date: string;                 // YYYY-MM-DD
  recoveryPct: number | null;   // 0–100
  hrvRmssd: number | null;      // ms (WHOOP returns seconds × 1000 = ms)
  rhr: number | null;           // bpm
  spo2: number | null;          // %
  skinTempC: number | null;     // deviation, degrees C
  sleepHours: number | null;
  sleepEfficiency: number | null;
  sleepPerformance: number | null;
  sleepDebtH: number | null;
  sleepConsistency: number | null;
  strain: number | null;        // 0–21
  avgHr: number | null;
  maxHr: number | null;
  kilojoules: number | null;
  cyclePhase: string | null;    // placeholder — WHOOP exposes via menstrual-cycle journal entries, not core API
  cycleDay: number | null;
  isFemale: boolean;
  syncSource: 'whoop';
  syncStatus: 'ok' | 'no-data';
  fetchedAt: string;
}

// --------------------------------------------------------------------------
// WHOOP response shapes (subset — only what we consume)
// --------------------------------------------------------------------------
interface WhoopRecovery {
  cycle_id: number | string;
  sleep_id: string;                // UUID in v2
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
  score?: {
    user_calibrating: boolean;
    recovery_score: number;          // 0–100
    resting_heart_rate: number;      // bpm
    hrv_rmssd_milli: number;         // milliseconds rMSSD
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}
interface WhoopSleep {
  id: string; user_id: number;
  start: string; end: string;        // ISO
  nap: boolean;
  score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_no_data_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      sleep_cycle_count?: number;
      disturbance_count?: number;
    };
    sleep_needed?: {
      baseline_milli?: number;
      need_from_sleep_debt_milli?: number;
      need_from_recent_strain_milli?: number;
      need_from_recent_nap_milli?: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
}
interface WhoopCycle {
  id: number | string; user_id: number;
  start: string; end?: string;
  timezone_offset?: string;
  score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
  score?: {
    strain: number;                  // 0–21
    kilojoule?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
  };
}
interface WhoopWorkout {
  id: string; user_id: number;
  start: string; end: string;
  sport_id?: number;
  sport_name?: string;
  score_state: string;
  score?: {
    strain?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
    kilojoule?: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    zone_durations?: Record<string, number>;
  };
}

// --------------------------------------------------------------------------
// Mappers (single-endpoint → normalized row)
// --------------------------------------------------------------------------
function mapRecovery(r: WhoopRecovery) {
  return {
    date: isoDay(r.created_at),
    recoveryPct: r.score?.recovery_score ?? null,
    hrvRmssd: r.score?.hrv_rmssd_milli ?? null,
    rhr: r.score?.resting_heart_rate ?? null,
    spo2: r.score?.spo2_percentage ?? null,
    skinTempC: r.score?.skin_temp_celsius ?? null,
    calibrating: !!r.score?.user_calibrating,
    scoreState: r.score_state,
    cycleId: r.cycle_id,
    sleepId: r.sleep_id,
  };
}
function mapSleep(s: WhoopSleep) {
  const ss = s.score?.stage_summary;
  const inBedMs = ss?.total_in_bed_time_milli || 0;
  const awakeMs = ss?.total_awake_time_milli || 0;
  const sleepMs = Math.max(0, inBedMs - awakeMs);
  return {
    date: isoDay(s.end),
    nap: s.nap,
    sleepHours: +(sleepMs / 3_600_000).toFixed(2),
    sleepEfficiency: s.score?.sleep_efficiency_percentage ?? null,
    sleepPerformance: s.score?.sleep_performance_percentage ?? null,
    sleepConsistency: s.score?.sleep_consistency_percentage ?? null,
    respRate: s.score?.respiratory_rate ?? null,
    disturbances: ss?.disturbance_count ?? null,
    cycles: ss?.sleep_cycle_count ?? null,
    stages: ss ? {
      lightH:  +(((ss.total_light_sleep_time_milli     || 0) / 3_600_000).toFixed(2)),
      sWSH:    +(((ss.total_slow_wave_sleep_time_milli || 0) / 3_600_000).toFixed(2)),
      remH:    +(((ss.total_rem_sleep_time_milli       || 0) / 3_600_000).toFixed(2)),
      awakeH:  +((awakeMs / 3_600_000).toFixed(2)),
    } : null,
    scoreState: s.score_state,
  };
}
function mapCycle(c: WhoopCycle) {
  return {
    date: isoDay(c.start),
    strain: c.score?.strain ?? null,
    avgHr: c.score?.average_heart_rate ?? null,
    maxHr: c.score?.max_heart_rate ?? null,
    kilojoules: c.score?.kilojoule ?? null,
    scoreState: c.score_state,
  };
}
function mapWorkout(w: WhoopWorkout) {
  return {
    id: w.id,
    date: isoDay(w.start),
    start: w.start, end: w.end,
    sport: w.sport_name || null,
    strain: w.score?.strain ?? null,
    avgHr: w.score?.average_heart_rate ?? null,
    maxHr: w.score?.max_heart_rate ?? null,
    kilojoules: w.score?.kilojoule ?? null,
    distanceM: w.score?.distance_meter ?? null,
    zoneDurations: w.score?.zone_durations ?? null,
  };
}

// --------------------------------------------------------------------------
// Webhooks — cache-invalidation trigger
// --------------------------------------------------------------------------
async function webhookReceive(req: Request, env: Env): Promise<Response> {
  // WHOOP signs webhooks with HMAC-SHA256 — header is X-WHOOP-Signature.
  // For our purposes we just invalidate the cache for the affected user.
  const raw = await req.text();

  if (env.WHOOP_WEBHOOK_SECRET) {
    const sig = req.headers.get('X-WHOOP-Signature') || '';
    const ts  = req.headers.get('X-WHOOP-Signature-Timestamp') || '';
    const ok = await verifyHmac(env.WHOOP_WEBHOOK_SECRET, ts + raw, sig);
    if (!ok) return new Response('bad_sig', { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad_json', { status: 400 }); }

  const whoopUserId = String(evt.user_id || '');
  if (whoopUserId) {
    // Reverse-lookup athleteId(s) and invalidate caches. At small scale a scan
    // is fine; for bigger tenants keep a reverse index.
    const list = await env.WHOOP_KV.list({ prefix: 'map:' });
    for (const k of list.keys) {
      const val = await env.WHOOP_KV.get(k.name);
      if (val === whoopUserId) {
        const athleteId = k.name.slice('map:'.length);
        for (const kind of ['recovery','sleep','cycle','series'] as const) {
          for (const d of [7, 14, 30, 60, 90]) {
            await env.WHOOP_KV.delete(kCache(athleteId, kind, d));
          }
        }
      }
    }
  }
  return new Response('ok', { status: 200 });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function requireAthleteId(req: Request): string {
  const id = (new URL(req.url).searchParams.get('athleteId') || '').trim();
  if (!id) throw new HttpError(400, 'missing_athleteId');
  if (id.length > 64 || !/^[A-Za-z0-9._\- ]+$/.test(id)) {
    throw new HttpError(400, 'invalid_athleteId');
  }
  return id;
}

function num(req: Request, k: string, def: number): number {
  const v = new URL(req.url).searchParams.get(k);
  const n = v == null ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

function windowIso(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}
function isoDay(ts: string): string {
  // Use the *local* calendar day for the given ISO timestamp. WHOOP stores
  // cycle starts in the athlete's local TZ already; treat UTC as good-enough
  // here — any practitioner-visible label is "which calendar day."
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function corsHeaders(env: Env, extra: HeadersInit = {}): Headers {
  const h = new Headers(extra);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return h;
}
function corsPreflight(env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
function json(obj: unknown, status: number, env: Env, fromCache = false): Response {
  const h = corsHeaders(env, { 'Content-Type': 'application/json' });
  if (fromCache) h.set('X-Cache', 'HIT');
  return new Response(JSON.stringify(obj), { status, headers: h });
}
function redirectWithHash(base: string, params: Record<string,string>): Response {
  const qs = new URLSearchParams(params).toString();
  const url = base.includes('#') ? `${base}&${qs}` : `${base}#${qs}`;
  return Response.redirect(url, 302);
}

// Cache helpers (KV cache, short TTL — WHOOP data is daily anyway)
async function readCache<T>(env: Env, athleteId: string, kind: string, days: number): Promise<T | null> {
  const raw = await env.WHOOP_KV.get(kCache(athleteId, kind, days));
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
async function writeCache(env: Env, athleteId: string, kind: string, days: number, data: unknown) {
  await env.WHOOP_KV.put(kCache(athleteId, kind, days), JSON.stringify(data), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
}

// --- Crypto ---------------------------------------------------------------
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i*2, 2), 16);
  return out;
}
async function importKey(hexKey: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('ENC_KEY must be 64 hex chars (32 bytes)');
  return crypto.subtle.importKey('raw', unhex(hexKey), { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
}
async function encryptJSON(obj: unknown, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, pt);
  return `v1.${hex(iv)}.${hex(new Uint8Array(ct))}`;
}
async function decryptJSON<T>(blob: string, hexKey: string): Promise<T> {
  const [v, ivHex, ctHex] = blob.split('.');
  if (v !== 'v1') throw new Error('bad_blob');
  const key = await importKey(hexKey);
  const pt = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv: unhex(ivHex) }, key, unhex(ctHex)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}
async function verifyHmac(secret: string, message: string, sigHex: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const expected = hex(new Uint8Array(mac));
    // constant-time-ish compare
    if (expected.length !== sigHex.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}
