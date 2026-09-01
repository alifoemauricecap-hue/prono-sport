// PRONO SPORT — Tests du SOURCE DISCOVERY ENGINE (aucun appel réseau)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db } = await import('../src/db.js');
const { seedDiscovery } = await import('../src/providers/theSportsDb.js');
const { CONFIG } = await import('../src/config.js');

test('DISCOVERY — le seeding est idempotent et ne crée que des PENDING', () => {
  const n1 = seedDiscovery();
  assert.equal(n1, CONFIG.tsdbSeedLeagueIds.length, 'tous les candidats configurés ensemencés');
  const n2 = seedDiscovery();
  assert.equal(n2, 0, 'ré-ensemencer ne duplique rien');
  const statuses = db.prepare(`SELECT DISTINCT status FROM discovered_leagues`).all();
  assert.deepEqual(statuses.map((s) => s.status), ['PENDING'], 'aucun candidat approuvé sans test réel');
});

test('DISCOVERY — aucune ligue non testée ne peut être synchronisée', async () => {
  const { syncDiscoveredLeagues } = await import('../src/providers/theSportsDb.js');
  // Tous les candidats sont PENDING → la synchro ne doit rien sélectionner
  const r = await syncDiscoveredLeagues();
  assert.equal(r.leagues, 0, 'PENDING/REJECTED jamais synchronisés');
  assert.equal(r.events, 0);
});

test('DISCOVERY — un candidat REJECTED reste visible (auditabilité, jamais supprimé)', () => {
  db.prepare(`UPDATE discovered_leagues SET status='REJECTED', reason='Sport non football : Rugby'
      WHERE tsdb_id=?`).run(CONFIG.tsdbSeedLeagueIds[0]);
  const r = db.prepare(`SELECT * FROM discovered_leagues WHERE tsdb_id=?`).get(CONFIG.tsdbSeedLeagueIds[0]);
  assert.equal(r.status, 'REJECTED');
  assert.ok(r.reason.includes('Rugby'), 'le motif du rejet est conservé');
});
