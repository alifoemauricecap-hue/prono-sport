// PRONO SPORT — TESTS DU MOTEUR DE RECHERCHE CIBLÉE (Deep Research Engine)
// Vérifie le rattachement compétition → ligue ESPN (jamais de doublon de
// compétition) et l'unification des noms d'équipes entre sources.
process.env.DB_PATH = './data/testr-' + process.pid + '-' + Date.now() + '.db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { db } = await import('../src/db.js');
const { findEspnLeagueForCompetition, ESPN_LEAGUES } = await import('../src/providers/espn.js');
const { findDataPoorCompetitions } = await import('../src/workers/research.js');
const { normalizeTeamName } = await import('../src/util/teamNames.js');
const { upsertCompetition, upsertTeam, upsertFixture } = await import('../src/providers/repository.js');

test.after(() => {
  db.close();
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('testr-')) fs.rmSync('./data/' + f, { force: true });
  }
});

test('RATTACHEMENT ESPN — Saudi Pro League reconnue, pas de faux positifs', () => {
  assert.equal(findEspnLeagueForCompetition('Saudi Pro League', 'Saudi Arabia')?.slug, 'ksa.1');
  assert.equal(findEspnLeagueForCompetition('Liga Profesional', 'Argentina')?.slug, 'arg.1');
  assert.equal(findEspnLeagueForCompetition('Série A (Brésil)', 'Brazil')?.slug, 'bra.1');
  // Serie A italienne : ne doit JAMAIS être rattachée à la Série A brésilienne
  assert.equal(findEspnLeagueForCompetition('Serie A', 'Italie'), null);
  assert.equal(findEspnLeagueForCompetition('Premier League', 'Angleterre'), null);
  // chaque slug est unique dans le catalogue
  assert.equal(new Set(ESPN_LEAGUES.map((l) => l.slug)).size, ESPN_LEAGUES.length);
});

test('UNIFICATION DES NOMS — « Al-Hilal » (TheSportsDB) ≡ « Al Hilal » (ESPN)', () => {
  assert.equal(normalizeTeamName('Al-Hilal'), normalizeTeamName('Al Hilal'));
  assert.equal(normalizeTeamName('Al-Nassr FC'), normalizeTeamName('Al Nassr'));
  // les deux graphies pointent vers la MÊME équipe en base
  const id1 = upsertTeam('Al-Hilal', 'Saudi Arabia');
  const id2 = upsertTeam('Al Hilal', 'Saudi Arabia');
  assert.equal(id1, id2);
});

test('DÉTECTION DES TROUS DE DONNÉES — un match programmé sans historique est repéré', () => {
  const compId = upsertCompetition('TEST-KSA', 'Saudi Pro League', 'Saudi Arabia');
  const h = upsertTeam('Equipe Test A', 'Saudi Arabia');
  const a = upsertTeam('Equipe Test B', 'Saudi Arabia');
  const kickoff = new Date(Date.now() + 2 * 86_400_000).toISOString();
  upsertFixture({ competitionId: compId, homeTeamId: h, awayTeamId: a, kickoffUtc: kickoff, status: 'SCHEDULED', sourceId: 'test' });
  const poor = findDataPoorCompetitions();
  const found = poor.find((p) => p.code === 'TEST-KSA');
  assert.ok(found, 'la compétition sans historique doit être détectée');
  assert.match(found.reason, /historique compétition insuffisant/);
});
