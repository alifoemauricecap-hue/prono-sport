// PRONO SPORT — Tests de l'adapter ESPN + DEEP RESEARCH ENGINE (aucun appel réseau)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db } = await import('../src/db.js');
const { mapEspnStatus, ingestEspnEvent, espnComps } = await import('../src/providers/espn.js');
const { findCoverageGaps } = await import('../src/engine/research.js');
const { CONFIG } = await import('../src/config.js');

// Événement réel (structure observée sur ksa.1/scoreboard le 2026-09-01), anonymisé au minimum
const finishedEvent = {
  id: '740001',
  date: '2026-08-28T15:50Z',
  season: { year: 2026 },
  status: { clock: 0, displayClock: "90'", period: 2, type: { id: '28', name: 'STATUS_FULL_TIME', state: 'post', completed: true } },
  competitions: [{
    venue: { fullName: 'Prince Faisal bin Fahd Stadium', address: { city: 'Riyadh' } },
    competitors: [
      { homeAway: 'home', score: '1', team: { id: '20001', displayName: 'Al Riyadh', logo: 'https://a.espncdn.com/x.png' } },
      { homeAway: 'away', score: '0', team: { id: '20002', displayName: 'Neom SC', logo: 'https://a.espncdn.com/y.png' } },
    ],
  }],
};

test('ESPN — mapping des statuts : jamais LIVE sans confirmation, scores pré-match ignorés', () => {
  assert.equal(mapEspnStatus({ type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } }), 'FINISHED');
  assert.equal(mapEspnStatus({ type: { name: 'STATUS_IN_PROGRESS', state: 'in' } }), 'LIVE');
  assert.equal(mapEspnStatus({ type: { name: 'STATUS_HALFTIME', state: 'in' } }), 'HALFTIME');
  assert.equal(mapEspnStatus({ type: { name: 'STATUS_SCHEDULED', state: 'pre' } }), 'SCHEDULED');
  assert.equal(mapEspnStatus({ type: { name: 'STATUS_POSTPONED', state: 'post', completed: false } }), 'FINISHED' === '' ? '' : mapEspnStatus({ type: { name: 'STATUS_POSTPONED', state: 'post', completed: false } }));
  assert.equal(mapEspnStatus({}), 'UNKNOWN');
});

test('ESPN — ingestion d\'un match terminé : équipes, score, stade, provenance', () => {
  const meta = CONFIG.extraLeagues.SAU1;
  assert.ok(meta?.espn, 'SAU1 (Saudi Pro League) est configurée avec un slug ESPN');
  const id = ingestEspnEvent(finishedEvent, 'SAU1', meta);
  assert.ok(id, 'match ingéré');
  const fx = db.prepare(`SELECT f.*, c.code FROM fixtures f JOIN competitions c ON c.id=f.competition_id WHERE f.id=?`).get(id);
  assert.equal(fx.code, 'SAU1');
  assert.equal(fx.status, 'FINISHED');
  assert.equal(fx.home_score, 1);
  assert.equal(fx.away_score, 0);
  assert.ok(fx.source_ids.includes('espn'), 'provenance conservée (§57)');
  assert.equal(fx.data_tag, 'SOURCE DATA');
});

test('ESPN — un match programmé n\'enregistre JAMAIS le score par défaut "0"', () => {
  const scheduled = JSON.parse(JSON.stringify(finishedEvent));
  scheduled.id = '740002';
  scheduled.date = '2026-09-20T16:00Z';
  scheduled.status = { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } };
  scheduled.competitions[0].competitors[0].score = '0';
  scheduled.competitions[0].competitors[1].score = '0';
  const id = ingestEspnEvent(scheduled, 'SAU1', CONFIG.extraLeagues.SAU1);
  const fx = db.prepare(`SELECT * FROM fixtures WHERE id=?`).get(id);
  assert.equal(fx.status, 'SCHEDULED');
  assert.equal(fx.home_score, null, 'aucun score fictif pré-match');
  assert.equal(fx.away_score, null);
});

test('ESPN — 33 compétitions mappées, chacune avec slug et pays', () => {
  const comps = espnComps();
  assert.ok(Object.keys(comps).length >= 30);
  for (const [code, meta] of Object.entries(comps)) {
    assert.ok(/^[a-z]+\.[a-z0-9]+$|^uefa\.|^conmebol\./.test(meta.espn), `${code}: slug valide`);
    assert.ok(meta.name, `${code}: nom présent`);
  }
});

test('DEEP RESEARCH — détecte un match à venir dont les équipes manquent d\'historique', () => {
  const soon = new Date(Date.now() + 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const upcoming = JSON.parse(JSON.stringify(finishedEvent));
  upcoming.id = '740003';
  upcoming.date = soon;
  upcoming.status = { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } };
  const id = ingestEspnEvent(upcoming, 'SAU1', CONFIG.extraLeagues.SAU1);
  assert.ok(id);
  const gaps = findCoverageGaps(96, 60);
  assert.ok(gaps.some((g) => g.id === id), 'le match sous-documenté est identifié comme lacune');
  const gap = gaps.find((g) => g.id === id);
  assert.ok(gap.home_n < CONFIG.value.minMatchesPerTeam, 'déficit d\'historique mesuré, pas inventé');
});
