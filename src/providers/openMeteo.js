// PRONO SPORT — Adapter Open-Meteo (WeatherProvider)
// Météo réelle par géocodage du stade/de la ville — SOURCE DATA.
// Si aucune localisation fiable : WEATHER DATA UNAVAILABLE (§29), jamais inventée.
import { fetchJson } from '../util/http.js';
import { db, now } from '../db.js';

const SOURCE_ID = 'open-meteo';

export async function geocode(place, country) {
  if (!place) return null;
  // La source géocode des localités : on essaie le nom complet du stade,
  // puis le nom débarrassé des mots génériques (Stadium, Arena, Park…).
  const variants = [place];
  const stripped = place
    .replace(/\b(stadium|stadion|stade|arena|park|estadio|stadio|ground|field|dome|court)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== place) variants.push(stripped);
  const words = stripped.split(' ');
  if (words.length > 1) variants.push(words[words.length - 1], words[0]);
  const countryAliases = { England: 'United Kingdom', Scotland: 'United Kingdom', Wales: 'United Kingdom' };
  const wanted = countryAliases[country] || country;
  for (const v of variants) {
    const q = encodeURIComponent(v);
    try {
      const { data } = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5&language=fr`,
        { sourceId: SOURCE_ID, ttlMs: 7 * 24 * 3600_000 });
      const results = data?.results || [];
      if (!results.length) continue;
      const match = results.find((r) => !wanted || (r.country || '').toLowerCase().includes(wanted.toLowerCase())) || results[0];
      return { lat: match.latitude, lon: match.longitude, name: match.name };
    } catch { /* variante suivante */ }
  }
  return null;
}

/** Prévision météo pour un match (heure du coup d'envoi) */
export async function fetchMatchWeather(fixtureId, lat, lon, kickoffUtc) {
  const ko = new Date(kickoffUtc);
  const horizonDays = Math.ceil((ko - Date.now()) / 86400_000);
  if (horizonDays > 14 || horizonDays < -1) return null; // hors fenêtre de prévision réelle
  const dateStr = kickoffUtc.slice(0, 10);
  const { data } = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m` +
    `&start_date=${dateStr}&end_date=${dateStr}&timezone=UTC`,
    { sourceId: SOURCE_ID, ttlMs: 3 * 3600_000 });
  const hours = data?.hourly?.time || [];
  const target = `${dateStr}T${String(ko.getUTCHours()).padStart(2, '0')}:00`;
  let idx = hours.indexOf(target);
  if (idx === -1) idx = Math.min(hours.length - 1, ko.getUTCHours());
  if (idx < 0 || !hours.length) return null;
  const w = {
    temperature_c: data.hourly.temperature_2m?.[idx] ?? null,
    precipitation_mm: data.hourly.precipitation?.[idx] ?? null,
    wind_kmh: data.hourly.wind_speed_10m?.[idx] ?? null,
    humidity: data.hourly.relative_humidity_2m?.[idx] ?? null,
  };
  db.prepare(`INSERT INTO weather (fixture_id, temperature_c, precipitation_mm, wind_kmh, humidity, source_id, retrieved_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(fixture_id) DO UPDATE SET temperature_c=excluded.temperature_c,
      precipitation_mm=excluded.precipitation_mm, wind_kmh=excluded.wind_kmh,
      humidity=excluded.humidity, retrieved_at=excluded.retrieved_at`)
    .run(fixtureId, w.temperature_c, w.precipitation_mm, w.wind_kmh, w.humidity, SOURCE_ID, now());
  return w;
}
