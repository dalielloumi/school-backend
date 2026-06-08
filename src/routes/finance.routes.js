const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// Build a reusable WHERE clause for payment filters
function buildFilters(schoolId, classeId, frequence, year) {
  const params  = [schoolId];
  const clauses = ['p.school_id = $1'];

  if (classeId) {
    params.push(classeId);
    clauses.push(`p.classe_id = $${params.length}`);
  }
  if (frequence) {
    params.push(frequence);
    clauses.push(`p.frequence = $${params.length}`);
  }
  if (year) {
    params.push(year);
    clauses.push(`EXTRACT(YEAR FROM p.date_echeance) = $${params.length}`);
  }

  return { where: clauses.join(' AND '), params };
}

// GET /api/finance/stats?year=2025&classe_id=3&frequence=mensuelle
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    // Only admin (not superAdmin, not teacher/parent)
    if (!['admin', 'superAdmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    const schoolId   = req.user.school_id;
    const classeId   = req.query.classe_id ? parseInt(req.query.classe_id)  : null;
    const frequence  = req.query.frequence  || null;
    const year       = req.query.year       ? parseInt(req.query.year)       : null;

    const { where, params } = buildFilters(schoolId, classeId, frequence, year);

    // ── 1. Global KPIs + month-over-month growth ─────────────
    const kpiSql = `
      SELECT
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut = 'paye'), 0)                                    AS total_percu,
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut <> 'paye'), 0)                                   AS total_en_attente,
        COUNT(*)  FILTER (WHERE p.statut <> 'paye' AND p.date_echeance < NOW())                         AS nb_en_retard,
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut <> 'paye' AND p.date_echeance < NOW()), 0)       AS montant_en_retard,
        COALESCE(SUM(p.montant) FILTER (
          WHERE p.statut = 'paye'
            AND p.date_paiement >= DATE_TRUNC('month', NOW())
        ), 0)                                                                                            AS percu_ce_mois,
        COALESCE(SUM(p.montant) FILTER (
          WHERE p.statut = 'paye'
            AND p.date_paiement >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND p.date_paiement <  DATE_TRUNC('month', NOW())
        ), 0)                                                                                            AS percu_mois_prec,
        ROUND(
          COUNT(*) FILTER (WHERE p.statut = 'paye')::numeric / NULLIF(COUNT(*), 0) * 100, 1
        )                                                                                                AS taux_global
      FROM payments p
      WHERE ${where}
    `;

    // ── 2. Monthly revenue — last 12 months ──────────────────
    const monthlySql = `
      SELECT
        TO_CHAR(DATE_TRUNC('month', p.date_echeance), 'YYYY-MM')             AS mois,
        COALESCE(SUM(p.montant), 0)                                           AS total,
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut = 'paye'), 0)         AS percu,
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut <> 'paye'), 0)        AS en_attente,
        COUNT(*)                                                              AS nb_total,
        COUNT(*) FILTER (WHERE p.statut = 'paye')                            AS nb_payes
      FROM payments p
      WHERE ${where}
        AND p.date_echeance >= NOW() - INTERVAL '12 months'
      GROUP BY 1
      ORDER BY 1
    `;

    // ── 3. Collection rate by class ───────────────────────────
    const byClassSql = `
      SELECT
        c.nom                                                                 AS classe_nom,
        COALESCE(SUM(p.montant) FILTER (WHERE p.statut = 'paye'), 0)         AS percu,
        COALESCE(SUM(p.montant), 0)                                           AS total,
        COUNT(*) FILTER (WHERE p.statut = 'paye')                            AS nb_payes,
        COUNT(*)                                                              AS nb_total,
        ROUND(
          COUNT(*) FILTER (WHERE p.statut = 'paye')::numeric / NULLIF(COUNT(*), 0) * 100, 1
        )                                                                     AS taux
      FROM payments p
      JOIN classes c ON c.id = p.classe_id
      WHERE ${where}
      GROUP BY c.id, c.nom
      ORDER BY percu DESC
      LIMIT 10
    `;

    // ── 4. Payment mode breakdown (paid only) ─────────────────
    const byModeSql = `
      SELECT
        COALESCE(p.mode_paiement, 'non_renseigne')  AS mode,
        COUNT(*)                                     AS count,
        COALESCE(SUM(p.montant), 0)                 AS total
      FROM payments p
      WHERE ${where}
        AND p.statut = 'paye'
      GROUP BY 1
      ORDER BY total DESC
    `;

    // ── 5. Overdue aging ──────────────────────────────────────
    const agingSql = `
      SELECT
        CASE
          WHEN NOW() - p.date_echeance <= INTERVAL '30 days'  THEN '0-30j'
          WHEN NOW() - p.date_echeance <= INTERVAL '60 days'  THEN '31-60j'
          WHEN NOW() - p.date_echeance <= INTERVAL '90 days'  THEN '61-90j'
          ELSE '90j+'
        END                              AS tranche,
        COUNT(*)                         AS nb,
        COALESCE(SUM(p.montant), 0)     AS montant
      FROM payments p
      WHERE ${where}
        AND p.statut <> 'paye'
        AND p.date_echeance < NOW()
      GROUP BY 1
      ORDER BY MIN(p.date_echeance)
    `;

    // Run all queries in parallel
    const [kpiRes, monthlyRes, byClassRes, byModeRes, agingRes] = await Promise.all([
      query(kpiSql,     params),
      query(monthlySql, params),
      query(byClassSql, params),
      query(byModeSql,  params),
      query(agingSql,   params),
    ]);

    const kpi = kpiRes.rows[0];

    res.json({
      success: true,
      data: {
        kpi: {
          total_percu:       parseFloat(kpi.total_percu       || 0),
          total_en_attente:  parseFloat(kpi.total_en_attente  || 0),
          nb_en_retard:      parseInt  (kpi.nb_en_retard      || 0),
          montant_en_retard: parseFloat(kpi.montant_en_retard || 0),
          percu_ce_mois:     parseFloat(kpi.percu_ce_mois     || 0),
          percu_mois_prec:   parseFloat(kpi.percu_mois_prec   || 0),
          taux_global:       parseFloat(kpi.taux_global       || 0),
        },
        monthly: monthlyRes.rows.map(r => ({
          mois:       r.mois,
          total:      parseFloat(r.total      || 0),
          percu:      parseFloat(r.percu      || 0),
          en_attente: parseFloat(r.en_attente || 0),
          nb_total:   parseInt  (r.nb_total),
          nb_payes:   parseInt  (r.nb_payes),
        })),
        by_class: byClassRes.rows.map(r => ({
          classe_nom: r.classe_nom,
          percu:      parseFloat(r.percu    || 0),
          total:      parseFloat(r.total    || 0),
          nb_payes:   parseInt  (r.nb_payes),
          nb_total:   parseInt  (r.nb_total),
          taux:       parseFloat(r.taux     || 0),
        })),
        by_mode: byModeRes.rows.map(r => ({
          mode:  r.mode,
          count: parseInt  (r.count),
          total: parseFloat(r.total || 0),
        })),
        aging: agingRes.rows.map(r => ({
          tranche: r.tranche,
          nb:      parseInt  (r.nb),
          montant: parseFloat(r.montant || 0),
        })),
      },
    });
  } catch (err) {
    console.error('[Finance] Error:', err?.message || err);
    next(err);
  }
});

module.exports = router;
