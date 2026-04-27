const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/subjects
router.get('/', authenticate, async (req, res, next) => {
  try {
    let sql;
    let params = [];

    if (req.user.role === 'teacher') {
      sql = `
        SELECT s.* FROM subjects s
        JOIN teacher_subjects ts ON ts.subject_id = s.id
        WHERE ts.teacher_id = $1 AND s.school_id = $2
        ORDER BY s.nom
      `;
      params = [req.user.id, req.user.school_id];
    } else if (req.user.role === 'admin') {
      sql = 'SELECT * FROM subjects WHERE school_id = $1 ORDER BY nom';
      params = [req.user.school_id];
    } else if (req.user.role === 'parent') {
      sql = 'SELECT * FROM subjects WHERE school_id = $1 ORDER BY nom';
      params = [req.user.school_id];
    } else {
      // superAdmin sees all
      sql = 'SELECT * FROM subjects ORDER BY nom';
    }

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/subjects/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const subjectSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM subjects WHERE id = $1'
      : 'SELECT * FROM subjects WHERE id = $1 AND school_id = $2';
    const subjectParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(subjectSql, subjectParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/subjects  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('nom').notEmpty().withMessage('Subject name required'),
    body('code').optional(),
    body('coefficient').optional().isFloat({ min: 0.5 }).withMessage('Coefficient must be positive'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, description, coefficient, color } = req.body;
      const code = req.body.code || nom.substring(0, 3).toUpperCase();
      const school_id = req.user.school_id;

      const result = await query(
        `INSERT INTO subjects (school_id, nom, code, description, coefficient, color)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [school_id, nom, code.toUpperCase(), description || null, coefficient || 1, color || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/subjects/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { nom, code, description, coefficient, color } = req.body;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT id FROM subjects WHERE id = $1'
      : 'SELECT id FROM subjects WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }

    const result = await query(
      `UPDATE subjects SET
         nom = COALESCE($1, nom),
         code = COALESCE($2, code),
         description = COALESCE($3, description),
         coefficient = COALESCE($4, coefficient),
         color = COALESCE($5, color)
       WHERE id = $6 RETURNING *`,
      [nom, code ? code.toUpperCase() : null, description, coefficient, color, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/subjects/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM subjects WHERE id = $1 RETURNING id'
      : 'DELETE FROM subjects WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    res.json({ success: true, data: { message: 'Subject deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
