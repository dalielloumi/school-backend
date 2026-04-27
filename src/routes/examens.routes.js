const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

const EXAMEN_SELECT = `
  SELECT en.*,
         s.nom AS student_nom, s.prenom AS student_prenom,
         s.classe_id,
         c.nom AS classe_nom
  FROM examens_nationaux en
  JOIN students s ON s.id = en.student_id
  LEFT JOIN classes c ON c.id = s.classe_id
`;

// GET /api/examens  — filters: student_id, type, statut, annee
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { student_id, type, statut, annee } = req.query;

    let sql = EXAMEN_SELECT;
    const params = [];
    const conditions = [];

    // Scope by school_id via students table (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`s.school_id = $${params.length}`);
    }

    if (req.user.role === 'parent') {
      const childResult = await query(
        'SELECT id FROM students WHERE parent_id = $1 AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      const childIds = childResult.rows.map((r) => r.id);
      if (childIds.length === 0) return res.json({ success: true, data: [] });
      params.push(childIds);
      conditions.push(`en.student_id = ANY($${params.length})`);
    }

    if (student_id) { params.push(student_id); conditions.push(`en.student_id = $${params.length}`); }
    if (type)       { params.push(type);       conditions.push(`en.type = $${params.length}::examen_type`); }
    if (statut)     { params.push(statut);     conditions.push(`en.statut = $${params.length}::examen_statut`); }
    if (annee)      { params.push(annee);      conditions.push(`en.annee = $${params.length}`); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY en.annee DESC, en.created_at DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/examens/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    // Scope via students.school_id join (superAdmin exempt)
    const examenSql = req.user.role === 'superAdmin'
      ? `${EXAMEN_SELECT} WHERE en.id = $1`
      : `${EXAMEN_SELECT} WHERE en.id = $1 AND s.school_id = $2`;
    const examenParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(examenSql, examenParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Examen not found' });
    }

    const examen = result.rows[0];
    if (req.user.role === 'parent') {
      const child = await query('SELECT id FROM students WHERE id = $1 AND parent_id = $2', [examen.student_id, req.user.id]);
      if (child.rows.length === 0) return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: examen });
  } catch (err) {
    next(err);
  }
});

// POST /api/examens  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('student_id').isInt().withMessage('student_id required'),
    body('type').isIn(['fin6eme', 'fin9eme', 'bac']).withMessage('Invalid type'),
    body('annee').isInt({ min: 2000 }).withMessage('Valid year required'),
    body('statut').optional().isIn(['inscrit', 'enCours', 'passe', 'echoue']).withMessage('Invalid statut'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { student_id, type, statut, annee, note, specialisation } = req.body;

      // Verify the student belongs to this school
      if (req.user.role !== 'superAdmin') {
        const studentCheck = await query(
          'SELECT id FROM students WHERE id = $1 AND school_id = $2',
          [student_id, req.user.school_id]
        );
        if (studentCheck.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Student not found in your school' });
        }
      }

      const result = await query(
        `INSERT INTO examens_nationaux (student_id, type, statut, annee, note, specialisation)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [student_id, type, statut || 'inscrit', annee, note || null, specialisation || null]
      );

      // Notify parent
      const studentInfo = await query(
        'SELECT nom, prenom, parent_id FROM students WHERE id = $1',
        [student_id]
      );
      if (studentInfo.rows.length > 0 && studentInfo.rows[0].parent_id) {
        const s = studentInfo.rows[0];
        const typeLabel = { fin6eme: '6ème', fin9eme: '9ème', bac: 'Baccalauréat' }[type] || type;
        await query(
          `INSERT INTO notifications (user_id, title, message, type, data) VALUES ($1,$2,$3,'exam',$4)`,
          [s.parent_id, `📋 Examen national`, `${s.prenom} ${s.nom} est inscrit(e) à l'examen ${typeLabel} ${annee}`, JSON.stringify({ examen_id: result.rows[0].id })]
        );
        const tokens = await getTokensForUsers([s.parent_id]);
        await sendPush(tokens, `📋 Examen national`, `${s.prenom} ${s.nom} est inscrit(e) à l'examen ${typeLabel} ${annee}`, { type: 'exam', examen_id: String(result.rows[0].id) });
      }

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/examens/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    // Scope via join to students.school_id (superAdmin exempt)
    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT en.id FROM examens_nationaux en WHERE en.id = $1'
      : `SELECT en.id FROM examens_nationaux en
         JOIN students s ON s.id = en.student_id
         WHERE en.id = $1 AND s.school_id = $2`;
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Examen not found' });
    }

    const { type, statut, annee, note, specialisation } = req.body;

    const result = await query(
      `UPDATE examens_nationaux SET
         type = COALESCE($1::examen_type, type),
         statut = COALESCE($2::examen_statut, statut),
         annee = COALESCE($3, annee),
         note = COALESCE($4, note),
         specialisation = COALESCE($5, specialisation)
       WHERE id = $6 RETURNING *`,
      [type, statut, annee, note, specialisation, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/examens/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    // Scope via join to students.school_id (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      const checkResult = await query(
        `SELECT en.id FROM examens_nationaux en
         JOIN students s ON s.id = en.student_id
         WHERE en.id = $1 AND s.school_id = $2`,
        [req.params.id, req.user.school_id]
      );
      if (checkResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Examen not found' });
      }
    }

    const result = await query('DELETE FROM examens_nationaux WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Examen not found' });
    }
    res.json({ success: true, data: { message: 'Examen deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
