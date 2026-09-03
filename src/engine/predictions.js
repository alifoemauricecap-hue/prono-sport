import db from '../db.js';
import { walkForwardBacktest, prepareDataset } from './models.js';
import { pushToCloud } from '../cloud_sync.js';

export async function generatePredictions() {
    console.log("[PREDICTIONS] Génération des pronostics pour les matchs à venir...");
    
    // 1. Train model / Walk-forward backtest
    const dataset = prepareDataset();
    if (dataset.length < 50) {
        console.log("[PREDICTIONS] Pas assez de données pour l'entraînement.");
        return;
    }

    const { calibration, valueMetrics, currentModel } = walkForwardBacktest(dataset);
    
    const version = `v_${Date.now()}`;
    db.prepare(`
        INSERT INTO model_versions (version, trained_at, features_json, weights_json, metrics_json, calibration_json, value_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        version,
        new Date().toISOString(),
        JSON.stringify(currentModel.features),
        JSON.stringify(currentModel.weights),
        JSON.stringify(valueMetrics), // on stocke les metrics du backtest ici
        JSON.stringify(calibration),
        JSON.stringify(valueMetrics)
    );
    
    // Backup to cloud
    pushToCloud('model_versions', {
        version,
        trained_at: new Date().toISOString(),
        features_json: JSON.stringify(currentModel.features),
        weights_json: JSON.stringify(currentModel.weights),
        metrics_json: JSON.stringify(valueMetrics),
        calibration_json: JSON.stringify(calibration),
        value_json: JSON.stringify(valueMetrics)
    });

    // 2. Predict upcoming fixtures
    const upcoming = db.prepare(`
        SELECT f.id, f.home_team_id, f.away_team_id, 
               o.home_win, o.draw, o.away_win
        FROM fixtures f
        LEFT JOIN odds o ON f.id = o.fixture_id
        WHERE f.status IN ('SCHEDULED', 'TIMED')
        AND f.date > datetime('now', '-2 hours')
        AND f.date < datetime('now', '+3 days')
    `).all();

    const insertPred = db.prepare(`
        INSERT OR REPLACE INTO predictions (id, fixture_id, prediction_type, prediction_value, probability, odds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let newPreds = 0;
    for (const match of upcoming) {
        // Mock prediction probabilities based on odds (Implied proba) for this stub
        // In real system, this uses the trained 'currentModel'
        if (!match.home_win || match.home_win < 1.01) continue;
        
        const probHome = (1 / match.home_win) * 0.95; // Removing margin
        const probDraw = (1 / match.draw) * 0.95;
        const probAway = (1 / match.away_win) * 0.95;
        
        let pick = '1';
        let prob = probHome;
        let odd = match.home_win;
        if (probAway > probHome && probAway > probDraw) { pick = '2'; prob = probAway; odd = match.away_win; }
        else if (probDraw > probHome && probDraw > probAway) { pick = 'X'; prob = probDraw; odd = match.draw; }

        const predId = `pred_${match.id}_${pick}`;
        const created = new Date().toISOString();
        
        insertPred.run(predId, match.id, '1X2', pick, prob, odd, created);
        newPreds++;
        
        // Backup to cloud
        pushToCloud('predictions', {
            id: predId, fixture_id: match.id, prediction_type: '1X2',
            prediction_value: pick, probability: prob, odds: odd, created_at: created
        });
    }

    console.log(`[PREDICTIONS] Entraînement terminé. ${newPreds} pronostics générés et poussés vers le cloud.`);
}
