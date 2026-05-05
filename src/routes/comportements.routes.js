const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

const COMP_SELECT = `
  SELECT c.*,
         s.nom AS student_nom, s.prenom AS student_prenom,
         cl.nom AS classe_nom,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM comportements c
  JOIN students s ON s.id = c.student_id
  JOIN classes cl ON cl.id = c.classe_id
  LEFT JOIN users u ON u.id = c.teacher_id
`;

// GET /api/comportements — filters: student_id, classe_id, date_from, date_to
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { student_id, classe_id, date_from, date_to } = req.query;

    let sql = COMP_SELECT;
    const params = [];
    const conditions = [];

    if (req.user.role === 'parent') {
      // Scope by child student IDs
      const childResult = await query(
        'SELECT id FROM students WHERE parent_id = $1',
        [req.user.id]
      );
      const childIds = childResult.rows.map((r) => r.id);
      console.log(`[comportements] parent=${req.user.id} childIds=${JSON.stringify(childIds)}`);
      if (childIds.length === 0) return res.json({ success: true, data: [] });
      params.push(childIds);
      conditions.push(`c.student_id = ANY($${params.length})`);
    } else {
      // Scope by school_id (superAdmin exempt)
      if (req.user.role !== 'superAdmin') {
        params.push(req.user.school_id);
        conditions.push(`c.school_id = $${params.length}`);
      }
      if (req.user.role === 'teacher') {
        params.push(req.user.id);
        conditions.push(`c.teacher_id = $${params.length}`);
      }
    }

    if (student_id) { params.push(student_id); conditions.push(`c.student_id = $${params.length}`); }
    if (classe_id)  { params.push(classe_id);  conditions.push(`c.classe_id = $${params.length}`); }
    if (date_from)  { params.push(date_from);  conditions.push(`c.date >= $${params.length}`); }
    if (date_to)    { params.push(date_to);    conditions.push(`c.date <= $${params.length}`); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY c.date DESC, c.created_at DESC';

    const result = await query(sql, params);
    console.log(`[comportements] returned ${result.rowCount} rows`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/comportements — teacher, admin, superAdmin
router.post(
  '/',
  authenticate,
  authorize('teacher', 'admin', 'superAdmin'),
  [
    body('student_id').isInt().withMessage('student_id required'),
    body('classe_id').isInt().withMessage('classe_id required'),
    body('titre').notEmpty().withMessage('titre required'),
    body('date').isDate().withMessage('Valid date required'),
    body('type').optional().isIn(['incident', 'avertissement', 'convocation', 'felicitation'])
      .withMessage('type must be incident, avertissement, convocation, or felicitation'),
  ],
  async (req, res, next) => {
    const client = await getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { student_id, classe_id, titre, description, date, type } = req.body;
      const teacher_id = req.user.role === 'teacher' ? req.user.id : (req.body.teacher_id || req.user.id);
      const school_id = req.user.school_id;

      await client.query('BEGIN');

      const compResult = await client.query(
        `INSERT INTO comportements (school_id, student_id, classe_id, teacher_id, titre, description, type, date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [school_id, student_id, classe_id, teacher_id, titre, description || null, type || 'incident', date]
      );

      const comp = compResult.rows[0];

      // Auto-notify parent
      const studentResult = await client.query(
        `SELECT s.nom, s.prenom, s.parent_id FROM students s WHERE s.id = $1`,
        [student_id]
      );

      if (studentResult.rows.length > 0) {
        const student = studentResult.rows[0];
        const { nom, prenom, parent_id } = student;
        if (parent_id) {
          await client.query(
            `INSERT INTO notifications (user_id, school_id, title, message, type, data)
             VALUES ($1, $2, $3, $4, 'general', $5)`,
            [
              parent_id,
              school_id,
              'ملاحظة سلوك',
              `Votre enfant ${prenom} ${nom} : ${titre}`,
              JSON.stringify({ comportement_id: comp.id, student_id, date }),
            ]
          );
          const tokens = await getTokensForUsers([parent_id]);
          await sendPush(
            tokens,
            `📋 سلوك - ${prenom} ${nom}`,
            titre,
            { type: 'comportement', comportement_id: String(comp.id) }
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ success: true, data: comp });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// DELETE /api/comportements/:id — admin, superAdmin
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM comportements WHERE id = $1 RETURNING id'
      : 'DELETE FROM comportements WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Comportement not found' });
    }
    res.json({ success: true, data: { message: 'Comportement deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
