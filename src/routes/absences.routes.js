const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

const ABSENCE_SELECT = `
  SELECT a.*,
         s.nom AS student_nom, s.prenom AS student_prenom,
         c.nom AS classe_nom,
         sub.nom AS subject_nom,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM absences a
  JOIN students s ON s.id = a.student_id
  JOIN classes c ON c.id = a.classe_id
  LEFT JOIN subjects sub ON sub.id = a.subject_id
  LEFT JOIN users u ON u.id = a.teacher_id
`;

// GET /api/absences  — filters: student_id, classe_id, date_from, date_to, justified
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { student_id, classe_id, date_from, date_to, justified } = req.query;

    let sql = ABSENCE_SELECT;
    const params = [];
    const conditions = [];

    if (req.user.role === 'parent') {
      // Scope by child student IDs — no school_id dependency needed
      const childResult = await query(
        'SELECT id FROM students WHERE parent_id = $1',
        [req.user.id]
      );
      const childIds = childResult.rows.map((r) => r.id);
      if (childIds.length === 0) return res.json({ success: true, data: [] });
      params.push(childIds);
      conditions.push(`a.student_id = ANY($${params.length})`);
    } else {
      // Scope by school_id (superAdmin exempt)
      if (req.user.role !== 'superAdmin') {
        params.push(req.user.school_id);
        conditions.push(`a.school_id = $${params.length}`);
      }
      if (req.user.role === 'teacher') {
        params.push(req.user.id);
        conditions.push(`a.teacher_id = $${params.length}`);
      }
    }

    if (student_id) { params.push(student_id); conditions.push(`a.student_id = $${params.length}`); }
    if (classe_id)  { params.push(classe_id);  conditions.push(`a.classe_id = $${params.length}`); }
    if (date_from)  { params.push(date_from);  conditions.push(`a.date >= $${params.length}`); }
    if (date_to)    { params.push(date_to);    conditions.push(`a.date <= $${params.length}`); }
    if (justified !== undefined && justified !== '') {
      params.push(justified === 'true');
      conditions.push(`a.justified = $${params.length}`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY a.date DESC, a.created_at DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/absences/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const absenceSql = req.user.role === 'superAdmin'
      ? `${ABSENCE_SELECT} WHERE a.id = $1`
      : `${ABSENCE_SELECT} WHERE a.id = $1 AND a.school_id = $2`;
    const absenceParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(absenceSql, absenceParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Absence not found' });
    }

    const absence = result.rows[0];
    if (req.user.role === 'parent') {
      const child = await query('SELECT id FROM students WHERE id = $1 AND parent_id = $2', [absence.student_id, req.user.id]);
      if (child.rows.length === 0) return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: absence });
  } catch (err) {
    next(err);
  }
});

// POST /api/absences  — teacher, admin+
router.post(
  '/',
  authenticate,
  authorize('teacher', 'admin', 'superAdmin'),
  [
    body('student_id').isInt().withMessage('student_id required'),
    body('classe_id').isInt().withMessage('classe_id required'),
    body('date').isDate().withMessage('Valid date required'),
    body('session').isIn(['matin', 'apres_midi']).withMessage('session must be matin or apres_midi'),
  ],
  async (req, res, next) => {
    const client = await getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { student_id, classe_id, subject_id, date, session, justified, justification_reason } = req.body;
      const teacher_id = req.user.role === 'teacher' ? req.user.id : (req.body.teacher_id || req.user.id);
      const school_id = req.user.school_id;

      await client.query('BEGIN');

      const absenceResult = await client.query(
        `INSERT INTO absences (school_id, student_id, classe_id, subject_id, teacher_id, date, session, justified, justification_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [school_id, student_id, classe_id, subject_id || null, teacher_id,
         date, session, justified || false, justification_reason || null]
      );

      const absence = absenceResult.rows[0];

      // Auto-notify parent
      const studentResult = await client.query(
        `SELECT s.nom, s.prenom, s.parent_id, sub.nom AS subject_nom
         FROM students s
         LEFT JOIN subjects sub ON sub.id = $2
         WHERE s.id = $1`,
        [student_id, subject_id || null]
      );

      if (studentResult.rows.length > 0) {
        const student = studentResult.rows[0];
        if (student.parent_id) {
          const sessionLabel = session === 'matin' ? 'matin' : 'après-midi';
          const subjectInfo = student.subject_nom ? ` en ${student.subject_nom}` : '';
          await client.query(
            `INSERT INTO notifications (user_id, title, message, type, data)
             VALUES ($1, $2, $3, 'absence', $4)`,
            [
              student.parent_id,
              'Absence signalée',
              `Votre enfant ${student.prenom} ${student.nom} était absent(e) le ${date} (${sessionLabel})${subjectInfo}`,
              JSON.stringify({ absence_id: absence.id, student_id, date, session }),
            ]
          );
          const tokens = await getTokensForUsers([student.parent_id]);
          await sendPush(tokens, `⚠️ Absence signalée`, `${student.prenom} ${student.nom} était absent(e) le ${date} (${sessionLabel})${subjectInfo}`, { type: 'absence', absence_id: String(absence.id) });
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ success: true, data: absence });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// PUT /api/absences/:id  — teacher (own), admin+
router.put('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM absences WHERE id = $1'
      : 'SELECT * FROM absences WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Absence not found' });
    }

    if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Cannot edit another teacher\'s absence record' });
    }

    const { date, session, subject_id, justified, justification_reason, justification_date } = req.body;

    const result = await query(
      `UPDATE absences SET
         date = COALESCE($1, date),
         session = COALESCE($2::session_type, session),
         subject_id = COALESCE($3, subject_id),
         justified = COALESCE($4, justified),
         justification_reason = COALESCE($5, justification_reason),
         justification_date = COALESCE($6, justification_date)
       WHERE id = $7 RETURNING *`,
      [date, session, subject_id, justified, justification_reason, justification_date, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/absences/:id/justify  — teacher, admin+
router.patch('/:id/justify', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { justification_reason } = req.body;

    if (!justification_reason) {
      return res.status(400).json({ success: false, message: 'Justification reason required' });
    }

    const justifySql = req.user.role === 'superAdmin'
      ? `UPDATE absences SET
           justified = TRUE,
           justification_reason = $1,
           justification_date = CURRENT_DATE
         WHERE id = $2 RETURNING *`
      : `UPDATE absences SET
           justified = TRUE,
           justification_reason = $1,
           justification_date = CURRENT_DATE
         WHERE id = $2 AND school_id = $3 RETURNING *`;
    const justifyParams = req.user.role === 'superAdmin'
      ? [justification_reason, id]
      : [justification_reason, id, req.user.school_id];

    const result = await query(justifySql, justifyParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Absence not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/absences/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM absences WHERE id = $1 RETURNING id'
      : 'DELETE FROM absences WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Absence not found' });
    }
    res.json({ success: true, data: { message: 'Absence deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
