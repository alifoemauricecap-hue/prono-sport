// PRONO SPORT — Client HTTP avec cache intelligent (§65) et suivi de fiabilité (§8)
// Respect des sources (§5) : User-Agent identifiable, pas de contournement de protections.
import crypto from 'node:crypto';
import { db, now } from '../db.js';

const memCache = new Map(); // cache mémoire court terme { url: { at, body } }
const MEMCACHE_MAX_ENTRIES = 40;          // borne stricte (instances 512 Mo)
const MEMCACHE_MAX_BODY = 300 * 1024;     // les gros CSV ne sont pas gardés en RAM

function memCacheSet(url, entry) {
  if (entry.body && entry.body.length > MEMCACHE_MAX_BODY) return; // trop gros
  if (memCache.size >= MEMCACHE_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(url, entry);
}

function trackSource(sourceId, ok, latencyMs) {
  if (!sourceId) return;
  const col = ok ? 'success_count' : 'failure_count';
  const tsCol = ok ? 'last_successful_fetch' : 'last_failed_fetch';
  db.prepare(`UPDATE data_sources SET ${col}=${col}+1, ${tsCol}=?, last_checked=?,
      total_latency_ms=total_latency_ms+?,
      availability_status=? WHERE source_id=?`)
    .run(now(), now(), latencyMs, ok ? 'AVAILABLE' : 'DEGRADED', sourceId);
  // reliability_score = observé (disponibilité), jamais inventé (§8)
  db.prepare(`UPDATE data_sources SET reliability_score =
      CAST(success_count AS REAL) / MAX(success_count + failure_count, 1)
      WHERE source_id=?`).run(sourceId);
}

/**
 * fetchText — GET avec cache mémoire + ETag/Last-Modified persistés.
 * @returns {Promise<{body:string, fromCache:boolean}>}
 */
export async function fetchText(url, { sourceId, ttlMs = 60_000, timeoutMs = 20_000 } = {}) {
  const cached = memCache.get(url);
  if (cached && Date.now() - cached.at < ttlMs) return { body: cached.body, fromCache: true };

  const headers = { 'User-Agent': 'PronoSport/1.0 (analytics platform; respectful crawler)' };
  const hc = db.prepare(`SELECT etag, last_modified FROM http_cache WHERE url=?`).get(url);
  if (hc?.etag) headers['If-None-Match'] = hc.etag;
  if (hc?.last_modified) headers['If-Modified-Since'] = hc.last_modified;

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let tracked = false;
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const latency = Date.now() - t0;
    if (res.status === 304 && cached) {
      tracked = true;
      trackSource(sourceId, true, latency);
      memCacheSet(url, { at: Date.now(), body: cached.body });
      return { body: cached.body, fromCache: true };
    }
    if (!res.ok) {
      tracked = true;
      trackSource(sourceId, false, latency);
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const body = await res.text();
    tracked = true;
    trackSource(sourceId, true, latency);
    const etag = res.headers.get('etag');
    const lm = res.headers.get('last-modified');
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    db.prepare(`INSERT INTO http_cache (url, etag, last_modified, content_hash, fetched_at)
        VALUES (?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET
        etag=excluded.etag, last_modified=excluded.last_modified,
        content_hash=excluded.content_hash, fetched_at=excluded.fetched_at`)
      .run(url, etag, lm, hash, now());
    memCacheSet(url, { at: Date.now(), body });
    return { body, fromCache: false };
  } catch (e) {
    // Toute défaillance réseau (timeout, DNS, connexion refusée…) est comptée
    // dans la fiabilité observée de la source — jamais masquée (§8, §77).
    if (!tracked) trackSource(sourceId, false, Date.now() - t0);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts) {
  const { body, fromCache } = await fetchText(url, opts);
  return { data: JSON.parse(body), fromCache };
}
