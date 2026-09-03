import { db } from '../db.js';
import { pushToCloud } from '../cloud_sync.js';

export async function evaluatePredictions() {
    console.log("[REVIEWS] Évaluation des pronostics terminés...");
    
    // Find predictions for finished matches that are not yet reviewed
    const pending = db.prepare(`
        SELECT p.*, f.score_full_time_home as fh, f.score_full_time_away as fa
        FROM predictions p
        JOIN fixtures f ON p.fixture_id = f.id
        LEFT JOIN prediction_reviews pr ON p.id = pr.prediction_id
        WHERE f.status = 'FINISHED'
        AND pr.id IS NULL
    `).all();

    const insertReview = db.prepare(`
        INSERT INTO prediction_reviews (id, prediction_id, fixture_id, status, actual_result, brier_score, profit, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let evaluated = 0;
    for (const p of pending) {
        if (p.fh === null || p.fa === null) continue;
        
        let actualRes = 'X';
        if (p.fh > p.fa) actualRes = '1';
        if (p.fa > p.fh) actualRes = '2';

        const won = (p.prediction_value === actualRes);
        const status = won ? 'WON' : 'LOST';
        
        // Brier Score: (prob - outcome)^2
        const outcome = won ? 1 : 0;
        const brier = Math.pow(p.probability - outcome, 2);
        
        const profit = won ? (p.odds - 1) : -1;
        
        const reviewData = {
            id: `rev_${p.id}`,
            prediction_id: p.id,
            fixture_id: p.fixture_id,
            status,
            actual_result: actualRes,
            brier_score: brier,
            profit: profit,
            reviewed_at: new Date().toISOString()
        };

        insertReview.run(
            reviewData.id, reviewData.prediction_id, reviewData.fixture_id, 
            reviewData.status, reviewData.actual_result, reviewData.brier_score, 
            reviewData.profit, reviewData.reviewed_at
        );
        
        await pushToCloud('prediction_reviews', reviewData);
        evaluated++;
    }
    
    console.log(`[REVIEWS] ${evaluated} pronostics évalués et synchronisés.`);
}
