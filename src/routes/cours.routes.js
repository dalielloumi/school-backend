const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { sendPush, getParentTokensForClasse } = require('../utils/fcm');

const COURS_SELECT = `
  SELECT co.*,
         c.nom AS classe_nom, c.niveau AS classe_niveau,
         sub.nom AS subject_nom, sub.code AS subject_code, sub.color AS subject_color,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM cours co
  JOIN classes c ON c.id = co.classe_id
  JOIN subjects sub ON sub.id = co.subject_id
  JOIN users u ON u.id = co.teacher_id
`;

// Helper: notify all parents of students in a classe
async function notifyParents(schoolId, classeId, title, message, type = 'general', data = null) {
  const parents = await query(
    `SELECT DISTINCT s.parent_id FROM students s
     JOIN users u ON u.id = s.parent_id
     WHERE s.classe_id = $1 AND s.school_id = $2 AND s.parent_id IS NOT NULL AND u.role = 'parent'`,
    [classeId, schoolId]
  );
  for (const row of parents.rows) {
    await query(
      `INSERT INTO notifications (user_id, school_id, title, message, type, data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.parent_id, schoolId, title, message, type, data ? JSON.stringify(data) : null]
    );
  }
}

// Helper: check teacher is assigned to class (via teacher_classes OR schedules)
async function teacherHasClass(teacherId, classeId) {
  const r = await query(
    `SELECT 1 FROM teacher_classes WHERE teacher_id=$1 AND classe_id=$2
     UNION
     SELECT 1 FROM schedules WHERE teacher_id=$1 AND classe_id=$2 LIMIT 1`,
    [teacherId, classeId]
  );
  return r.rows.length > 0;
}

// GET /api/cours
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { classe_id, teacher_id, subject_id } = req.query;
    let sql = COURS_SELECT;
    const params = [];
    const conditions = [];

    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`co.school_id = $${params.length}`);
    }
    if (req.user.role === 'teacher') {
      params.push(req.user.id);
      conditions.push(`co.teacher_id = $${params.length}`);
    } else if (req.user.role === 'parent') {
      const childResult = await query(
        'SELECT classe_id FROM students WHERE parent_id = $1 AND classe_id IS NOT NULL AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      const classeIds = [...new Set(childResult.rows.map((r) => r.classe_id))];
      if (classeIds.length === 0) return res.json({ success: true, data: [] });
      params.push(classeIds);
      conditions.push(`co.classe_id = ANY($${params.length})`);
    }
    if (classe_id && req.user.role !== 'parent') {
      params.push(classe_id); conditions.push(`co.classe_id = $${params.length}`);
    }
    if (teacher_id && req.user.role !== 'teacher') {
      params.push(teacher_id); conditions.push(`co.teacher_id = $${params.length}`);
    }
    if (subject_id) {
      params.push(subject_id); conditions.push(`co.subject_id = $${params.length}`);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY co.date_publication DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/cours/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const sql = req.user.role === 'superAdmin'
      ? `${COURS_SELECT} WHERE co.id = $1`
      : `${COURS_SELECT} WHERE co.id = $1 AND co.school_id = $2`;
    const params = req.user.role === 'superAdmin'
      ? [req.params.id] : [req.params.id, req.user.school_id];
    const result = await query(sql, params);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Cours not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/cours — supports multipart (file) or JSON
router.post('/',
  authenticate,
  authorize('teacher', 'admin', 'superAdmin'),
  upload.single('file'),
  [
    body('classe_id').isInt().withMessage('classe_id required'),
    body('subject_id').isInt().withMessage('subject_id required'),
    body('titre').notEmpty().withMessage('Titre required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ success: false, message: errors.array()[0].msg });

      const { classe_id, subject_id, titre, description, content_type } = req.body;
      const teacher_id = req.user.role === 'teacher' ? req.user.id : (req.body.teacher_id || req.user.id);
      const school_id = req.user.school_id;

      if (req.user.role === 'teacher') {
        const ok = await teacherHasClass(req.user.id, classe_id);
        if (!ok)
          return res.status(403).json({ success: false, message: 'Vous n\'êtes pas assigné à cette classe' });
      }

      // Build file_url if file was uploaded
      const file_url = req.file
        ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
        : (req.body.file_url || null);

      const result = await query(
        `INSERT INTO cours (school_id, teacher_id, classe_id, subject_id, titre, description, file_url, content_type, date_publication)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
        [school_id, teacher_id, classe_id, subject_id, titre, description || null,
         file_url, content_type || (file_url ? 'file' : 'text')]
      );

      // Notify parents (in-app + push)
      const classeInfo = await query('SELECT nom FROM classes WHERE id = $1', [classe_id]);
      const classeNom = classeInfo.rows[0]?.nom ?? '';
      await notifyParents(
        school_id, classe_id,
        `Nouveau cours: ${titre}`,
        `Un nouveau cours "${titre}" a été publié pour la classe ${classeNom}.`,
        'general',
        { cours_id: result.rows[0].id }
      );
      const fcmTokens = await getParentTokensForClasse(school_id, classe_id);
      await sendPush(fcmTokens, `📚 Nouveau cours`, `"${titre}" publié pour la classe ${classeNom}`, { type: 'cours', cours_id: String(result.rows[0].id) });

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// PUT /api/cours/:id
router.put('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const checkSql = req.user.role === 'superAdmin'
        ? 'SELECT * FROM cours WHERE id = $1'
        : 'SELECT * FROM cours WHERE id = $1 AND school_id = $2';
      const check = await query(checkSql,
        req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id]);
      if (check.rows.length === 0)
        return res.status(404).json({ success: false, message: 'Cours not found' });
      if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id)
        return res.status(403).json({ success: false, message: 'Cannot edit another teacher\'s cours' });

      const { titre, description, classe_id, subject_id, content_type } = req.body;
      const file_url = req.file
        ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
        : (req.body.file_url || null);

      const result = await query(
        `UPDATE cours SET
           titre = COALESCE($1, titre),
           description = COALESCE($2, description),
           file_url = COALESCE($3, file_url),
           content_type = COALESCE($4, content_type),
           classe_id = COALESCE($5, classe_id),
           subject_id = COALESCE($6, subject_id)
         WHERE id = $7 RETURNING *`,
        [titre, description, file_url, content_type, classe_id, subject_id, id]
      );
      res.json({ success: true, data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// DELETE /api/cours/:id
router.delete('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM cours WHERE id = $1'
      : 'SELECT * FROM cours WHERE id = $1 AND school_id = $2';
    const check = await query(checkSql,
      req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id]);
    if (check.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Cours not found' });
    if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Cannot delete another teacher\'s cours' });
    await query('DELETE FROM cours WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Cours deleted', id: parseInt(id) } });
  } catch (err) { next(err); }
});

module.exports = router;
