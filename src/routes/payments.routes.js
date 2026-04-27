const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const PAYMENT_SELECT = `
  SELECT p.*,
         s.nom AS student_nom, s.prenom AS student_prenom,
         c.nom AS classe_nom,
         u.nom AS parent_nom, u.prenom AS parent_prenom
  FROM payments p
  JOIN students s ON s.id = p.student_id
  JOIN classes c ON c.id = p.classe_id
  LEFT JOIN users u ON u.id = p.parent_id
`;

// GET /api/payments  — filters: student_id, classe_id, statut, annee, mois
router.get('/', authenticate, async (req, res, next) => {
  try {
    // Auto-refresh late payments scoped to this school
    if (req.user.role !== 'superAdmin') {
      await query(
        "UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE AND school_id = $1",
        [req.user.school_id]
      );
    } else {
      await query("UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE");
    }

    const { student_id, classe_id, statut, annee, mois } = req.query;

    let sql = PAYMENT_SELECT;
    const params = [];
    const conditions = [];

    // Scope by school_id (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`p.school_id = $${params.length}`);
    }

    if (req.user.role === 'parent') {
      params.push(req.user.id);
      conditions.push(`p.parent_id = $${params.length}`);
    }

    if (student_id) { params.push(student_id); conditions.push(`p.student_id = $${params.length}`); }
    if (classe_id)  { params.push(classe_id);  conditions.push(`p.classe_id = $${params.length}`); }
    if (statut)     { params.push(statut);     conditions.push(`p.statut = $${params.length}::payment_statut`); }
    if (annee)      { params.push(annee);      conditions.push(`p.annee = $${params.length}`); }
    if (mois)       { params.push(mois);       conditions.push(`p.mois = $${params.length}`); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY p.date_echeance DESC, p.created_at DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/late  — all payments past due and not paid
router.get('/late', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'superAdmin') {
      await query(
        "UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE AND school_id = $1",
        [req.user.school_id]
      );
    } else {
      await query("UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE");
    }

    const lateSql = req.user.role === 'superAdmin'
      ? `${PAYMENT_SELECT}
         WHERE p.statut = 'enRetard'
         ORDER BY p.date_echeance ASC`
      : `${PAYMENT_SELECT}
         WHERE p.statut = 'enRetard' AND p.school_id = $1
         ORDER BY p.date_echeance ASC`;
    const lateParams = req.user.role === 'superAdmin' ? [] : [req.user.school_id];

    const result = await query(lateSql, lateParams);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const paymentSql = req.user.role === 'superAdmin'
      ? `${PAYMENT_SELECT} WHERE p.id = $1`
      : `${PAYMENT_SELECT} WHERE p.id = $1 AND p.school_id = $2`;
    const paymentParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(paymentSql, paymentParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const payment = result.rows[0];

    if (req.user.role === 'parent' && payment.parent_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('student_id').isInt().withMessage('student_id required'),
    body('classe_id').isInt().withMessage('classe_id required'),
    body('montant').isFloat({ min: 0 }).withMessage('Valid montant required'),
    body('annee').isInt({ min: 2000 }).withMessage('Valid year required'),
    body('date_echeance').isDate().withMessage('Valid date_echeance required'),
    body('frequence').isIn(['mensuelle', 'trimestrielle', 'annuelle']).withMessage('Invalid frequence'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const {
        student_id, classe_id, parent_id, montant, frequence, mode_paiement,
        mois, trimestre, annee, statut, date_echeance, date_paiement,
        numero_cheque, note,
      } = req.body;
      const school_id = req.user.school_id;

      const result = await query(
        `INSERT INTO payments
           (school_id, student_id, classe_id, parent_id, montant, frequence, mode_paiement, mois, trimestre, annee,
            statut, date_echeance, date_paiement, numero_cheque, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          school_id, student_id, classe_id, parent_id || null, montant,
          frequence, mode_paiement || null, mois || null, trimestre || null, annee,
          statut || 'enAttente', date_echeance, date_paiement || null,
          numero_cheque || null, note || null,
        ]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/payments/:id/pay  — mark as paid
router.patch('/:id/pay', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { id } = req.params;
    const { mode_paiement, numero_cheque, note } = req.body;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM payments WHERE id = $1'
      : 'SELECT * FROM payments WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await client.query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (check.rows[0].statut === 'paye') {
      return res.status(400).json({ success: false, message: 'Payment is already marked as paid' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE payments SET
         statut = 'paye',
         date_paiement = CURRENT_DATE,
         mode_paiement = COALESCE($1::payment_mode, mode_paiement),
         numero_cheque = COALESCE($2, numero_cheque),
         note = COALESCE($3, note)
       WHERE id = $4 RETURNING *`,
      [mode_paiement, numero_cheque, note, id]
    );

    const payment = result.rows[0];

    // Auto-notify parent
    if (payment.parent_id) {
      const studentResult = await client.query(
        'SELECT nom, prenom FROM students WHERE id = $1',
        [payment.student_id]
      );
      if (studentResult.rows.length > 0) {
        const student = studentResult.rows[0];
        const label = payment.mois
          ? `Mois ${payment.mois}/${payment.annee}`
          : payment.trimestre
          ? `Trimestre ${payment.trimestre} ${payment.annee}`
          : `Année ${payment.annee}`;
        await client.query(
          `INSERT INTO notifications (user_id, title, message, type, data)
           VALUES ($1, $2, $3, 'payment', $4)`,
          [
            payment.parent_id,
            'Paiement confirmé',
            `Le paiement de ${payment.montant} DT pour ${student.prenom} ${student.nom} (${label}) a été confirmé.`,
            JSON.stringify({ payment_id: payment.id, student_id: payment.student_id, montant: payment.montant }),
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, data: payment });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/payments/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT id FROM payments WHERE id = $1'
      : 'SELECT id FROM payments WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const {
      montant, frequence, mode_paiement, mois, trimestre, annee,
      statut, date_echeance, date_paiement, numero_cheque, note, parent_id,
    } = req.body;

    const result = await query(
      `UPDATE payments SET
         montant = COALESCE($1, montant),
         frequence = COALESCE($2::payment_frequence, frequence),
         mode_paiement = COALESCE($3::payment_mode, mode_paiement),
         mois = COALESCE($4, mois),
         trimestre = COALESCE($5, trimestre),
         annee = COALESCE($6, annee),
         statut = COALESCE($7::payment_statut, statut),
         date_echeance = COALESCE($8, date_echeance),
         date_paiement = COALESCE($9, date_paiement),
         numero_cheque = COALESCE($10, numero_cheque),
         note = COALESCE($11, note),
         parent_id = COALESCE($12, parent_id)
       WHERE id = $13 RETURNING *`,
      [montant, frequence, mode_paiement, mois, trimestre, annee, statut,
       date_echeance, date_paiement, numero_cheque, note, parent_id, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/payments/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM payments WHERE id = $1 RETURNING id'
      : 'DELETE FROM payments WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    res.json({ success: true, data: { message: 'Payment deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
