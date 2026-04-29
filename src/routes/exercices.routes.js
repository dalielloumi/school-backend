const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { sendPush, getParentTokensForClasse } = require('../utils/fcm');

const EXERCICE_SELECT = `
  SELECT ex.*,
         c.nom AS classe_nom, c.niveau AS classe_niveau,
         sub.nom AS subject_nom, sub.code AS subject_code, sub.color AS subject_color,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM exercices ex
  JOIN classes c ON c.id = ex.classe_id
  JOIN subjects sub ON sub.id = ex.subject_id
  JOIN users u ON u.id = ex.teacher_id
`;

async function notifyParents(schoolId, classeId, title, message, type = 'exercice', data = null) {
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

async function teacherHasClass(teacherId, classeId) {
  const r = await query(
    `SELECT 1 FROM teacher_classes WHERE teacher_id=$1 AND classe_id=$2
     UNION
     SELECT 1 FROM schedules WHERE teacher_id=$1 AND classe_id=$2 LIMIT 1`,
    [teacherId, classeId]
  );
  return r.rows.length > 0;
}

// GET /api/exercices
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { classe_id, teacher_id, subject_id } = req.query;
    let sql = EXERCICE_SELECT;
    const params = [];
    const conditions = [];

    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`ex.school_id = $${params.length}`);
    }
    if (req.user.role === 'teacher') {
      params.push(req.user.id);
      conditions.push(`ex.teacher_id = $${params.length}`);
    } else if (req.user.role === 'parent') {
      const childResult = await query(
        'SELECT classe_id FROM students WHERE parent_id = $1 AND classe_id IS NOT NULL AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      const classeIds = [...new Set(childResult.rows.map((r) => r.classe_id))];
      if (classeIds.length === 0) return res.json({ success: true, data: [] });
      params.push(classeIds);
      conditions.push(`ex.classe_id = ANY($${params.length})`);
    }
    if (classe_id && req.user.role !== 'parent') {
      params.push(classe_id); conditions.push(`ex.classe_id = $${params.length}`);
    }
    if (teacher_id && req.user.role !== 'teacher') {
      params.push(teacher_id); conditions.push(`ex.teacher_id = $${params.length}`);
    }
    if (subject_id) {
      params.push(subject_id); conditions.push(`ex.subject_id = $${params.length}`);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY ex.date_publication DESC';

    const result = await query(sql, params);
    const now = new Date();
    const data = result.rows.map((row) => ({
      ...row,
      is_overdue: row.date_limite ? new Date(row.date_limite) < now : false,
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// GET /api/exercices/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const sql = req.user.role === 'superAdmin'
      ? `${EXERCICE_SELECT} WHERE ex.id = $1`
      : `${EXERCICE_SELECT} WHERE ex.id = $1 AND ex.school_id = $2`;
    const params = req.user.role === 'superAdmin'
      ? [req.params.id] : [req.params.id, req.user.school_id];
    const result = await query(sql, params);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Exercice not found' });
    const row = result.rows[0];
    res.json({ success: true, data: { ...row, is_overdue: row.date_limite ? new Date(row.date_limite) < new Date() : false } });
  } catch (err) { next(err); }
});

// POST /api/exercices
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

      const { classe_id, subject_id, titre, description, date_limite, content_type } = req.body;
      const teacher_id = req.user.role === 'teacher' ? req.user.id : (req.body.teacher_id || req.user.id);
      const school_id = req.user.school_id;

      if (req.user.role === 'teacher') {
        const ok = await teacherHasClass(req.user.id, classe_id);
        if (!ok)
          return res.status(403).json({ success: false, message: 'Vous n\'êtes pas assigné à cette classe' });
      }

      const file_url = req.file
        ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
        : (req.body.file_url || null);

      const result = await query(
        `INSERT INTO exercices (school_id, teacher_id, classe_id, subject_id, titre, description, file_url, content_type, date_publication, date_limite)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9) RETURNING *`,
        [school_id, teacher_id, classe_id, subject_id, titre, description || null,
         file_url, content_type || (file_url ? 'file' : 'text'), date_limite || null]
      );

      // Notify parents (in-app + push)
      const classeInfo = await query('SELECT nom FROM classes WHERE id = $1', [classe_id]);
      const classeNom = classeInfo.rows[0]?.nom ?? '';
      await notifyParents(
        school_id, classe_id,
        `Nouveau devoir: ${titre}`,
        `Un nouveau devoir "${titre}" a été publié pour la classe ${classeNom}${date_limite ? '. À rendre avant le ' + new Date(date_limite).toLocaleDateString('fr-FR') : ''}.`,
        'exercice',
        { exercice_id: result.rows[0].id }
      );
      const fcmTokens = await getParentTokensForClasse(school_id, classe_id);
      await sendPush(fcmTokens, `📝 Nouveau devoir`, `"${titre}" pour la classe ${classeNom}${date_limite ? ' — avant le ' + new Date(date_limite).toLocaleDateString('fr-FR') : ''}`, { type: 'exercice', exercice_id: String(result.rows[0].id) });

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// PUT /api/exercices/:id
router.put('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const checkSql = req.user.role === 'superAdmin'
        ? 'SELECT * FROM exercices WHERE id = $1'
        : 'SELECT * FROM exercices WHERE id = $1 AND school_id = $2';
      const check = await query(checkSql,
        req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id]);
      if (check.rows.length === 0)
        return res.status(404).json({ success: false, message: 'Exercice not found' });
      if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id)
        return res.status(403).json({ success: false, message: 'Cannot edit another teacher\'s exercice' });

      const { titre, description, date_limite, classe_id, subject_id, content_type } = req.body;
      const file_url = req.file
        ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
        : (req.body.file_url || null);

      const result = await query(
        `UPDATE exercices SET
           titre = COALESCE($1, titre),
           description = COALESCE($2, description),
           file_url = COALESCE($3, file_url),
           content_type = COALESCE($4, content_type),
           date_limite = COALESCE($5, date_limite),
           classe_id = COALESCE($6, classe_id),
           subject_id = COALESCE($7, subject_id)
         WHERE id = $8 RETURNING *`,
        [titre, description, file_url, content_type, date_limite, classe_id, subject_id, id]
      );
      res.json({ success: true, data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// DELETE /api/exercices/:id
router.delete('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM exercices WHERE id = $1'
      : 'SELECT * FROM exercices WHERE id = $1 AND school_id = $2';
    const check = await query(checkSql,
      req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id]);
    if (check.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Exercice not found' });
    if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Cannot delete another teacher\'s exercice' });
    await query('DELETE FROM exercices WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Exercice deleted', id: parseInt(id) } });
  } catch (err) { next(err); }
});

module.exports = router;
