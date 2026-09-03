import db from '../db.js';
import { pushToCloud } from '../cloud_sync.js';

export function sameRealMatch(p1, p2) {
    if (!p1 || !p2) return false;
    return p1.fixture_id === p2.fixture_id;
}

export function getCalibrationShrink() {
    const row = db.prepare(`SELECT calibration_json FROM model_versions ORDER BY trained_at DESC LIMIT 1`).get();
    if (!row || !row.calibration_json) return 0.95;
    try {
        const cal = JSON.parse(row.calibration_json);
        return cal.brierScore ? (1 - cal.brierScore) : 0.95;
    } catch(e) {
        return 0.95;
    }
}

export async function generateDailySelections(dateStr) {
    console.log(`[DAILY] Génération des sélections (Expert/Combiné) pour ${dateStr}...`);
    
    // Stub for daily selection logic
    const existing = db.prepare(`SELECT * FROM daily_selections WHERE date = ?`).all(dateStr);
    if (existing.length > 0) return; // Already generated

    const preds = db.prepare(`
        SELECT p.*, f.home_team_id, f.away_team_id 
        FROM predictions p
        JOIN fixtures f ON p.fixture_id = f.id
        WHERE date(f.date) = ?
        ORDER BY p.probability DESC
        LIMIT 5
    `).all(dateStr);

    if (preds.length >= 3) {
        const comboPreds = preds.slice(0, 3);
        const comboOdds = comboPreds.reduce((acc, p) => acc * (p.odds || 1.1), 1);
        
        const selectionData = {
            id: `expert_${dateStr}`,
            date: dateStr,
            selection_type: 'EXPERT',
            fixtures_json: JSON.stringify(comboPreds.map(p => p.fixture_id)),
            total_odds: comboOdds,
            created_at: new Date().toISOString()
        };
        
        db.prepare(`
            INSERT INTO daily_selections (id, date, selection_type, fixtures_json, total_odds, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(selectionData.id, selectionData.date, selectionData.selection_type, selectionData.fixtures_json, selectionData.total_odds, selectionData.created_at);
        
        await pushToCloud('daily_selections', selectionData);
        console.log(`[DAILY] Sélection Expert créée pour ${dateStr}`);
    }
}
