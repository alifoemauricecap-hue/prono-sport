// PRONO SPORT — TEST PROVIDER FAILURE (§77) + FRAÎCHEUR (§11)
// Imports dynamiques après définition de DB_PATH (base de test isolée).
process.env.DB_PATH = './data/testp-' + process.pid + '-' + Date.now() + '.db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { db } = await import('../src/db.js');
const { registerSources } = await import('../src/providers/registry.js');
const { fetchText } = await import('../src/util/http.js');

test.after(() => {
  db.close();
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('testp-')) fs.rmSync('./data/' + f, { force: true });
  }
});

test('PROVIDER FAILURE — une source indisponible est marquée DEGRADED, jamais simulée (§77)', async () => {
  registerSources();
  // URL invalide contrôlée : simule une source en panne
  await assert.rejects(
    () => fetchText('http://127.0.0.1:9/unreachable', { sourceId: 'openligadb', timeoutMs: 1500 }),
    'un échec doit lever une erreur, pas retourner de données fictives'
  );
  const src = db.prepare(`SELECT * FROM data_sources WHERE source_id='openligadb'`).get();
  assert.equal(src.availability_status, 'DEGRADED');
  assert.ok(src.failure_count >= 1, 'échec comptabilisé dans la fiabilité observée');
  assert.ok(src.last_failed_fetch, 'horodatage de l\'échec conservé');
});

test('FIABILITÉ — reliability_score strictement dérivé des observations (§8)', async () => {
  const src = db.prepare(`SELECT * FROM data_sources WHERE source_id='openligadb'`).get();
  const expected = src.success_count / Math.max(src.success_count + src.failure_count, 1);
  assert.ok(Math.abs((src.reliability_score ?? 0) - expected) < 1e-9,
    'le score doit être exactement succès/total — jamais une valeur inventée');
});

test('SOURCES — chaque source du registre déclare ses conditions d\'utilisation (§5)', () => {
  const rows = db.prepare(`SELECT * FROM data_sources`).all();
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.ok(r.terms_status && r.terms_status.length > 5, `${r.source_id} : terms_status requis`);
    assert.notEqual(r.terms_status, 'SOURCE_NOT_ALLOWED', 'aucune source interdite ne doit être active');
  }
});
