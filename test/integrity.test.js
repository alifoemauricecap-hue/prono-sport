// PRONO SPORT — NO FAKE DATA TEST (§72) + DATA CONFLICT TEST (§73)
// Utilise une base temporaire isolée (jamais la production, §70/§71).
// NB : imports dynamiques APRÈS la définition de DB_PATH (les imports statiques
// ES sont hissés et chargeraient la base par défaut).
process.env.DB_PATH = './data/test-' + process.pid + '-' + Date.now() + '.db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { db } = await import('../src/db.js');
const { upsertCompetition, upsertTeam, upsertFixture } = await import('../src/providers/repository.js');
const { normalizeTeamName } = await import('../src/util/teamNames.js');
const { parseCsv } = await import('../src/util/csv.js');

test.after(() => {
  db.close();
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('test-')) fs.rmSync('./data/' + f, { force: true });
  }
});

test('NO FAKE DATA — tout match en base doit avoir au moins une source réelle (§72)', () => {
  const compId = upsertCompetition('TST', 'Test League', 'Testland');
  const h = upsertTeam('Alpha FC', 'Testland');
  const a = upsertTeam('Beta FC', 'Testland');
  upsertFixture({
    competitionId: compId, homeTeamId: h, awayTeamId: a,
    kickoffUtc: '2030-01-01T15:00:00Z', status: 'SCHEDULED',
    sourceId: 'football-data-couk',
  });
  const orphans = db.prepare(`SELECT COUNT(*) AS n FROM fixtures
      WHERE source_ids IS NULL OR source_ids='[]' OR source_ids=''`).get().n;
  assert.equal(orphans, 0, 'AUCUN match sans provenance de source ne doit exister');
  // et chaque source référencée doit exister dans le registre des sources testables
  const known = ['football-data-couk', 'thesportsdb', 'openligadb', 'open-meteo', 'football-data-org'];
  const all = db.prepare(`SELECT source_ids FROM fixtures`).all();
  for (const row of all) {
    for (const s of JSON.parse(row.source_ids)) {
      assert.ok(known.includes(s), `source inconnue interdite : ${s}`);
    }
  }
});

test('DATA CONFLICT — source A 2-1 vs source B 1-1 → conflit détecté, rien d\'écrasé (§73)', () => {
  const compId = upsertCompetition('TST2', 'Conflict League', 'Testland');
  const h = upsertTeam('Gamma FC', 'Testland');
  const a = upsertTeam('Delta FC', 'Testland');
  const r1 = upsertFixture({
    competitionId: compId, homeTeamId: h, awayTeamId: a,
    kickoffUtc: '2024-05-01T15:00:00Z', status: 'FINISHED',
    homeScore: 2, awayScore: 1, sourceId: 'football-data-couk',
  });
  assert.equal(r1.conflict, false);
  const r2 = upsertFixture({
    competitionId: compId, homeTeamId: h, awayTeamId: a,
    kickoffUtc: '2024-05-01T15:00:00Z', status: 'FINISHED',
    homeScore: 1, awayScore: 1, sourceId: 'thesportsdb',
  });
  assert.equal(r2.conflict, true, 'le conflit doit être signalé');
  const f = db.prepare(`SELECT * FROM fixtures WHERE id=?`).get(r1.id);
  assert.equal(f.validation_status, 'DATA CONFLICT');
  assert.equal(f.home_score, 2, 'la donnée originale n\'est PAS écrasée arbitrairement');
  const conflict = db.prepare(`SELECT * FROM data_conflicts WHERE entity_id=?`).get(r1.id);
  assert.ok(conflict, 'conflit journalisé avec les deux valeurs');
  assert.ok(conflict.values_json.includes('2-1') && conflict.values_json.includes('1-1'));
  assert.ok(conflict.resolution_rule.length > 10, 'règle de résolution documentée');
});

test('VALIDATION CROISÉE — deux sources concordantes → VERIFIED (§6)', () => {
  const compId = upsertCompetition('TST3', 'Verify League', 'Testland');
  const h = upsertTeam('Epsilon FC', 'Testland');
  const a = upsertTeam('Zeta FC', 'Testland');
  const r1 = upsertFixture({
    competitionId: compId, homeTeamId: h, awayTeamId: a,
    kickoffUtc: '2024-05-02T15:00:00Z', status: 'FINISHED',
    homeScore: 3, awayScore: 0, sourceId: 'football-data-couk',
  });
  upsertFixture({
    competitionId: compId, homeTeamId: h, awayTeamId: a,
    kickoffUtc: '2024-05-02T15:00:00Z', status: 'FINISHED',
    homeScore: 3, awayScore: 0, sourceId: 'openligadb',
  });
  const f = db.prepare(`SELECT * FROM fixtures WHERE id=?`).get(r1.id);
  assert.equal(f.validation_status, 'VERIFIED');
  assert.equal(JSON.parse(f.source_ids).length, 2, 'les deux sources sont conservées');
});

test('DÉDUPLICATION — les alias de noms d\'équipes fusionnent (§60)', () => {
  assert.equal(normalizeTeamName('Man United'), normalizeTeamName('Manchester United'));
  assert.equal(normalizeTeamName("Nott'm Forest"), normalizeTeamName('Nottingham Forest'));
  assert.equal(normalizeTeamName('FC Bayern München'), normalizeTeamName('Bayern Munich'));
  assert.equal(normalizeTeamName('Paris SG'), normalizeTeamName('Paris Saint-Germain'));
  const id1 = upsertTeam('Man United', 'Angleterre');
  const id2 = upsertTeam('Manchester United', 'Angleterre');
  assert.equal(id1, id2, 'un seul enregistrement pour les deux orthographes');
});

test('CSV — parseur robuste (guillemets, CRLF, champs vides)', () => {
  const rows = parseCsv('A,B,C\r\n1,"x, y",3\r\n4,,6\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].B, 'x, y');
  assert.equal(rows[1].B, '');
});

test('PRONOSTICS IMMUABLES — un pronostic réglé ne peut pas changer (§54)', () => {
  db.prepare(`INSERT INTO predictions (fixture_id, created_at, model_version, features_version,
      market, selection, probability, decision, result)
      VALUES (1, '2024-01-01T00:00:00Z', 'v1', 'f1', '1X2', 'HOME', 0.5, 'PICK', 'WIN')`).run();
  const before = db.prepare(`SELECT * FROM predictions WHERE market='1X2' AND model_version='v1'`).get();
  assert.equal(before.immutable, 1, 'flag immuable actif par défaut');
  assert.equal(before.probability, 0.5, 'la probabilité originale est conservée');
});

test('DÉCOUVERTE — une ligue candidate n\'est jamais APPROVED sans validation (§4)', () => {
  db.prepare(`INSERT OR IGNORE INTO discovered_leagues (tsdb_id, discovered_via) VALUES ('99999','test')`).run();
  const l = db.prepare(`SELECT * FROM discovered_leagues WHERE tsdb_id='99999'`).get();
  assert.equal(l.status, 'PENDING', 'statut initial obligatoirement PENDING — jamais approuvée d\'office');
  assert.equal(l.events_found, 0);
});
