const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/finance/stats?year=2025&classe_id=3&frequence=mensuelle
router.get('/stats', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const schoolId  = req.user.school_id;
    const { year, classe_id, frequence } = req.query;

    const yearVal      = year      ? parseInt(year)      : null;
    const classeIdVal  = classe_id ? parseInt(classe_id) : null;
    const frequenceVal = frequence || null;

    // ── 1. Monthly revenue — last 12 months ─────────────────────────────
    const monthlyRes = await query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', date_echeance), 'YYYY-MM') AS mois,
        SUM(montant)                                             AS total,
        SUM(montant) FILTER (WHERE statut = 'paye')             AS percu,
        SUM(montant) FILTER (WHERE statut != 'paye')            AS en_attente,
        COUNT(*)                                                 AS nb_total,
        COUNT(*) FILTER (WHERE statut = 'paye')                 AS nb_payes
      FROM payments
      WHERE school_id = $1
        AND date_echeance >= NOW() - INTERVAL '12 months'
        AND ($2::int    IS NULL OR classe_id  = $2)
        AND ($3::text   IS NULL OR frequence  = $3)
        AND ($4::int    IS NULL OR EXTRACT(YEAR FROM date_echeance) = $4)
      GROUP BY 1
      ORDER BY 1
    `, [schoolId, classeIdVal, frequenceVal, yearVal]);

    // ── 2. Collection rate by class ──────────────────────────────────────
    const byClassRes = await query(`
      SELECT
        c.nom                                                         AS classe_nom,
        SUM(p.montant) FILTER (WHERE p.statut = 'paye')              AS percu,
        SUM(p.montant)                                                AS total,
        COUNT(*) FILTER (WHERE p.statut = 'paye')                    AS nb_payes,
        COUNT(*)                                                      AS nb_total,
        ROUND(
          COUNT(*) FILTER (WHERE p.statut = 'paye')::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )                                                             AS taux
      FROM payments p
      JOIN classes c ON c.id = p.classe_id
      WHERE p.school_id = $1
        AND ($2::int  IS NULL OR p.classe_id = $2)
        AND ($3::text IS NULL OR p.frequence = $3)
        AND ($4::int  IS NULL OR EXTRACT(YEAR FROM p.date_echeance) = $4)
      GROUP BY c.id, c.nom
      ORDER BY percu DESC NULLS LAST
      LIMIT 10
    `, [schoolId, classeIdVal, frequenceVal, yearVal]);

    // ── 3. Payment mode breakdown ────────────────────────────────────────
    const byModeRes = await query(`
      SELECT
        COALESCE(mode_paiement, 'non_renseigne') AS mode,
        COUNT(*)                                  AS count,
        SUM(montant)                              AS total
      FROM payments
      WHERE statut = 'paye' AND school_id = $1
        AND ($2::int  IS NULL OR classe_id = $2)
        AND ($3::text IS NULL OR frequence = $3)
        AND ($4::int  IS NULL OR EXTRACT(YEAR FROM date_echeance) = $4)
      GROUP BY 1
      ORDER BY total DESC
    `, [schoolId, classeIdVal, frequenceVal, yearVal]);

    // ── 4. Overdue aging analysis ────────────────────────────────────────
    const agingRes = await query(`
      SELECT
        CASE
          WHEN NOW() - date_echeance <= INTERVAL '30 days'  THEN '0-30j'
          WHEN NOW() - date_echeance <= INTERVAL '60 days'  THEN '31-60j'
          WHEN NOW() - date_echeance <= INTERVAL '90 days'  THEN '61-90j'
          ELSE '90j+'
        END                 AS tranche,
        COUNT(*)            AS nb,
        SUM(montant)        AS montant
      FROM payments
      WHERE statut != 'paye'
        AND date_echeance < NOW()
        AND school_id = $1
        AND ($2::int  IS NULL OR classe_id = $2)
        AND ($3::text IS NULL OR frequence = $3)
        AND ($4::int  IS NULL OR EXTRACT(YEAR FROM date_echeance) = $4)
      GROUP BY 1
      ORDER BY MIN(date_echeance)
    `, [schoolId, classeIdVal, frequenceVal, yearVal]);

    // ── 5. Global KPIs + growth vs previous month ───────────────────────
    const kpiRes = await query(`
      SELECT
        SUM(montant) FILTER (WHERE statut = 'paye')                              AS total_percu,
        SUM(montant) FILTER (WHERE statut != 'paye')                             AS total_en_attente,
        COUNT(*) FILTER (WHERE statut != 'paye' AND date_echeance < NOW())       AS nb_en_retard,
        SUM(montant) FILTER (WHERE statut != 'paye' AND date_echeance < NOW())   AS montant_en_retard,
        SUM(montant) FILTER (
          WHERE statut = 'paye'
          AND date_paiement >= DATE_TRUNC('month', NOW())
        )                                                                         AS percu_ce_mois,
        SUM(montant) FILTER (
          WHERE statut = 'paye'
          AND date_paiement >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
          AND date_paiement <  DATE_TRUNC('month', NOW())
        )                                                                         AS percu_mois_prec,
        ROUND(
          COUNT(*) FILTER (WHERE statut = 'paye')::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )                                                                         AS taux_global
      FROM payments
      WHERE school_id = $1
        AND ($2::int  IS NULL OR classe_id = $2)
        AND ($3::text IS NULL OR frequence = $3)
        AND ($4::int  IS NULL OR EXTRACT(YEAR FROM date_echeance) = $4)
    `, [schoolId, classeIdVal, frequenceVal, yearVal]);

    const kpi = kpiRes.rows[0];

    res.json({
      success: true,
      data: {
        kpi: {
          total_percu:      parseFloat(kpi.total_percu      || 0),
          total_en_attente: parseFloat(kpi.total_en_attente || 0),
          nb_en_retard:     parseInt(kpi.nb_en_retard       || 0),
          montant_en_retard:parseFloat(kpi.montant_en_retard|| 0),
          percu_ce_mois:    parseFloat(kpi.percu_ce_mois    || 0),
          percu_mois_prec:  parseFloat(kpi.percu_mois_prec  || 0),
          taux_global:      parseFloat(kpi.taux_global      || 0),
        },
        monthly:  monthlyRes.rows.map(r => ({
          mois:        r.mois,
          total:       parseFloat(r.total       || 0),
          percu:       parseFloat(r.percu       || 0),
          en_attente:  parseFloat(r.en_attente  || 0),
          nb_total:    parseInt(r.nb_total),
          nb_payes:    parseInt(r.nb_payes),
        })),
        by_class: byClassRes.rows.map(r => ({
          classe_nom: r.classe_nom,
          percu:      parseFloat(r.percu  || 0),
          total:      parseFloat(r.total  || 0),
          nb_payes:   parseInt(r.nb_payes),
          nb_total:   parseInt(r.nb_total),
          taux:       parseFloat(r.taux   || 0),
        })),
        by_mode: byModeRes.rows.map(r => ({
          mode:  r.mode,
          count: parseInt(r.count),
          total: parseFloat(r.total || 0),
        })),
        aging: agingRes.rows.map(r => ({
          tranche: r.tranche,
          nb:      parseInt(r.nb),
          montant: parseFloat(r.montant || 0),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
