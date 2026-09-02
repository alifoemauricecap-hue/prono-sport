/* PRONO SPORT — Application frontend (SPA vanilla, aucune dépendance) */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
let currentView = 'home';
let currentFixture = null;
let currentMatch = null;
const userKey = localStorage.getItem('ps_user') || (() => {
  const k = 'u_' + Math.random().toString(36).slice(2, 12);
  localStorage.setItem('ps_user', k); return k;
})();

const api = async (path, opts) => {
  const r = await fetch('/api' + path, opts);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => x == null ? '—' : (x * 100).toFixed(1) + '%';
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};
const badge = (url, name) => url
  ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=badge-ph>${esc((name || '?')[0])}</span>'">`
  : `<span class="badge-ph">${esc((name || '?')[0])}</span>`;

const STATUS_FR = { SCHEDULED: 'Programmé', UPCOMING: 'Bientôt', LIVE: 'LIVE', HALFTIME: 'Mi-temps', FINISHED: 'Terminé', POSTPONED: 'Reporté', CANCELLED: 'Annulé', UNKNOWN: 'À confirmer', EXTRA_TIME: 'Prolong.', PENALTIES: 'T.A.B.', SUSPENDED: 'Suspendu', ABANDONED: 'Arrêté' };
const statusPill = (s) => `<span class="pill ${s === 'LIVE' || s === 'HALFTIME' ? 'live' : s === 'FINISHED' ? 'finished' : 'scheduled'}">${STATUS_FR[s] || s}</span>`;
const tagPill = (t) => t === 'SOURCE DATA' ? '<span class="pill source">SOURCE DATA</span>'
  : t === 'CALCULATED DATA' ? '<span class="pill calc">CALCULATED DATA</span>'
  : '<span class="pill model">MODEL ESTIMATE</span>';
const freshPill = (f) => `<span class="pill ${f === 'FRESH' ? 'fresh' : f === 'STALE' ? 'stale' : 'unknown'}">${f}</span>`;
const validPill = (v) => v === 'VERIFIED' ? '<span class="pill verified">VERIFIED</span>'
  : v === 'DATA CONFLICT' ? '<span class="pill conflict">DATA CONFLICT</span>' : '';

function matchRow(m) {
  const played = m.home_score != null;
  return `<div class="match-row" onclick="openFixture(${m.id})">
    <div>${badge(m.home_badge, m.home_name)}</div>
    <div class="team"><span>${esc(m.home_name)}</span></div>
    <div class="match-mid">
      ${played ? `<div class="score">${m.home_score} - ${m.away_score}</div>` : `<div class="score">vs</div>`}
      <div class="time">${fmtDate(m.kickoff_utc)}</div>
    </div>
    <div class="team away"><span>${esc(m.away_name)}</span></div>
    <div>${badge(m.away_badge, m.away_name)}</div>
    <div class="match-meta">
      ${statusPill(m.status)} ${validPill(m.validation_status)} ${freshPill(m.freshness)}
      ${m.pick ? `<span class="pick-pill ${m.pick.result === 'WIN' ? 'win' : m.pick.result === 'LOSS' ? 'loss' : ''}">🎯 ${esc(m.pick.market)}/${esc(m.pick.selection)} · ${(m.pick.probability * 100).toFixed(0)}%${m.pick.result === 'WIN' ? ' ✅' : m.pick.result === 'LOSS' ? ' ❌' : ''}</span>` : ''}
      <span>${m.comp_logo ? `<img class="comp-logo" src="${esc(m.comp_logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(m.comp_name)} · ${esc(m.country || '')}</span>
      ${m.venue_name ? `<span>🏟 ${esc(m.venue_name)}</span>` : ''}
      <span>Sources : ${(m.source_ids || []).join(', ')}</span>
    </div>
  </div>`;
}

/* ---------------- navigation ---------------- */
window.nav = (view, arg) => {
  currentView = view;
  document.querySelectorAll('.mainnav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const views = {
    home: renderHome, live: renderLive, upcoming: renderUpcoming, finished: renderFinished,
    expert: renderExpert, combo: renderCombo, tracking: renderTracking,
    golden: renderGolden, transparency: renderTransparency, bankroll: renderBankroll,
    competitions: renderCompetitions, value: renderValue, predictions: renderPredictions,
    favorites: renderFavorites, coverage: renderCoverage, sources: renderSources,
    backtest: renderBacktest, admin: renderAdmin,
  };
  app.innerHTML = '<div class="loading">Chargement…</div>';
  window.scrollTo(0, 0);
  (views[view] || renderHome)(arg).catch((e) => {
    app.innerHTML = `<div class="warn">Erreur : ${esc(e.message)}</div>`;
  });
};
document.querySelectorAll('.mainnav button').forEach((b) => b.addEventListener('click', () => nav(b.dataset.view)));

/* ---------------- vues ---------------- */
async function renderHome() {
  const [live, upcoming, value] = await Promise.all([
    api('/fixtures/live'), api('/fixtures/upcoming?days=3'), api('/value-bets'),
  ]);
  app.innerHTML = `
    <h2 class="section">🔴 En direct <span class="count">(confirmé par les sources)</span></h2>
    ${live.data.length ? live.data.map(matchRow).join('') : `<div class="info">${esc(live.note || 'Aucun match live.')}</div>`}
    <h2 class="section">💎 Value Bets qualifiés <span class="count">${value.data.length}</span></h2>
    ${value.data.length ? value.data.slice(0, 5).map(valueRow).join('') : `<div class="info">${esc(value.note || 'NO QUALIFIED PICK')}</div>`}
    <h2 class="section">📅 Prochains matchs (72 h) <span class="count">${upcoming.data.length}</span></h2>
    ${upcoming.data.slice(0, 30).map(matchRow).join('') || '<div class="info">Aucun match dans les données des sources pour cette fenêtre.</div>'}`;
}

async function renderLive() {
  const live = await api('/fixtures/live');
  app.innerHTML = `<h2 class="section">🔴 Matchs en direct</h2>
    <div class="info">Le statut LIVE n'est affiché que lorsqu'une source du registre le confirme réellement (actuellement : OpenLigaDB pour les ligues allemandes). Les autres matchs dont l'heure est passée restent « À confirmer » — jamais présentés comme live sans source.</div>
    ${live.data.length ? live.data.map(matchRow).join('') : `<div class="card">${esc(live.note || '')}</div>`}`;
}

const dayLabel = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  const iso = d.toISOString().slice(0, 10);
  const label = offset === 0 ? "Aujourd'hui" : offset === 1 ? 'Demain'
    : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  return { iso, label };
};

async function renderUpcoming(dayIso) {
  const days = Array.from({ length: 7 }, (_, i) => dayLabel(i));
  const active = dayIso || days[0].iso;
  const dj = await api('/day/' + active);
  const fx = dj.data.fixtures.filter((f) => !['FINISHED'].includes(f.status) || active !== days[0].iso);
  const tabs = `<div class="day-tabs">${days.map((d) =>
    `<button class="${d.iso === active ? 'active' : ''}" onclick="nav('upcoming','${d.iso}')">${esc(d.label)}</button>`).join('')}</div>`;
  const st = dj.data.stats;
  const bar = st && (st.counts.WIN + st.counts.LOSS + st.counts.PENDING) > 0
    ? `<div class="info">Pronostics du jour : ✅ ${st.counts.WIN} validés · ❌ ${st.counts.LOSS} non validés · ⏳ ${st.counts.PENDING} en cours${st.win_rate != null ? ` · taux réel ${(st.win_rate * 100).toFixed(0)}%` : ''}</div>` : '';
  app.innerHTML = `<h2 class="section">📅 Matchs du jour <span class="count">${esc(active)} — ${dj.data.fixtures.length} matchs</span></h2>
    ${tabs}${bar}
    <div id="upList">${dj.data.fixtures.map((m) => matchRow(m)).join('') || '<div class="info">Aucun match dans les sources pour ce jour — état honnête, rien d\u2019inventé.</div>'}</div>`;
}

async function renderFinished() {
  const fin = await api('/fixtures/finished');
  app.innerHTML = `<h2 class="section">✅ Matchs terminés <span class="count">derniers ${fin.data.length}</span></h2>
    ${fin.data.map(matchRow).join('')}`;
}

async function renderCompetitions() {
  const comps = await api('/competitions');
  app.innerHTML = `<h2 class="section">🏆 Compétitions couvertes</h2>
    <div class="info">La couverture dépend des sources réellement disponibles (§88 : qualité avant quantité). La profondeur historique affichée est mesurée sur les données en base.</div>
    <div class="table-wrap"><table>
    <tr><th>Compétition</th><th>Pays</th><th>Historique réel</th><th class="num">Matchs joués</th><th class="num">À venir</th><th></th></tr>
    ${comps.data.map((c) => `<tr>
      <td><b>${esc(c.name)}</b> <span class="pill source">${esc(c.code)}</span></td>
      <td>${esc(c.country || '—')}</td>
      <td>${esc(c.historical_depth)}</td>
      <td class="num">${c.finished}</td><td class="num">${c.upcoming}</td>
      <td><button class="fav-btn" onclick="openStandings('${esc(c.code)}')">📊 Classement</button></td></tr>`).join('')}
    </table></div>
    <div id="standingsBox"></div>`;
}

window.openStandings = async (code) => {
  const box = $('#standingsBox');
  box.innerHTML = '<div class="loading">Calcul du classement depuis les résultats réels…</div>';
  try {
    const r = await api(`/competitions/${encodeURIComponent(code)}/standings`);
    const d = r.data;
    box.innerHTML = `<div class="card"><b>Classement — ${esc(d.competition)} (saison ${esc(String(d.season))}) ${tagPill('CALCULATED DATA')}</b>
      <div class="table-wrap" style="margin-top:8px"><table>
      <tr><th class="num">#</th><th>Équipe</th><th class="num">J</th><th class="num">G</th><th class="num">N</th><th class="num">P</th><th class="num">BP</th><th class="num">BC</th><th class="num">Diff</th><th class="num">Pts</th></tr>
      ${d.standings.map((s) => `<tr style="cursor:pointer" onclick="openTeam(${s.teamId})">
        <td class="num">${s.rank}</td><td>${badge(s.badge_url, s.name)} ${esc(s.name || '')}</td>
        <td class="num">${s.played}</td><td class="num">${s.won}</td><td class="num">${s.drawn}</td><td class="num">${s.lost}</td>
        <td class="num">${s.gf}</td><td class="num">${s.ga}</td><td class="num">${s.gd > 0 ? '+' : ''}${s.gd}</td><td class="num"><b>${s.points}</b></td></tr>`).join('')}
      </table></div>
      <small style="color:var(--muted)">${esc(d.note)}</small></div>`;
    box.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    box.innerHTML = `<div class="warn">Classement indisponible : ${esc(e.message)}</div>`;
  }
};

function valueRow(v) {
  return `<div class="card best-pick" onclick="openFixture(${v.fixture_id})" style="cursor:pointer">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div><b>${esc(v.home_name)} vs ${esc(v.away_name)}</b><br>
        <small style="color:var(--muted)">${esc(v.comp_name)} · ${fmtDate(v.kickoff_utc)}</small></div>
      <span class="pill value">VALUE BET</span>
    </div>
    <div class="kv" style="margin-top:8px">
      <dt>Marché / Sélection</dt><dd>${esc(v.market)} / ${esc(v.selection)}</dd>
      <dt>Prob. modèle vs marché</dt><dd>${pct(v.probability)} vs ${pct(v.market_probability)} ${tagPill('MODEL ESTIMATE')}</dd>
      <dt>Meilleure cote</dt><dd><span class="big-odds">${v.best_price}</span> (${esc(v.best_bookmaker)}) — fair odds ${v.fair_odds}</dd>
      <dt>Edge / EV</dt><dd>+${pct(v.edge)} / +${pct(v.ev)}</dd>
      <dt>Confiance / Qualité données</dt><dd>${pct(v.confidence)} / ${pct(v.data_quality)}</dd>
    </div></div>`;
}

async function renderValue() {
  const v = await api('/value-bets');
  app.innerHTML = `<h2 class="section">💎 VALUE BET ENGINE</h2>
    <div class="info">Formules : implied prob = 1/cote normalisée par la marge · fair odds = 1/P<sub>modèle</sub> · edge = P<sub>modèle</sub> − P<sub>marché</sub> · EV = P<sub>modèle</sub> × cote − 1. Critères : edge ≥ 3 %, EV ≥ 2 %, qualité de données ≥ 55 %. Cotes réelles publiées par Football-Data.co.uk.</div>
    ${v.data.length ? v.data.map(valueRow).join('') : `<div class="card"><h3># NO QUALIFIED PICK</h3><p style="color:var(--muted);margin-top:8px">${esc(v.note || '')}</p></div>`}`;
}

async function renderPredictions() {
  const p = await api('/predictions');
  const tr = p.trackRecord;
  const settled = tr.settled || [];
  const wins = settled.filter((s) => s.result === 'WIN').reduce((a, s) => a + s.n, 0);
  const losses = settled.filter((s) => s.result === 'LOSS').reduce((a, s) => a + s.n, 0);
  const units = settled.reduce((a, s) => a + (s.units || 0), 0);
  app.innerHTML = `<h2 class="section">🎯 Pronostics & Track Record</h2>
    <div class="card">
      <b>PAPER TRACKING (réel, immuable)</b> — ${esc(tr.note)}<br><br>
      <div class="prob-row">
        <div class="prob-box"><div class="v">${wins + losses ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : '—'}</div><div class="l">Réussite (${wins}W / ${losses}L)</div></div>
        <div class="prob-box"><div class="v">${units >= 0 ? '+' : ''}${units.toFixed(2)}</div><div class="l">Unités (mise 1 u.)</div></div>
        <div class="prob-box"><div class="v">${tr.pending}</div><div class="l">En attente</div></div>
      </div>
      ${!(wins + losses) ? '<div class="info">Aucun pronostic encore réglé : le track record se construit uniquement sur des résultats réels, jamais fictifs (§55).</div>' : ''}
    </div>
    <div class="table-wrap"><table>
      <tr><th>Match</th><th>Marché</th><th>Prob.</th><th>Cote</th><th>Edge</th><th>Décision</th><th>Résultat</th></tr>
      ${p.data.map((r) => `<tr style="cursor:pointer" onclick="openFixture(${r.fixture_id})">
        <td><b>${esc(r.home_name)} - ${esc(r.away_name)}</b><br><small style="color:var(--muted)">${fmtDate(r.kickoff_utc)}${r.home_score != null ? ` · ${r.home_score}-${r.away_score}` : ''}</small></td>
        <td>${esc(r.market)}/${esc(r.selection)}</td>
        <td class="num">${pct(r.probability)}</td><td class="num">${r.odds ?? '—'}</td>
        <td class="num">${r.edge != null ? '+' + pct(r.edge) : '—'}</td>
        <td>${r.decision === 'VALUE BET' ? '<span class="pill value">VALUE</span>' : esc(r.decision)}</td>
        <td><span class="pill ${r.result.toLowerCase()}">${esc(r.result)}</span></td></tr>`).join('')}
    </table></div>`;
}

async function renderFavorites() {
  const favs = await api('/favorites/' + userKey);
  const teamIds = favs.data.filter((f) => f.entity_type === 'team').map((f) => f.entity_id);
  if (!teamIds.length) {
    app.innerHTML = `<h2 class="section">⭐ Favoris</h2><div class="info">Aucun favori. Ouvrez une équipe (via la recherche ou un match) et cliquez sur ⭐ pour la suivre.</div>`;
    return;
  }
  let html = `<h2 class="section">⭐ Vos équipes suivies</h2>`;
  for (const id of teamIds) {
    try {
      const t = await api('/teams/' + id);
      html += `<div class="card"><div style="display:flex;align-items:center;gap:10px">
        ${badge(t.data.team.badge_url, t.data.team.name)}<b>${esc(t.data.team.name)}</b>
        <button class="fav-btn on" onclick="toggleFav('team',${id});nav('favorites')">⭐ Retirer</button></div>
        ${t.data.upcoming.slice(0, 3).map(matchRow).join('')}</div>`;
    } catch { /* équipe supprimée */ }
  }
  app.innerHTML = html;
}

async function renderCoverage() {
  const cov = await api('/coverage');
  const cell = (v) => `<td><span class="pill ${v === 'AVAILABLE' ? 'verified' : v === 'PARTIAL' ? 'conflict' : 'unknown'}">${v}</span></td>`;
  const cols = ['Fixtures', 'Live', 'Results', 'Statistics', 'Lineups', 'Players', 'Historical', 'Odds', 'xG'];
  app.innerHTML = `<h2 class="section">📊 COVERAGE CENTER</h2>
    <div class="info">Couverture mesurée sur les données réellement présentes en base — jamais déclarative (§61). UNAVAILABLE signifie qu'aucune source gratuite validée du registre ne fournit cette donnée pour l'instant.</div>
    <div class="table-wrap"><table>
      <tr><th>Compétition</th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>
      ${cov.data.map((c) => `<tr><td><b>${esc(c.name)}</b><br><small style="color:var(--muted)">${esc(c.country || '')}</small></td>${cols.map((k) => cell(c.coverage[k])).join('')}</tr>`).join('')}
    </table></div>`;
}

async function renderSources() {
  const [s, disc] = await Promise.all([api('/sources'), api('/discovery')]);
  const dstats = Object.fromEntries(disc.data.stats.map((x) => [x.status, x.n]));
  app.innerHTML = `<h2 class="section">🔌 DATA SOURCES — Source Monitor</h2>
    <div class="info">Cycle : DISCOVERED → TEST → VALIDATE → CLASSIFY → QUALITY CHECK → APPROVE/REJECT. La fiabilité est calculée uniquement sur les fetchs observés (succès / total) — jamais inventée (§8). Aucune dépendance à une source unique : chaque catégorie de données est couverte par plusieurs sources lorsque possible, avec failover automatique.</div>
    ${s.data.map((src) => `<div class="card">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <b>${esc(src.source_name)}</b>
        <span class="pill ${src.availability_status === 'AVAILABLE' ? 'verified' : src.availability_status === 'DOWN' ? 'loss' : 'unknown'}">${esc(src.availability_status)}</span>
      </div>
      <div class="kv" style="margin-top:8px">
        <dt>Type</dt><dd>${esc(src.source_type)}</dd>
        <dt>Catégories</dt><dd>${esc(src.data_categories)}</dd>
        <dt>Couverture</dt><dd>${esc(src.coverage)}</dd>
        <dt>Fiabilité observée</dt><dd>${src.reliability_score != null ? pct(src.reliability_score) + ` (${src.success_count} ok / ${src.failure_count} err)` : 'pas encore mesurée'}</dd>
        <dt>Latence moyenne</dt><dd>${src.avg_latency_ms != null ? Math.round(src.avg_latency_ms) + ' ms' : '—'}</dd>
        <dt>Dernier fetch OK</dt><dd>${src.last_successful_fetch ? fmtDate(src.last_successful_fetch) : '—'}</dd>
        <dt>Conditions</dt><dd style="font-weight:400">${esc(src.terms_status || '')}</dd>
        <dt>Attribution</dt><dd style="font-weight:400">${src.attribution_required ? esc(src.attribution_text || 'requise') : 'non requise'}</dd>
      </div>
      <small style="color:var(--muted)">${esc(src.notes || '')}</small>
    </div>`).join('')}
    <h2 class="section">🌍 SOURCE DISCOVERY ENGINE — ligues mondiales
      <span class="count">${dstats.APPROVED || 0} approuvées · ${dstats.PENDING || 0} en test · ${dstats.REJECTED || 0} rejetées</span></h2>
    <div class="info">${esc(disc.note)}</div>
    <div class="table-wrap"><table>
      <tr><th>Ligue</th><th>Pays</th><th>Statut</th><th>Compétition</th><th>Découverte via</th><th>Raison / validation</th></tr>
      ${disc.data.leagues.map((l) => `<tr>
        <td><b>${esc(l.name || 'ID ' + l.tsdb_id)}</b></td>
        <td>${esc(l.country || '—')}</td>
        <td><span class="pill ${l.status === 'APPROVED' ? 'verified' : l.status === 'PENDING' ? 'conflict' : 'unknown'}">${esc(l.status)}</span></td>
        <td>${esc(l.competition_code || '—')}</td>
        <td style="font-size:11px;color:var(--muted)">${esc(l.discovered_via || '')}</td>
        <td style="font-size:11px;color:var(--muted)">${esc((l.reason || '').slice(0, 90))}</td></tr>`).join('') || '<tr><td colspan="6">Premier cycle de découverte en cours…</td></tr>'}
    </table></div>`;
}

async function renderBacktest() {
  const comps = await api('/competitions');
  const withData = comps.data.filter((c) => c.finished > 200);
  app.innerHTML = `<h2 class="section">🧪 BACKTEST LAB</h2>
    <div class="info">Validation walk-forward : chaque prédiction du backtest n'utilise que les matchs antérieurs (interdiction de fuite temporelle §34). Les poids de l'ensemble sont choisis par minimisation du log-loss historique (§31).</div>
    <select id="btComp" style="background:var(--card2);color:var(--text);border:1px solid var(--border);padding:8px 12px;border-radius:8px">
      ${withData.map((c) => `<option value="${esc(c.code)}">${esc(c.name)} — ${c.finished} matchs réels</option>`).join('')}
    </select>
    <button class="fav-btn" style="margin-left:8px" onclick="runBacktest()">Lancer le backtest</button>
    <div id="btResult" style="margin-top:14px"></div>`;
}
window.runBacktest = async () => {
  $('#btResult').innerHTML = '<div class="loading">Backtest walk-forward en cours…</div>';
  const code = $('#btComp').value;
  const r = await api('/backtest/' + encodeURIComponent(code));
  if (!r.data) { $('#btResult').innerHTML = `<div class="warn">INSUFFICIENT DATA (${r.matches} matchs)</div>`; return; }
  const d = r.data;
  const mrow = (name, m) => `<tr><td>${name}</td><td class="num">${m.brier.toFixed(4)}</td><td class="num">${m.logloss.toFixed(4)}</td></tr>`;
  $('#btResult').innerHTML = `<div class="card">
    <b>${esc(d.competition)}</b> — ${d.trainingMatches} matchs réels, ${d.nTest} prédictions testées hors-échantillon
    <div class="table-wrap" style="margin-top:10px"><table>
      <tr><th>Modèle</th><th class="num">Brier Score ↓</th><th class="num">Log Loss ↓</th></tr>
      ${mrow('Elo', d.models.elo)}${mrow('Poisson', d.models.poisson)}${mrow('Dixon-Coles', d.models.dixonColes)}
      ${mrow('<b>Ensemble (poids validés)</b>', { brier: d.ensemble.brier, logloss: d.ensemble.logloss })}
    </table></div>
    <p style="margin-top:10px;font-size:13px;color:var(--muted)">Poids retenus : Elo ${pct(d.ensemble.weights.elo)} · Poisson ${pct(d.ensemble.weights.poisson)} · Dixon-Coles ${pct(d.ensemble.weights.dixonColes)} — choisis par grid search sur le log-loss hors-échantillon.</p>
    <h3 style="margin-top:14px;font-size:14px">Courbe de calibration (§35)</h3>
    <div class="table-wrap"><table><tr><th>Tranche prédite</th><th class="num">N</th><th class="num">Prob. moyenne prédite</th><th class="num">Fréquence observée</th></tr>
      ${d.calibration.filter((b) => b.n > 0).map((b) => `<tr><td>${b.bin}</td><td class="num">${b.n}</td><td class="num">${pct(b.predicted)}</td><td class="num">${pct(b.observed)}</td></tr>`).join('')}
    </table></div></div>`;
};

async function renderAdmin() {
  const o = await api('/admin/overview');
  const d = o.data;
  app.innerHTML = `<h2 class="section">🛠 ADMIN PANEL</h2>
    <div class="grid2">
      <div class="card"><b>Base de données</b><div class="kv" style="margin-top:8px">
        ${Object.entries(d.counts).map(([k, v]) => `<dt>${k}</dt><dd>${v.toLocaleString('fr-FR')}</dd>`).join('')}
        <dt>RAM</dt><dd>${d.memory.rss_mb} MB</dd><dt>Uptime</dt><dd>${Math.round(d.uptime_s / 60)} min</dd>
      </div></div>
      <div class="card"><b>Modèles entraînés</b>
        <div class="table-wrap"><table><tr><th>Version</th><th class="num">Matchs</th><th class="num">Brier</th><th class="num">LogLoss</th></tr>
        ${d.models.map((m) => `<tr><td>${esc(m.version)}</td><td class="num">${m.training_matches}</td><td class="num">${m.backtest_brier?.toFixed(4) ?? '—'}</td><td class="num">${m.backtest_logloss?.toFixed(4) ?? '—'}</td></tr>`).join('') || '<tr><td colspan="4">Entraînement en cours…</td></tr>'}
        </table></div></div>
    </div>
    <div class="card"><b>SYNC — derniers jobs</b>
      <div class="table-wrap"><table><tr><th>Job</th><th>Source</th><th>Statut</th><th class="num">Items</th><th>Début</th><th>Erreurs</th></tr>
      ${d.jobs.map((j) => `<tr><td>${esc(j.job_name)}</td><td>${esc(j.source_id || '—')}</td>
        <td><span class="pill ${j.status === 'COMPLETED' ? 'verified' : j.status === 'FAILED' ? 'loss' : 'conflict'}">${esc(j.status)}</span></td>
        <td class="num">${j.items}</td><td>${fmtDate(j.started_at)}</td><td style="max-width:220px;font-size:11px;color:var(--muted)">${esc((j.errors || '').slice(0, 120))}</td></tr>`).join('')}
      </table></div></div>
    <div class="card"><b>DATA CONFLICTS (§73)</b>
      ${d.conflicts.length ? `<div class="table-wrap"><table><tr><th>Entité</th><th>Champ</th><th>Valeurs</th><th>Règle</th></tr>
        ${d.conflicts.map((c) => `<tr><td>${esc(c.entity_type)} #${c.entity_id}</td><td>${esc(c.field)}</td><td style="font-size:11px">${esc(c.values_json)}</td><td style="font-size:11px;color:var(--muted)">${esc(c.resolution_rule)}</td></tr>`).join('')}</table></div>`
      : '<p style="color:var(--muted);margin-top:6px">Aucun conflit entre sources détecté actuellement.</p>'}</div>
    <div class="card"><b>Notifications</b>
      ${d.notifications.map((n) => `<div style="font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--border)"><span class="pill source">${esc(n.type)}</span> ${esc(n.payload.slice(0, 140))} <small style="color:var(--muted)">${fmtDate(n.created_at)}</small></div>`).join('') || '<p style="color:var(--muted)">Aucune.</p>'}</div>`;
}

/* ---------------- Match Center ---------------- */
window.openFixture = async (id) => {
  currentFixture = id;
  app.innerHTML = '<div class="loading">Chargement du match…</div>';
  window.scrollTo(0, 0);
  const fx = await api('/fixtures/' + id);
  const m = fx.data;
  currentMatch = m;
  const played = m.home_score != null;
  app.innerHTML = `
    <div class="card mc-header">
      <div style="color:var(--muted);font-size:13px;margin-bottom:10px">${esc(m.comp_name)} · ${esc(m.country || '')} ${m.round ? '· ' + esc(m.round) : ''}</div>
      <div class="mc-teams">
        <div class="mc-team">${badge(m.home_badge, m.home_name)}<span class="name">${esc(m.home_name)}</span>
          <button class="fav-btn" onclick="toggleFav('team',${m.home_id},this)">⭐ Suivre</button></div>
        <div><div class="mc-score">${played ? `${m.home_score} - ${m.away_score}` : 'vs'}</div>
          ${m.ht_home != null ? `<div style="color:var(--muted);font-size:12px">(${m.ht_home}-${m.ht_away} MT)</div>` : ''}
          <div style="margin-top:6px">${statusPill(m.status)} ${validPill(m.validation_status)}</div></div>
        <div class="mc-team">${badge(m.away_badge, m.away_name)}<span class="name">${esc(m.away_name)}</span>
          <button class="fav-btn" onclick="toggleFav('team',${m.away_id},this)">⭐ Suivre</button></div>
      </div>
      <div class="mc-sub">
        <span>🗓 ${fmtDate(m.kickoff_utc)}</span>
        ${m.venue_name ? `<span>🏟 ${esc(m.venue_name)}</span>` : ''}
        ${m.referee_name ? `<span>🟨 Arbitre : ${esc(m.referee_name)}</span>` : ''}
        <span>${freshPill(m.freshness)}</span>
        <span>Sources : ${(m.source_ids || []).join(' + ')}</span>
      </div>
      ${m.conflicts?.length ? `<div class="warn">⚠ DATA CONFLICT : les sources divergent sur ce match. Valeurs conservées et exposées, aucune résolution arbitraire (§6).</div>` : ''}
    </div>
    <div class="tabs" id="mcTabs">
      <button class="active" data-tab="apercu">Aperçu</button>
      <button data-tab="live">Live</button>
      <button data-tab="stats">Stats</button>
      <button data-tab="cotes">Cotes</button>
      <button data-tab="analyse">Analyse</button>
      <button data-tab="prono">Pronostics</button>
      ${played ? '<button data-tab="bilan">📋 Compte rendu</button>' : ''}
      <button data-tab="meteo">Météo</button>
    </div>
    <div id="mcBody"><div class="loading">…</div></div>`;
  document.querySelectorAll('#mcTabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#mcTabs button').forEach((x) => x.classList.toggle('active', x === b));
    loadTab(b.dataset.tab, m);
  }));
  loadTab('apercu', m);
};

/* ---------------- CENTRE DU MATCH (§v3.3) : compos, chrono, stats live ---------------- */
function renderMatchCenter(mc, m) {
  if (!mc) return '';
  let html = '';
  // Score / horloge en direct
  if (mc.clock && ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'].includes(mc.status)) {
    html += `<div class="card" style="text-align:center"><b style="font-size:22px">${mc.home_score ?? '–'} - ${mc.away_score ?? '–'}</b>
      <div style="color:var(--live,#e74c3c);font-weight:700;margin-top:4px">🔴 ${esc(mc.clock)} ${mc.status_detail ? '· ' + esc(mc.status_detail) : ''}</div>
      <div style="color:var(--muted);font-size:11px;margin-top:4px">Score en direct — mise à jour automatique toutes les 60 s ${tagPill('SOURCE DATA')}</div></div>`;
  }
  // Chronologie du jeu (buts, cartons, remplacements)
  if (mc.timeline?.length) {
    html += `<div class="card"><b>⏱ Chronologie du jeu ${tagPill('SOURCE DATA')}</b>
      <div class="timeline" style="margin-top:10px">${mc.timeline.map((e) => `<div class="ev"><b>${esc(e.minute || '')}</b> ${e.icon} ${esc(e.players.join(', ') || e.kind || '')} <small style="color:var(--muted)">${e.team ? '(' + esc(e.team) + ')' : ''}</small></div>`).join('')}</div></div>`;
  }
  // Stats officielles en barres (possession, tirs…)
  if (mc.live_stats?.length === 2) {
    const [a, b] = mc.live_stats[0].home ? mc.live_stats : [mc.live_stats[1], mc.live_stats[0]];
    const keys = Object.keys(a.values).filter((k) => k in b.values);
    if (keys.length) {
      html += `<div class="card"><b>📊 Statistiques du match ${tagPill('SOURCE DATA')}</b>
        <div style="margin-top:10px">${keys.map((k) => {
          const va = parseFloat(a.values[k]) || 0, vb = parseFloat(b.values[k]) || 0;
          const tot = va + vb || 1;
          return `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px"><span>${va}</span><span style="color:var(--muted)">${esc(k)}</span><span>${vb}</span></div>
            <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--border,#333)">
              <div style="width:${(va / tot * 100).toFixed(0)}%;background:var(--accent,#4c8dff)"></div>
              <div style="width:${(vb / tot * 100).toFixed(0)}%;background:var(--muted,#888);opacity:.5"></div></div></div>`;
        }).join('')}</div></div>`;
    }
  }
  // Compositions officielles
  if (mc.lineups?.length) {
    html += `<div class="card"><b>📋 Compositions officielles ${tagPill('SOURCE DATA')}</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px">
      ${mc.lineups.map((l) => `<div><div style="font-weight:700">${esc(l.team || '')} ${l.formation ? `<span class="pill">${esc(l.formation)}</span>` : ''}</div>
        <div style="margin-top:6px;font-size:13px">${l.starters.map((p) => `<div>${p.num ? `<span style="color:var(--muted);display:inline-block;min-width:22px">${esc(p.num)}</span>` : ''}${esc(p.name)} ${p.pos ? `<small style="color:var(--muted)">${esc(p.pos)}</small>` : ''}</div>`).join('')}</div>
        ${l.subs?.length ? `<div style="margin-top:6px;font-size:12px;color:var(--muted)">🔁 Entrés : ${l.subs.map((p) => esc(p.name)).join(', ')}</div>` : ''}</div>`).join('')}
      </div></div>`;
  }
  // Scores exacts les plus probables (modèle)
  if (mc.top_scores?.length && mc.status !== 'FINISHED') {
    html += `<div class="card"><b>🎯 Scores exacts les plus probables ${tagPill('MODEL ESTIMATE')}</b>
      <div class="prob-row" style="margin-top:10px">${mc.top_scores.map((s) => `<div class="prob-box"><div class="v">${esc(s.score)}</div><div class="l">${s.probability}%</div></div>`).join('')}</div></div>`;
  }
  // Cotes bookmaker publiées par ESPN
  if (mc.espn_odds?.h) {
    const o = mc.espn_odds;
    html += `<div class="card"><b>💰 Cotes ${esc(o.bookmaker)} (via ESPN) ${tagPill('SOURCE DATA')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${o.h}</div><div class="l">1</div></div>
        <div class="prob-box"><div class="v">${o.d}</div><div class="l">N</div></div>
        <div class="prob-box"><div class="v">${o.a}</div><div class="l">2</div></div>
        ${o.ouLine != null && o.over ? `<div class="prob-box"><div class="v">${o.over}</div><div class="l">+${o.ouLine} buts</div></div>
        <div class="prob-box"><div class="v">${o.under}</div><div class="l">-${o.ouLine} buts</div></div>` : ''}
      </div></div>`;
  }
  return html;
}

// Rafraîchissement automatique du centre du match pendant un match en direct
setInterval(() => {
  if (!currentFixture || !currentMatch) return;
  if (!['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'].includes(currentMatch.status)) return;
  const activeTab = document.querySelector('#mcTabs button.active');
  if (activeTab?.dataset.tab === 'apercu') openFixture(currentFixture);
}, 60_000);

async function loadTab(tab, m) {
  const body = $('#mcBody');
  body.innerHTML = '<div class="loading">Chargement…</div>';
  try {
    if (tab === 'apercu') {
      let mc = null, h2h = [];
      try { mc = (await api(`/fixtures/${m.id}/matchcenter`)).data; } catch { /* sections absentes */ }
      try { h2h = (await api(`/fixtures/${m.id}/h2h`)).data || []; } catch { /* absent */ }
      body.innerHTML = `
        ${renderMatchCenter(mc, m)}
        ${h2h.length ? `<div class="card"><b>⚔️ Face-à-face — ${h2h.length} dernière(s) confrontation(s) ${tagPill('SOURCE DATA')}</b>
          <div style="margin-top:10px">${h2h.map((g) => `<div class="match-row" onclick="event.stopPropagation();openFixture(${g.id})" style="cursor:pointer">
            <div class="team"><span>${esc(g.home_name)} <b>${g.home_score}-${g.away_score}</b> ${esc(g.away_name)}</span></div>
            <div class="match-meta"><span>${esc(g.comp_name)}</span><span>${fmtDate(g.kickoff_utc)}</span></div>
          </div>`).join('')}</div></div>` : ''}
        ${m.events?.length ? `<div class="card"><b>Timeline (SOURCE DATA — ${esc(m.events[0].source_id)})</b>
          <div class="timeline" style="margin-top:10px">${m.events.map((e) => `<div class="ev"><b>${e.minute != null ? e.minute + "'" : ''}</b> ${e.type === 'GOAL' ? '⚽' : e.type === 'PENALTY_GOAL' ? '⚽ (pen.)' : e.type === 'OWN_GOAL' ? '⚽ (csc)' : '•'} ${esc(e.player_name || '')} <small style="color:var(--muted)">(${e.team_side === 'home' ? esc(m.home_name) : esc(m.away_name)}, ${esc(e.detail || '')})</small></div>`).join('')}</div></div>` : ''}
        <div class="card"><b>Fiche du match</b><div class="kv" style="margin-top:8px">
          <dt>Statut</dt><dd>${STATUS_FR[m.status] || m.status}</dd>
          <dt>Validation</dt><dd>${m.validation_status} ${m.validation_status === 'VERIFIED' ? '(≥2 sources concordantes)' : m.validation_status === 'UNVERIFIED' ? '(1 seule source pour l\u2019instant)' : ''}</dd>
          <dt>Provenance</dt><dd>${(m.source_ids || []).join(', ')} ${tagPill(m.data_tag)}</dd>
          <dt>Dernière mise à jour</dt><dd>${fmtDate(m.updated_at)}</dd>
          ${m.quality ? `<dt>Data Quality Score</dt><dd>${pct(m.quality.score)}</dd>` : ''}
        </div></div>
        ${!m.events?.length && m.status !== 'FINISHED' ? '<div class="info">Timeline détaillée : DATA UNAVAILABLE pour cette compétition (couverte par OpenLigaDB pour les ligues allemandes uniquement).</div>' : ''}`;
    } else if (tab === 'live') {
      const lv = await api(`/fixtures/${m.id}/live`);
      const d = lv.data;
      let html = '';
      if (d.preMatch) {
        html += `<div class="card"><b>Probabilités pré-match (référence AVANT) ${tagPill('MODEL ESTIMATE')}</b>
          <div class="prob-row" style="margin-top:10px">
            <div class="prob-box"><div class="v">${pct(d.preMatch.p_home)}</div><div class="l">${esc(m.home_name)}</div></div>
            <div class="prob-box"><div class="v">${pct(d.preMatch.p_draw)}</div><div class="l">Nul</div></div>
            <div class="prob-box"><div class="v">${pct(d.preMatch.p_away)}</div><div class="l">${esc(m.away_name)}</div></div>
          </div></div>`;
      }
      if (d.snapshots?.length) {
        const last = d.snapshots[d.snapshots.length - 1];
        html += `<div class="card"><b>Dernier recalcul LIVE — ${last.minute}' · ${last.score_home}-${last.score_away} ${tagPill('MODEL ESTIMATE')}</b>
          <div class="prob-row" style="margin-top:10px">
            <div class="prob-box"><div class="v">${pct(last.p_home)}</div><div class="l">${esc(m.home_name)}</div></div>
            <div class="prob-box"><div class="v">${pct(last.p_draw)}</div><div class="l">Nul</div></div>
            <div class="prob-box"><div class="v">${pct(last.p_away)}</div><div class="l">${esc(m.away_name)}</div></div>
            <div class="prob-box"><div class="v">${last.exp_total_goals?.toFixed(2)}</div><div class="l">Buts totaux attendus</div></div>
          </div></div>
          <div class="card"><b>Historique des recalculs (snapshots immuables — AVANT → APRÈS)</b>
          <div class="table-wrap" style="margin-top:8px"><table>
          <tr><th class="num">Minute</th><th class="num">Score</th><th class="num">1</th><th class="num">N</th><th class="num">2</th><th>Déclencheur</th><th>Horodatage</th></tr>
          ${d.snapshots.map((s) => `<tr><td class="num">${s.minute}'</td><td class="num"><b>${s.score_home}-${s.score_away}</b></td>
            <td class="num">${pct(s.p_home)}</td><td class="num">${pct(s.p_draw)}</td><td class="num">${pct(s.p_away)}</td>
            <td>${s.trigger === 'SCORE_CHANGE' ? '⚽ Score' : '⏱ Temps'}</td><td style="font-size:11px;color:var(--muted)">${fmtDate(s.computed_at)}</td></tr>`).join('')}
          </table></div>
          <small style="color:var(--muted)">Méthode : score réel acquis + Poisson sur les buts restants (λ pré-match × temps restant/95'). Minute estimée depuis le coup d'envoi (CALCULATED). Recalcul toutes les 60 s ou à chaque but. Aucun snapshot n'est réécrit.</small></div>`;
      } else {
        html += `<div class="info">${esc(lv.note || 'Pas de suivi live pour ce match.')}</div>`;
      }
      body.innerHTML = html;
    } else if (tab === 'stats') {
      if (!m.stats?.length) { body.innerHTML = '<div class="info">STATISTIQUES : DATA UNAVAILABLE — la source ne publie les stats détaillées qu\'après le match pour cette compétition.</div>'; return; }
      const h = m.stats.find((s) => s.team_side === 'home') || {};
      const a = m.stats.find((s) => s.team_side === 'away') || {};
      const bar = (label, hv, av) => {
        if (hv == null && av == null) return '';
        const t = (hv || 0) + (av || 0) || 1;
        return `<div class="stat-bar"><div class="num">${hv ?? '—'}</div>
          <div><div class="bars"><div class="bh" style="width:${((hv || 0) / t) * 100}%"></div><div class="ba" style="width:${((av || 0) / t) * 100}%"></div></div></div>
          <div>${av ?? '—'}</div><div class="label">${label}</div></div>`;
      };
      body.innerHTML = `<div class="card"><b>Statistiques du match ${tagPill('SOURCE DATA')}</b>
        ${bar('Tirs', h.shots, a.shots)}${bar('Tirs cadrés', h.shots_on_target, a.shots_on_target)}
        ${bar('Corners', h.corners, a.corners)}${bar('Fautes', h.fouls, a.fouls)}
        ${bar('Cartons jaunes', h.yellow, a.yellow)}${bar('Cartons rouges', h.red, a.red)}
        <small style="color:var(--muted)">Source : ${esc(h.source_id || a.source_id || '')}</small></div>`;
    } else if (tab === 'cotes') {
      const o = await api(`/fixtures/${m.id}/odds`);
      if (!o.data) { body.innerHTML = '<div class="info">COTES : DATA UNAVAILABLE — aucune cote publiée par les sources du registre pour ce match.</div>'; return; }
      let html = '';
      for (const [mkt, sels] of Object.entries(o.data.markets)) {
        html += `<div class="card"><b>Marché ${esc(mkt)} ${tagPill('SOURCE DATA')}</b>
          <div class="table-wrap" style="margin-top:8px"><table>
          <tr><th>Sélection</th><th class="num">Meilleure cote</th><th>Bookmaker</th><th class="num">Moyenne</th><th class="num">Dispersion</th></tr>
          ${Object.entries(sels).map(([sel, v]) => `<tr><td><b>${esc(sel)}</b></td>
            <td class="num big-odds" style="font-size:16px">${v.bestPrice?.price ?? '—'}</td>
            <td>${esc(v.bestPrice?.book || '—')}</td><td class="num">${v.avg?.toFixed(2) ?? '—'}</td>
            <td class="num">${v.dispersion?.toFixed(2) ?? '—'}</td></tr>`).join('')}
          </table></div>
          <small style="color:var(--muted)">Bookmakers réels comparés : ${Object.values(sels)[0]?.prices?.map((p) => p.book).join(', ') || '—'} · Source : Football-Data.co.uk</small></div>`;
      }
      if (o.data.history?.length) {
        const bySel = {};
        for (const s of o.data.history.filter((x) => x.market_code === '1X2' && x.bookmaker_code === 'Avg')) {
          (bySel[s.selection] ||= []).push(s);
        }
        const evol = Object.entries(bySel).filter(([, arr]) => arr.length > 1);
        if (evol.length) {
          html += `<div class="card"><b>Évolution des cotes (snapshots réels)</b>
            ${evol.map(([sel, arr]) => `<div style="margin-top:8px"><small>${esc(sel)} : ${arr.map((x) => x.price).join(' → ')}</small>
            <div class="spark">${arr.map((x) => `<div style="height:${Math.min(100, (x.price / Math.max(...arr.map((y) => y.price))) * 100)}%" title="${x.price} @ ${fmtDate(x.snapshot_at)}"></div>`).join('')}</div></div>`).join('')}</div>`;
        } else {
          html += `<div class="info">Évolution des cotes : un seul snapshot pour l'instant — le graphe se remplit à mesure que la source publie de nouvelles valeurs (jamais de mouvement simulé).</div>`;
        }
      }
      body.innerHTML = html;
    } else if (tab === 'analyse' || tab === 'prono') {
      const r = await api(`/fixtures/${m.id}/analysis`);
      body.innerHTML = renderAnalysis(r.data, m, tab);
    } else if (tab === 'bilan') {
      const rv = await api(`/reviews/${m.id}`);
      if (!rv.data) {
        body.innerHTML = `<div class="info">${esc(rv.note || 'Compte rendu en préparation — généré automatiquement après le match (recherche des faits de jeu en cours).')}</div>`;
      } else {
        const r = rv.data;
        const vlabel = { VALIDATED: '✅ PRONOSTIC VALIDÉ', NOT_VALIDATED: '❌ PRONOSTIC NON VALIDÉ', MIXED: '➗ RÉSULTAT MIXTE', NO_PICK: 'Aucun pronostic sur ce match' }[r.verdict] || r.verdict;
        body.innerHTML = `
          <div class="card"><b>${vlabel}</b>
            <pre style="white-space:pre-wrap;font-family:inherit;margin-top:10px">${esc(r.summary)}</pre>
            <div style="color:var(--muted);font-size:12px;margin-top:8px">Sources consultées : ${esc(r.research_sources || '—')} · généré le ${fmtDate(r.created_at)}</div>
          </div>
          ${r.factors?.factors?.length ? `<div class="card"><b>Faits observés (chacun avec provenance)</b>
            <div class="timeline" style="margin-top:10px">${r.factors.factors.map((f) => `<div class="ev">${esc(f.detail)} <small style="color:var(--muted)">[${esc(f.tag)} · ${esc(f.source || '')}]</small></div>`).join('')}</div></div>` : ''}`;
      }
    } else if (tab === 'meteo') {
      const w = await api(`/fixtures/${m.id}/weather`);
      if (!w.data) { body.innerHTML = `<div class="info">WEATHER DATA UNAVAILABLE — ${esc(w.reason || 'localisation ou fenêtre de prévision indisponible.')}</div>`; return; }
      body.innerHTML = `<div class="card"><b>Météo au coup d'envoi ${tagPill('SOURCE DATA')}</b>
        <div class="prob-row" style="margin-top:10px">
          <div class="prob-box"><div class="v">${w.data.temperature_c ?? '—'}°C</div><div class="l">Température</div></div>
          <div class="prob-box"><div class="v">${w.data.precipitation_mm ?? '—'} mm</div><div class="l">Précipitations</div></div>
          <div class="prob-box"><div class="v">${w.data.wind_kmh ?? '—'} km/h</div><div class="l">Vent</div></div>
          <div class="prob-box"><div class="v">${w.data.humidity ?? '—'}%</div><div class="l">Humidité</div></div>
        </div><small style="color:var(--muted)">Source : Open-Meteo.com · récupéré ${fmtDate(w.data.retrieved_at)}</small></div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="warn">Erreur : ${esc(e.message)}</div>`;
  }
}

function renderAnalysis(rep, m, tab) {
  if (!rep) return '<div class="warn"># DATA UNAVAILABLE</div>';
  let html = '';
  if (tab === 'analyse') {
    const fh = rep.form?.home, fa = rep.form?.away;
    if (fh && fa) {
      html += `<div class="card"><b>Forme récente ${tagPill('CALCULATED DATA')}</b>
        <div class="kv" style="margin-top:8px">
          <dt>${esc(m.home_name)}</dt><dd>${fh.seq} — ${fh.gf} BP / ${fh.ga} BC (${fh.n} matchs réels)</dd>
          <dt>${esc(m.away_name)}</dt><dd>${fa.seq} — ${fa.gf} BP / ${fa.ga} BC (${fa.n} matchs réels)</dd>
          ${rep.fatigue?.home != null ? `<dt>Repos</dt><dd>${rep.fatigue.home} j (dom.) / ${rep.fatigue.away} j (ext.)</dd>` : ''}
        </div></div>`;
    } else html += '<div class="info">Forme : INSUFFICIENT DATA pour au moins une équipe.</div>';
    if (rep.headToHead?.matches?.length) {
      html += `<div class="card"><b>Head to Head ${tagPill('SOURCE DATA')}</b>
        <div class="table-wrap" style="margin-top:8px"><table><tr><th>Date</th><th>Match</th><th class="num">Score</th></tr>
        ${rep.headToHead.matches.map((h) => `<tr><td>${(h.kickoff_utc || '').slice(0, 10)}</td><td>${esc(h.home_name)} - ${esc(h.away_name)}</td><td class="num"><b>${h.home_score}-${h.away_score}</b></td></tr>`).join('')}</table></div>
        <small style="color:var(--muted)">Pondération : les confrontations récentes pèsent plus dans les modèles (demi-vie 240 j).</small></div>`;
    } else html += '<div class="info">Head-to-head : aucune confrontation directe dans l\'historique réel chargé.</div>';
    const sh = rep.statistics?.home, sa = rep.statistics?.away;
    if (sh && sa) {
      html += `<div class="card"><b>Profil statistique (moy. derniers matchs) ${tagPill('CALCULATED DATA')}</b>
        <div class="table-wrap" style="margin-top:8px"><table>
        <tr><th></th><th class="num">Tirs</th><th class="num">Cadrés</th><th class="num">Corners</th><th class="num">Fautes</th><th class="num">Jaunes</th></tr>
        <tr><td><b>${esc(m.home_name)}</b></td><td class="num">${sh.shots}</td><td class="num">${sh.sot}</td><td class="num">${sh.corners}</td><td class="num">${sh.fouls}</td><td class="num">${sh.yellow}</td></tr>
        <tr><td><b>${esc(m.away_name)}</b></td><td class="num">${sa.shots}</td><td class="num">${sa.sot}</td><td class="num">${sa.corners}</td><td class="num">${sa.fouls}</td><td class="num">${sa.yellow}</td></tr>
        </table></div></div>`;
    }
    if (rep.context && !rep.context.status) {
      html += `<div class="card"><b>Contexte — classement calculé (saison ${esc(String(rep.context.season))}) ${tagPill('CALCULATED DATA')}</b>
        <div class="kv" style="margin-top:8px">
          <dt>${esc(m.home_name)}</dt><dd>${rep.context.home.rank}e / ${rep.context.of} — ${rep.context.home.points} pts, ${rep.context.home.played} matchs, diff ${rep.context.home.gd > 0 ? '+' : ''}${rep.context.home.gd}</dd>
          <dt>${esc(m.away_name)}</dt><dd>${rep.context.away.rank}e / ${rep.context.of} — ${rep.context.away.points} pts, ${rep.context.away.played} matchs, diff ${rep.context.away.gd > 0 ? '+' : ''}${rep.context.away.gd}</dd>
        </div><small style="color:var(--muted)">Classement recalculé depuis les résultats réels en base (3/1/0) — les retraits administratifs de points ne sont pas couverts.</small></div>`;
    }
    if (rep.xg?.home || rep.xg?.away) {
      const xh = rep.xg.home, xa = rep.xg.away;
      html += `<div class="card"><b>xG estimé — proxy tirs réels ${tagPill('MODEL ESTIMATE')}</b>
        <div class="table-wrap" style="margin-top:8px"><table>
        <tr><th></th><th class="num">xG pour / match</th><th class="num">xG contre / match</th><th class="num">Matchs</th></tr>
        ${xh ? `<tr><td><b>${esc(m.home_name)}</b></td><td class="num">${xh.xgForAvg}</td><td class="num">${xh.xgAgainstAvg}</td><td class="num">${xh.matches}</td></tr>` : `<tr><td><b>${esc(m.home_name)}</b></td><td colspan="3">DATA UNAVAILABLE (pas assez de matchs avec stats de tirs)</td></tr>`}
        ${xa ? `<tr><td><b>${esc(m.away_name)}</b></td><td class="num">${xa.xgForAvg}</td><td class="num">${xa.xgAgainstAvg}</td><td class="num">${xa.matches}</td></tr>` : `<tr><td><b>${esc(m.away_name)}</b></td><td colspan="3">DATA UNAVAILABLE (pas assez de matchs avec stats de tirs)</td></tr>`}
        </table></div>
        <small style="color:var(--muted)">⚠ Ce n'est PAS le xG événementiel (indisponible en source gratuite validée) : ${esc((xh || xa)?.method || '')}.</small></div>`;
    } else if (rep.xg) {
      html += `<div class="info">xG : DATA UNAVAILABLE — pas de stats de tirs pour ces équipes ; le proxy n'est pas fabriqué.</div>`;
    }
    if (rep.referee?.profile) {
      const rp = rep.referee.profile;
      html += `<div class="card"><b>Arbitre : ${esc(rp.name)} ${tagPill('CALCULATED DATA')}</b>
        <p style="font-size:13px;margin-top:6px">${rp.matches} matchs arbitrés dans les données réelles — moyenne ${rp.avgYellowPerTeam} jaunes et ${rp.avgFoulsPerTeam} fautes par équipe.</p></div>`;
    }
    html += `<div class="card"><b>Absences / Compositions</b>
      <p style="font-size:13px;color:var(--muted);margin-top:6px">${esc(rep.absences?.note || '')} Statut : <b>DATA UNAVAILABLE</b> — rien n'est inventé (§22, §76).</p></div>`;
  }
  // modèle + décision (les deux onglets)
  if (rep.model?.probabilities) {
    const p = rep.model.probabilities['1X2'];
    html += `<div class="card"><b>Probabilités du modèle d'ensemble ${tagPill('MODEL ESTIMATE')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${pct(p.HOME)}</div><div class="l">${esc(m.home_name)}</div></div>
        <div class="prob-box"><div class="v">${pct(p.DRAW)}</div><div class="l">Nul</div></div>
        <div class="prob-box"><div class="v">${pct(p.AWAY)}</div><div class="l">${esc(m.away_name)}</div></div>
      </div>
      <div class="prob-row">
        <div class="prob-box"><div class="v">${pct(rep.model.probabilities['OU2.5'].OVER)}</div><div class="l">Over 2.5</div></div>
        <div class="prob-box"><div class="v">${pct(rep.model.probabilities.BTTS.YES)}</div><div class="l">BTTS Oui</div></div>
        <div class="prob-box"><div class="v">${rep.model.lambdas.home.toFixed(2)} - ${rep.model.lambdas.away.toFixed(2)}</div><div class="l">Buts attendus (λ)</div></div>
      </div>
      <div class="table-wrap"><table><tr><th>Modèle</th><th class="num">1</th><th class="num">N</th><th class="num">2</th></tr>
        ${Object.entries(rep.model.perModel).map(([n, pm]) => `<tr><td>${n}</td><td class="num">${pct(pm.home)}</td><td class="num">${pct(pm.draw)}</td><td class="num">${pct(pm.away)}</td></tr>`).join('')}
      </table></div>
      <small style="color:var(--muted)">Version ${esc(rep.model.version)} · backtest walk-forward : LogLoss ${rep.model.backtest?.ensemble?.logloss?.toFixed(4) ?? '—'}, Brier ${rep.model.backtest?.ensemble?.brier?.toFixed(4) ?? '—'} sur ${rep.model.backtest?.nTest ?? '—'} matchs hors-échantillon.</small></div>`;
  } else if (rep.model) {
    html += `<div class="warn"># ${esc(rep.model.status || 'INSUFFICIENT DATA')} — ${esc(rep.model.reason || '')}</div>`;
  }
  if (rep.decision) {
    const d = rep.decision;
    if (d.best) {
      html += `<div class="card best-pick"><b># BEST QUALIFIED PICK ${d.decision === 'VALUE BET' ? '<span class="pill value">VALUE BET</span>' : ''}</b>
        <div class="kv" style="margin-top:10px">
          <dt>Marché</dt><dd>${esc(d.best.market)}</dd>
          <dt>Sélection</dt><dd>${esc(d.best.selection)}</dd>
          <dt>Probabilité modèle</dt><dd>${pct(d.best.pModel)}</dd>
          <dt>Probabilité marché</dt><dd>${pct(d.best.pMarket)} (marge retirée, overround ${((d.best.overround - 1) * 100).toFixed(1)}%)</dd>
          <dt>Fair Odds</dt><dd>${d.best.fairOdds}</dd>
          <dt>Cote disponible</dt><dd><span class="big-odds">${d.best.bestPrice}</span> (${esc(d.best.bestBook)})</dd>
          <dt>Edge</dt><dd>+${pct(d.best.edge)}</dd>
          <dt>EV</dt><dd>+${pct(d.best.ev)}</dd>
        </div></div>`;
    } else {
      html += `<div class="card"><b># NO QUALIFIED PICK</b><p style="margin-top:8px;font-size:13.5px;color:var(--muted)">${esc(d.noBetReason || '')}</p><p style="font-size:12px;color:var(--muted);margin-top:6px">Aucun pronostic n'est jamais forcé (§41, §44).</p></div>`;
    }
    html += `<div class="gauges">
      <div class="gauge"><div class="g-label">Data Quality</div><div class="g-track"><div class="g-fill" style="width:${(d.dataQuality?.score || 0) * 100}%"></div></div><div class="g-val">${pct(d.dataQuality?.score)}</div></div>
      <div class="gauge"><div class="g-label">Model Confidence</div><div class="g-track"><div class="g-fill" style="width:${(rep.model?.confidence || 0) * 100}%"></div></div><div class="g-val">${pct(rep.model?.confidence)}</div></div>
    </div>`;
    if (tab === 'prono' && d.candidates?.length) {
      html += `<div class="card"><b>Tous les marchés analysés (§44 : aucun pronostic par défaut)</b>
        <div class="table-wrap" style="margin-top:8px"><table>
        <tr><th>Marché</th><th>Sélection</th><th class="num">P modèle</th><th class="num">P marché</th><th class="num">Cote</th><th class="num">Edge</th><th class="num">EV</th><th>Qualifié</th></tr>
        ${d.candidates.map((c) => `<tr><td>${esc(c.market)}</td><td>${esc(c.selection)}</td>
          <td class="num">${pct(c.pModel)}</td><td class="num">${pct(c.pMarket)}</td><td class="num">${c.bestPrice}</td>
          <td class="num" style="color:${c.edge > 0 ? 'var(--accent)' : 'var(--red)'}">${c.edge > 0 ? '+' : ''}${pct(c.edge)}</td>
          <td class="num" style="color:${c.ev > 0 ? 'var(--accent)' : 'var(--red)'}">${c.ev > 0 ? '+' : ''}${pct(c.ev)}</td>
          <td>${c.qualifies ? '✅' : '—'}</td></tr>`).join('')}
        </table></div></div>`;
    }
  }
  if (tab === 'prono' && rep.conclusion) {
    html += `<div class="card"><b>Conclusion de l'analyse</b><p style="margin-top:8px;font-size:13.5px;line-height:1.7">${esc(rep.conclusion)}</p></div>`;
  }
  return html || '<div class="info"># INSUFFICIENT DATA</div>';
}

/* ---------------- favoris ---------------- */
window.toggleFav = async (type, id, btn) => {
  const favs = await api('/favorites/' + userKey);
  const exists = favs.data.some((f) => f.entity_type === type && f.entity_id === id);
  await api('/favorites', {
    method: exists ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey, entityType: type, entityId: id }),
  });
  if (btn) { btn.classList.toggle('on', !exists); btn.textContent = exists ? '⭐ Suivre' : '⭐ Suivi'; }
};

/* ---------------- recherche ---------------- */
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#searchResults');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  searchTimer = setTimeout(async () => {
    const r = await api('/search?q=' + encodeURIComponent(q));
    const d = r.data;
    let html = '';
    if (d.teams.length) html += `<div class="sr-group">Équipes</div>` + d.teams.map((t) =>
      `<div class="sr-item" onclick="openTeam(${t.id})">${badge(t.badge_url, t.name)} ${esc(t.name)} <small style="color:var(--muted)">${esc(t.country || '')}</small></div>`).join('');
    if (d.fixtures.length) html += `<div class="sr-group">Matchs</div>` + d.fixtures.map((f) =>
      `<div class="sr-item" onclick="openFixture(${f.id});document.getElementById('searchResults').classList.add('hidden')">${esc(f.home_name)} vs ${esc(f.away_name)} <small style="color:var(--muted)">${fmtDate(f.kickoff_utc)}</small></div>`).join('');
    if (d.competitions.length) html += `<div class="sr-group">Compétitions</div>` + d.competitions.map((c) =>
      `<div class="sr-item" onclick="nav('competitions');document.getElementById('searchResults').classList.add('hidden')">🏆 ${esc(c.name)} <small style="color:var(--muted)">${esc(c.country || '')}</small></div>`).join('');
    box.innerHTML = html || '<div class="sr-item">Aucun résultat dans les données réelles.</div>';
    box.classList.remove('hidden');
  }, 250);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) $('#searchResults').classList.add('hidden');
});

window.openTeam = async (id) => {
  $('#searchResults').classList.add('hidden');
  app.innerHTML = '<div class="loading">Chargement…</div>';
  const [t, pr] = await Promise.all([api('/teams/' + id), api('/teams/' + id + '/profile')]);
  const d = t.data;
  const p = pr.data || {};
  const rec = (r) => r ? `${r.w}V ${r.d}N ${r.l}D · ${r.gf} BP / ${r.ga} BC (${r.played} matchs)` : 'INSUFFICIENT DATA';
  let dossier = '';
  if (p.context && !p.context.status) {
    dossier += `<div class="card"><b>Contexte ${tagPill('CALCULATED DATA')}</b>
      <div class="kv" style="margin-top:8px">
        <dt>Compétition</dt><dd>${esc(p.context.competition)} (saison ${esc(String(p.context.season))})</dd>
        <dt>Classement calculé</dt><dd><b>${p.context.rank}e</b> / ${p.context.of} — ${p.context.points} pts, ${p.context.played} matchs, diff ${p.context.gd > 0 ? '+' : ''}${p.context.gd}</dd>
      </div></div>`;
  }
  dossier += `<div class="card"><b>Forme domicile / extérieur ${tagPill('CALCULATED DATA')}</b>
    <div class="kv" style="margin-top:8px">
      <dt>Domicile</dt><dd>${rec(p.form?.home)}</dd>
      <dt>Extérieur</dt><dd>${rec(p.form?.away)}</dd>
    </div></div>`;
  if (p.statistics && !p.statistics.status) {
    dossier += `<div class="card"><b>Statistiques moyennes (${p.statistics.matches} derniers matchs avec stats) ${tagPill('CALCULATED DATA')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${p.statistics.shots ?? '—'}</div><div class="l">Tirs</div></div>
        <div class="prob-box"><div class="v">${p.statistics.shotsOnTarget ?? '—'}</div><div class="l">Cadrés</div></div>
        <div class="prob-box"><div class="v">${p.statistics.corners ?? '—'}</div><div class="l">Corners</div></div>
        <div class="prob-box"><div class="v">${p.statistics.fouls ?? '—'}</div><div class="l">Fautes</div></div>
        <div class="prob-box"><div class="v">${p.statistics.yellow ?? '—'}</div><div class="l">Jaunes</div></div>
      </div></div>`;
  } else {
    dossier += `<div class="info">Statistiques détaillées : DATA UNAVAILABLE — ${esc(p.statistics?.note || '')}</div>`;
  }
  if (p.xgProxy && !p.xgProxy.status) {
    dossier += `<div class="card"><b>xG estimé (proxy tirs réels) ${tagPill('MODEL ESTIMATE')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${p.xgProxy.xgForAvg}</div><div class="l">xG pour / match</div></div>
        <div class="prob-box"><div class="v">${p.xgProxy.xgAgainstAvg}</div><div class="l">xG contre / match</div></div>
        <div class="prob-box"><div class="v">${p.xgProxy.matches}</div><div class="l">Matchs</div></div>
      </div><small style="color:var(--muted)">⚠ PAS un xG événementiel : ${esc(p.xgProxy.method)}.</small></div>`;
  } else {
    dossier += `<div class="info">xG : DATA UNAVAILABLE — ${esc(p.xgProxy?.note || 'pas de stats de tirs.')}</div>`;
  }
  if (p.modelFactors && !p.modelFactors.status) {
    dossier += `<div class="card"><b>Facteurs internes — forces du modèle ${tagPill('MODEL ESTIMATE')}</b>
      <div class="kv" style="margin-top:8px">
        <dt>Elo</dt><dd><b>${p.modelFactors.elo}</b></dd>
        <dt>Force offensive</dt><dd>${p.modelFactors.attackStrength ?? '—'} (1.0 = moyenne ligue)</dd>
        <dt>Faiblesse défensive</dt><dd>${p.modelFactors.defenseWeakness ?? '—'} (1.0 = moyenne ligue)</dd>
      </div><small style="color:var(--muted)">${esc(p.modelFactors.note || '')}</small></div>`;
  }
  dossier += `<div class="card"><b>Facteurs externes — calendrier / fatigue ${tagPill('CALCULATED DATA')}</b>
    <div class="kv" style="margin-top:8px">
      <dt>Repos depuis le dernier match</dt><dd>${p.fatigue?.restDays ?? '—'} jour(s)</dd>
      <dt>Matchs sur 30 jours</dt><dd>${p.fatigue?.matchesLast30Days ?? '—'}</dd>
    </div></div>
    <div class="card"><b>Absences / effectif</b>
      <p style="font-size:13px;color:var(--muted);margin-top:6px">Statut : <b>DATA UNAVAILABLE</b> — ${esc(p.availability?.note || '')}</p></div>`;
  app.innerHTML = `<div class="card" style="display:flex;align-items:center;gap:14px">
      ${badge(d.team.badge_url, d.team.name)}
      <div><h2 style="font-size:20px">${esc(d.team.name)}</h2><small style="color:var(--muted)">${esc(d.team.country || '')}</small></div>
      <button class="fav-btn" onclick="toggleFav('team',${d.team.id},this)">⭐ Suivre</button>
    </div>
    <h2 class="section">📋 Dossier complet de l'équipe</h2>
    ${dossier}
    <h2 class="section">Prochains matchs</h2>
    ${d.upcoming.map(matchRow).join('') || '<div class="info">Aucun match à venir dans les sources.</div>'}
    <h2 class="section">Derniers résultats réels</h2>
    ${d.recent.map(matchRow).join('') || '<div class="info">DATA UNAVAILABLE</div>'}`;
};

/* ---------------- assistant IA ---------------- */
window.toggleAssistant = () => $('#assistant').classList.toggle('hidden');
$('#assistantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#assistantQ').value.trim();
  if (!q) return;
  const log = $('#assistantLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div>`);
  $('#assistantQ').value = '';
  log.scrollTop = log.scrollHeight;
  try {
    const r = await api('/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, fixtureId: currentFixture }),
    });
    log.insertAdjacentHTML('beforeend', `<div class="msg bot">${esc(r.data.answer)}${r.data.grounded ? ' <span class="pill source" style="font-size:9px">ANCRÉ DONNÉES</span>' : ''}</div>`);
  } catch {
    log.insertAdjacentHTML('beforeend', `<div class="msg bot">Erreur de connexion à l'API.</div>`);
  }
  log.scrollTop = log.scrollHeight;
});

/* ---------------- SSE temps réel ---------------- */
try {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => { $('#liveIndicator').classList.add('on'); $('#liveCount').textContent = 'Temps réel'; });
  es.addEventListener('live_update', (e) => {
    const d = JSON.parse(e.data);
    $('#liveCount').textContent = `${d.liveCount} live`;
    if (currentView === 'live' || currentView === 'home') nav(currentView);
  });
  es.addEventListener('predictions_settled', () => { if (currentView === 'predictions') nav('predictions'); });
  es.addEventListener('selections', () => {
    notifyUser('🥇 Sélections du jour mises à jour', 'Expert du jour et Combiné Safe viennent d\u2019être recalculés.');
    if (currentView === 'expert' || currentView === 'combo') nav(currentView);
  });
  es.addEventListener('reviews', (e) => {
    const d = JSON.parse(e.data);
    notifyUser('📋 Comptes rendus disponibles', `${d.created} pronostic(s) analysé(s) après match : pourquoi validé ou non.`);
  });
  es.addEventListener('newday', (e) => {
    const d = JSON.parse(e.data);
    notifyUser('📅 Nouveau jour de matchs', `Les matchs du ${d.day} sont analysés.`);
    if (currentView === 'home') nav('home');
  });
  es.addEventListener('live_prediction', () => {
    // recalcul live publié : rafraîchir le Match Center si l'onglet Live est ouvert
    const liveTab = document.querySelector('#mcTabs button[data-tab="live"].active');
    if (liveTab && currentMatch) loadTab('live', currentMatch);
    if (currentView === 'live') nav('live');
  });
  es.onerror = () => { $('#liveIndicator').classList.remove('on'); };
} catch { /* SSE non supporté */ }

nav('home');

/* ---------------- EXPERT DU JOUR / COMBINÉ SAFE / SUIVI & BILAN ---------------- */

function legRow(l) {
  const res = l.result === 'WIN' ? '<span class="pick-pill win">✅ validé</span>'
    : l.result === 'LOSS' ? '<span class="pick-pill loss">❌ non validé</span>'
    : l.result === 'VOID' ? '<span class="pick-pill">⚪ annulé</span>'
    : '<span class="pick-pill">⏳ en cours</span>';
  return `<div class="match-row" onclick="openFixture(${l.fixture_id})">
    <div class="team"><span>${esc(l.home_name)} vs ${esc(l.away_name)}</span></div>
    <div class="match-mid"><div class="score">${(l.adjusted_probability * 100).toFixed(0)}%</div>
      <div class="time">${fmtDate(l.kickoff_utc)}</div></div>
    <div class="match-meta">
      <span class="pick-pill">🎯 ${esc(l.market)}/${esc(l.selection)}</span>
      ${l.odds ? `<span>cote ${l.odds}${l.decision === 'ANALYSIS PICK' ? ' <small style="color:var(--muted)">(estimée modèle)</small>' : ''}</span>` : ''}
      ${l.relaxed ? '<span class="pill" title="Aucun candidat n\u2019atteint le seuil expert de 62 % aujourd\u2019hui">meilleure dispo du jour</span>' : ''}
      ${l.result === 'PENDING' && l.odds ? `<button class="fav-btn" onclick="event.stopPropagation();placeBet(${l.prediction_id},${l.fixture_id},${l.odds},'${esc(l.market)}/${esc(l.selection)}','${esc(l.home_name + ' vs ' + l.away_name).replace(/'/g, "\\'")}')">💰</button>` : ''}
      <span>${esc(l.comp_name)}</span>
      ${res}
    </div></div>`;
}

function selectionStatus(s) {
  return { OPEN: '🟢 Ouverte (se met à jour jusqu\u2019au 1er coup d\u2019envoi)',
    LOCKED: '🔒 Verrouillée — plus aucune modification (§34)',
    WON: '✅ GAGNÉE', LOST: '❌ PERDUE', VOID: '⚪ ANNULÉE' }[s.status] || s.status;
}

async function renderExpert() {
  const r = await api('/expert');
  const s = r.data;
  app.innerHTML = `<h2 class="section">🥇 PRONOSTIC EXPERT DU JOUR</h2>
    ${!s ? `<div class="info">${esc(r.note)}</div>` : `
    <div class="card">
      <b>${selectionStatus(s)}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${s.legs.length}</div><div class="l">pronostics retenus</div></div>
        <div class="prob-box"><div class="v">${(s.combined_probability * 100).toFixed(1)}%</div><div class="l">probabilité que TOUS passent</div></div>
        <div class="prob-box"><div class="v">${s.combined_odds}</div><div class="l">cote cumulée</div></div>
      </div>
      <div style="color:var(--muted);font-size:12px;margin-top:8px">${esc(r.note)}</div>
    </div>
    ${s.legs.map(legRow).join('')}`}`;
}

async function renderCombo() {
  const r = await api('/safe-combo');
  const s = r.data;
  app.innerHTML = `<h2 class="section">🛡️ COMBINÉ SAFE DU JOUR <span class="count">cote visée ≈ 3</span></h2>
    ${!s ? `<div class="info">${esc(r.note)}</div>` : `
    <div class="card">
      <b>${selectionStatus(s)}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${s.combined_odds}</div><div class="l">cote totale du combiné</div></div>
        <div class="prob-box"><div class="v">${(s.combined_probability * 100).toFixed(1)}%</div><div class="l">probabilité globale (MODEL ESTIMATE)</div></div>
        <div class="prob-box"><div class="v">${s.legs.length}</div><div class="l">matchs combinés</div></div>
      </div>
      <div style="color:var(--muted);font-size:12px;margin-top:8px">${esc(r.note)}</div>
    </div>
    ${s.legs.map(legRow).join('')}`}`;
}

async function renderTracking() {
  const [daily, weekly, lessons, reviews] = await Promise.all([
    api('/stats/daily'), api('/stats/weekly'), api('/lessons'), api('/reviews'),
  ]);
  const d = daily.data, w = weekly.data;
  const settledW = w.predictions.reduce((acc, x) => { acc[x.result] = x; return acc; }, {});
  const winW = settledW.WIN?.n || 0, lossW = settledW.LOSS?.n || 0;
  const selRow = (s, label) => s ? `<dt>${label}</dt><dd>${selectionStatus(s)} — ${s.legs.length} match(s), prob. ${(s.combined_probability * 100).toFixed(1)}%, cote ${s.combined_odds}</dd>` : `<dt>${label}</dt><dd>—</dd>`;
  app.innerHTML = `<h2 class="section">📋 SUIVI & BILAN DES PRONOSTICS</h2>
    <div class="card"><b>📅 Aujourd'hui (${esc(d.day)}) ${tagPill('CALCULATED DATA')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${d.counts.WIN}</div><div class="l">✅ validés</div></div>
        <div class="prob-box"><div class="v">${d.counts.LOSS}</div><div class="l">❌ non validés</div></div>
        <div class="prob-box"><div class="v">${d.counts.PENDING}</div><div class="l">⏳ en cours</div></div>
        <div class="prob-box"><div class="v">${d.win_rate != null ? (d.win_rate * 100).toFixed(0) + '%' : '—'}</div><div class="l">taux réel du jour</div></div>
      </div>
      <div class="kv" style="margin-top:10px">
        ${selRow(d.expert, '🥇 Expert du jour')}
        ${selRow(d.combo, '🛡️ Combiné Safe')}
      </div>
    </div>
    <div class="card"><b>🗓 Semaine du ${esc(w.from)} au ${esc(w.to)}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${winW}</div><div class="l">✅ validés</div></div>
        <div class="prob-box"><div class="v">${lossW}</div><div class="l">❌ non validés</div></div>
        <div class="prob-box"><div class="v">${winW + lossW ? ((winW / (winW + lossW)) * 100).toFixed(0) + '%' : '—'}</div><div class="l">taux réel</div></div>
        <div class="prob-box"><div class="v">${settledW.WIN || settledW.LOSS ? (((settledW.WIN?.units || 0) + (settledW.LOSS?.units || 0))).toFixed(1) : '—'}</div><div class="l">unités (mise 1 par prono)</div></div>
      </div>
      ${w.per_market.length ? `<table class="table" style="margin-top:10px"><tr><th>Marché</th><th>Résultat</th><th>Nombre</th></tr>
        ${w.per_market.map((x) => `<tr><td>${esc(x.market)}</td><td>${x.result === 'WIN' ? '✅' : '❌'}</td><td>${x.n}</td></tr>`).join('')}</table>` : ''}
    </div>
    <div class="card"><b>🧠 Leçons du modèle ${tagPill('CALCULATED DATA')}</b>
      <div style="color:var(--muted);font-size:12px;margin:6px 0">${esc(lessons.note)}</div>
      ${lessons.data.length ? lessons.data.map((l) => `<div class="ev" style="margin-top:6px"><b>${esc(l.scope)}</b> — ${esc(l.observation)}<br><small style="color:var(--muted)">Échantillon : ${l.sample_size} · Action : ${esc(l.adjustment)}</small></div>`).join('')
        : '<div class="info">Pas encore assez de pronostics réglés pour tirer des leçons — elles apparaîtront automatiquement.</div>'}
    </div>
    <h2 class="section">📝 Derniers comptes rendus post-match</h2>
    ${reviews.data.length ? reviews.data.map((r) => `<div class="match-row" onclick="openFixture(${r.fixture_id})">
      <div class="team"><span>${esc(r.home_name)} ${r.home_score}-${r.away_score} ${esc(r.away_name)}</span></div>
      <div class="match-meta">
        <span class="pick-pill ${r.verdict === 'VALIDATED' ? 'win' : r.verdict === 'NOT_VALIDATED' ? 'loss' : ''}">${r.verdict === 'VALIDATED' ? '✅ validé' : r.verdict === 'NOT_VALIDATED' ? '❌ non validé' : r.verdict}</span>
        <span>${esc(r.comp_name)}</span><span>${fmtDate(r.kickoff_utc)}</span>
      </div></div>`).join('') : '<div class="info">Aucun compte rendu encore — générés automatiquement après chaque match pronostiqué.</div>'}`;
}

/* ---------------- 💎 PRONOS D'OR (v3.4) ---------------- */

const starsHtml = (n) => '<span class="stars">' + '★'.repeat(n) + '☆'.repeat(5 - n) + '</span>';

async function renderGolden() {
  const r = await api('/golden-picks');
  const picks = r.data || [];
  app.innerHTML = `<h2 class="section">💎 PRONOS D'OR <span class="count">les paris les plus sûrs des 48 h</span></h2>
    <div class="info" style="margin-bottom:12px">Classés par probabilité calibrée du modèle (MODEL ESTIMATE). La fiabilité = taux de réussite <b>réel</b> du marché sur les pronostics déjà réglés (CALCULATED DATA).</div>
    ${!picks.length ? `<div class="info">${esc(r.note)}</div>`
    : picks.map((p) => `<div class="card gold-card" onclick="openFixture(${p.fixture_id})" style="cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-weight:700">${badge(p.home_badge, p.home_name)} ${esc(p.home_name)} vs ${esc(p.away_name)} ${badge(p.away_badge, p.away_name)}</div>
          <div style="color:var(--muted);font-size:12px;margin-top:2px">${esc(p.comp_name)} · ${fmtDate(p.kickoff_utc)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800">${(p.probability * 100).toFixed(1)}%</div>
          ${starsHtml(p.stars)}
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
        <span class="pick-pill">🎯 ${esc(p.label)}</span>
        <span>
          ${p.odds ? `cote ${p.odds}${p.decision === 'ANALYSIS PICK' ? ' <small style="color:var(--muted)">(estimée)</small>' : ''}` : ''}
          ${p.reliability != null ? ` · fiabilité marché <b>${(p.reliability * 100).toFixed(0)}%</b>` : ' · fiabilité : historique en construction'}
          <button class="fav-btn" onclick="event.stopPropagation();placeBet(${p.prediction_id},${p.fixture_id},${p.odds || 'null'},'${esc(p.label).replace(/'/g, "\\'")}','${esc(p.home_name + ' vs ' + p.away_name).replace(/'/g, "\\'")}')">💰 Miser (virtuel)</button>
        </span>
      </div></div>`).join('')}`;
}

/* ---------------- 📊 TRANSPARENCE (v3.4) ---------------- */

const MARKET_FR = { '1X2': '1N2', 'OU2.5': '+/-2,5 buts', BTTS: 'Les 2 marquent', DC: 'Double chance' };
const mktFr = (m) => MARKET_FR[m] || (m.startsWith('AH') ? 'Handicap ' + m.slice(2).replace('.', ',') : m);
const roiClass = (v) => v == null ? '' : v >= 0 ? 'style="color:var(--ok,#2ecc71);font-weight:700"' : 'style="color:var(--loss,#e74c3c);font-weight:700"';
const pctOr = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';

async function renderTransparency() {
  const r = await api('/transparency');
  const t = r.data, g = t.global;
  const perfTable = (rows, nameKey, nameFn) => `<table class="table"><thead><tr><th>${nameKey}</th><th>Réglés</th><th>Réussite</th><th>ROI/pari (1 u.)</th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${nameFn(x)}</td><td>${x.n}</td><td>${pctOr(x.win_rate)}</td><td ${roiClass(x.roi)}>${x.roi == null ? '—' : (x.roi >= 0 ? '+' : '') + (x.roi * 100).toFixed(1) + '%'}</td></tr>`).join('')}
    </tbody></table>`;
  app.innerHTML = `<h2 class="section">📊 TRANSPARENCE TOTALE <span class="count">résultats réels, rien d'autre</span></h2>
    <div class="info" style="margin-bottom:12px">${esc(t.method)}</div>
    <div class="card"><b>Performance globale ${tagPill('CALCULATED DATA')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${g.n || 0}</div><div class="l">pronostics réglés</div></div>
        <div class="prob-box"><div class="v">${pctOr(g.win_rate)}</div><div class="l">taux de réussite réel</div></div>
        <div class="prob-box"><div class="v" ${roiClass(g.roi)}>${g.roi == null ? '—' : (g.roi >= 0 ? '+' : '') + (g.roi * 100).toFixed(1) + '%'}</div><div class="l">ROI simulé par pari</div></div>
      </div>
      ${!g.n ? '<div class="info" style="margin-top:8px">Aucun pronostic réglé pour l\u2019instant — les chiffres apparaîtront dès les premiers matchs terminés. État honnête : jamais de statistiques fictives.</div>' : ''}
    </div>
    ${t.daily_last14.length ? `<div class="card"><b>14 derniers jours</b>
      <div style="display:flex;gap:4px;align-items:flex-end;height:90px;margin-top:12px">
        ${t.daily_last14.map((d) => { const tot = d.wins + d.losses || 1; return `<div style="flex:1;text-align:center" title="${d.day} : ${d.wins}✅ ${d.losses}❌">
          <div style="display:flex;flex-direction:column-reverse;height:64px;gap:1px">
            <div style="height:${(d.wins / tot * 100).toFixed(0)}%;background:var(--ok,#2ecc71);border-radius:2px"></div>
            <div style="height:${(d.losses / tot * 100).toFixed(0)}%;background:var(--loss,#e74c3c);border-radius:2px;opacity:.7"></div>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-top:4px">${d.day.slice(5)}</div></div>`; }).join('')}
      </div></div>` : ''}
    ${t.by_market.length ? `<div class="card"><b>Par marché</b>${perfTable(t.by_market, 'Marché', (x) => mktFr(x.market))}</div>` : ''}
    ${t.by_competition.length ? `<div class="card"><b>Par compétition</b>${perfTable(t.by_competition, 'Compétition', (x) => esc(x.name))}</div>` : ''}
    ${t.by_decision.length ? `<div class="card"><b>Par type de décision</b>${perfTable(t.by_decision, 'Décision', (x) => x.decision === 'VALUE BET' ? '💎 Value Bet' : x.decision === 'ANALYSIS PICK' ? '🔍 Pronostic d\u2019analyse' : '🎯 Pick')}</div>` : ''}
    ${t.calibration.length ? `<div class="card"><b>Calibration : probabilité annoncée vs réalité</b>
      <table class="table"><thead><tr><th>Tranche annoncée</th><th>n</th><th>Prévu</th><th>Réel</th><th>Écart</th></tr></thead><tbody>
      ${t.calibration.map((c) => `<tr><td>${c.bucket}</td><td>${c.n}</td><td>${pctOr(c.predicted)}</td><td>${pctOr(c.actual)}</td><td ${roiClass(c.gap)}>${(c.gap >= 0 ? '+' : '') + (c.gap * 100).toFixed(1)} pts</td></tr>`).join('')}
      </tbody></table>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">Un modèle honnête a des écarts proches de 0 : c'est exactement ce que la calibration automatique corrige chaque jour.</div></div>` : ''}`;
}

/* ---------------- 💰 BANKROLL VIRTUELLE (v3.4) ---------------- */

const BK_KEY = 'ps_bankroll_v1';
const bkLoad = () => { try { return JSON.parse(localStorage.getItem(BK_KEY)) || { start: 1000, balance: 1000, bets: [] }; } catch { return { start: 1000, balance: 1000, bets: [] }; } };
const bkSave = (b) => localStorage.setItem(BK_KEY, JSON.stringify(b));

window.placeBet = (predictionId, fixtureId, odds, label, match) => {
  if (!odds) { alert('Pas de cote disponible pour ce pronostic.'); return; }
  const bk = bkLoad();
  if (bk.bets.some((b) => b.pid === predictionId)) { alert('Vous suivez déjà ce pronostic.'); return; }
  const stake = parseFloat(prompt(`Mise virtuelle sur :\n${match}\n${label} @ ${odds}\n\nSolde : ${bk.balance.toFixed(2)} unités. Montant ?`, '10'));
  if (!Number.isFinite(stake) || stake <= 0) return;
  if (stake > bk.balance) { alert('Solde virtuel insuffisant.'); return; }
  bk.balance -= stake;
  bk.bets.unshift({ pid: predictionId, fid: fixtureId, stake, odds, label, match, at: new Date().toISOString(), result: 'PENDING' });
  bkSave(bk);
  notifyUser('💰 Mise virtuelle enregistrée', `${stake} u. sur ${label} @ ${odds}`);
  alert(`✅ Mise enregistrée : ${stake} u. sur « ${label} » @ ${odds}\nSuivi automatique dans l'onglet 💰 Bankroll.`);
};

async function renderBankroll() {
  const bk = bkLoad();
  // règlement automatique : interroger les résultats réels des paris en attente
  const pending = bk.bets.filter((b) => b.result === 'PENDING').map((b) => b.pid);
  if (pending.length) {
    try {
      const st = await api('/predictions/status?ids=' + pending.join(','));
      for (const row of st.data) {
        const bet = bk.bets.find((b) => b.pid === row.id && b.result === 'PENDING');
        if (bet && row.result !== 'PENDING') {
          bet.result = row.result;
          if (row.result === 'WIN') bk.balance += bet.stake * bet.odds;
          else if (row.result === 'VOID') bk.balance += bet.stake;
          if (row.result === 'WIN') notifyUser('✅ Pari virtuel gagné !', `${bet.label} — +${(bet.stake * (bet.odds - 1)).toFixed(2)} u.`);
        }
      }
      bkSave(bk);
    } catch { /* hors ligne : réglé à la prochaine visite */ }
  }
  const settled = bk.bets.filter((b) => b.result !== 'PENDING' && b.result !== 'VOID');
  const wins = settled.filter((b) => b.result === 'WIN');
  const pnl = bk.balance - bk.start + bk.bets.filter((b) => b.result === 'PENDING').reduce((a, b) => a + b.stake, 0);
  app.innerHTML = `<h2 class="section">💰 BANKROLL VIRTUELLE <span class="count">aucun argent réel — simulation pédagogique</span></h2>
    <div class="card"><b>Mon suivi ${tagPill('CALCULATED DATA')}</b>
      <div class="prob-row" style="margin-top:10px">
        <div class="prob-box"><div class="v">${bk.balance.toFixed(2)}</div><div class="l">solde (départ ${bk.start})</div></div>
        <div class="prob-box"><div class="v" ${roiClass(pnl)}>${(pnl >= 0 ? '+' : '') + pnl.toFixed(2)}</div><div class="l">résultat net (u.)</div></div>
        <div class="prob-box"><div class="v">${settled.length ? (wins.length / settled.length * 100).toFixed(0) + '%' : '—'}</div><div class="l">réussite (${wins.length}/${settled.length})</div></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="fav-btn" onclick="nav('golden')">💎 Miser sur un Prono d'Or</button>
        <button class="fav-btn" onclick="if(confirm('Réinitialiser la bankroll virtuelle à 1000 u. ?')){localStorage.removeItem('${BK_KEY}');nav('bankroll')}">♻️ Réinitialiser</button>
      </div>
    </div>
    ${bk.bets.length ? bk.bets.map((b) => `<div class="match-row" onclick="openFixture(${b.fid})">
      <div class="team"><span>${esc(b.match)}</span></div>
      <div class="match-mid"><div class="score">${b.stake} u. @ ${b.odds}</div><div class="time">${fmtDate(b.at)}</div></div>
      <div class="match-meta">
        <span class="pick-pill">🎯 ${esc(b.label)}</span>
        ${b.result === 'WIN' ? `<span class="pick-pill win">✅ +${(b.stake * (b.odds - 1)).toFixed(2)} u.</span>`
        : b.result === 'LOSS' ? `<span class="pick-pill loss">❌ −${b.stake.toFixed(2)} u.</span>`
        : b.result === 'VOID' ? '<span class="pick-pill">⚪ remboursé</span>'
        : '<span class="pick-pill">⏳ en cours</span>'}
      </div></div>`).join('')
    : '<div class="info">Aucune mise virtuelle. Allez sur 💎 Pronos d\u2019Or ou une fiche match et cliquez « 💰 Miser (virtuel) » — 1000 unités fictives pour tester la stratégie sans risque.</div>'}`;
}

/* ---------------- 🔔 NOTIFICATIONS (v3.4) ---------------- */

function notifyUser(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
    }
  } catch { /* non supporté */ }
}

(() => {
  const btn = document.getElementById('notifBtn');
  if (!btn || !('Notification' in window)) { btn && (btn.style.display = 'none'); return; }
  const paint = () => { btn.textContent = Notification.permission === 'granted' ? '🔔' : '🔕'; btn.title = Notification.permission === 'granted' ? 'Notifications activées' : 'Activer les notifications'; };
  paint();
  btn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') { notifyUser('🔔 Notifications actives', 'Vous serez averti : sélections du jour, comptes rendus, paris gagnés.'); return; }
    await Notification.requestPermission();
    paint();
    if (Notification.permission === 'granted') notifyUser('🔔 Notifications activées', 'Expert du jour, comptes rendus post-match et paris virtuels gagnés.');
  });
})();
