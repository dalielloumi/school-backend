const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/classes
router.get('/', authenticate, async (req, res, next) => {
  try {
    let sql;
    let params = [];

    if (req.user.role === 'teacher') {
      // Teachers see only their assigned classes, scoped by school
      sql = `
        SELECT c.* FROM classes c
        JOIN teacher_classes tc ON tc.classe_id = c.id
        WHERE tc.teacher_id = $1 AND c.school_id = $2
        ORDER BY c.nom
      `;
      params = [req.user.id, req.user.school_id];
    } else if (req.user.role === 'parent') {
      // Parents see class of their child, scoped by school
      sql = `
        SELECT DISTINCT c.* FROM classes c
        JOIN students s ON s.classe_id = c.id
        WHERE s.parent_id = $1 AND c.school_id = $2
        ORDER BY c.nom
      `;
      params = [req.user.id, req.user.school_id];
    } else if (req.user.role === 'admin') {
      sql = 'SELECT * FROM classes WHERE school_id = $1 ORDER BY nom';
      params = [req.user.school_id];
    } else {
      // superAdmin sees all
      sql = 'SELECT * FROM classes ORDER BY nom';
    }

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/classes/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Scope by school_id (superAdmin exempt)
    const classSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM classes WHERE id = $1'
      : 'SELECT * FROM classes WHERE id = $1 AND school_id = $2';
    const classParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const result = await query(classSql, classParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Class not found' });
    }

    // Fetch teachers of this class
    const teachersResult = await query(
      `SELECT u.id, u.nom, u.prenom, u.email FROM users u
       JOIN teacher_classes tc ON tc.teacher_id = u.id
       WHERE tc.classe_id = $1`,
      [id]
    );

    const data = { ...result.rows[0], teachers: teachersResult.rows };
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/classes  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('nom').notEmpty().withMessage('Class name required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, niveau, section, specialite } = req.body;
      const school_id = req.user.school_id;

      const result = await query(
        'INSERT INTO classes (school_id, nom, niveau, section, specialite) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [school_id, nom, niveau || null, section || null, specialite || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/classes/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { nom, niveau, section, specialite } = req.body;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT id FROM classes WHERE id = $1'
      : 'SELECT id FROM classes WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Class not found' });
    }

    const result = await query(
      `UPDATE classes SET
         nom       = COALESCE($1, nom),
         niveau    = COALESCE($2, niveau),
         section   = COALESCE($3, section),
         specialite = COALESCE($4, specialite)
       WHERE id = $5 RETURNING *`,
      [nom, niveau, section, specialite, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classes/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM classes WHERE id = $1 RETURNING id'
      : 'DELETE FROM classes WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Class not found' });
    }

    res.json({ success: true, data: { message: 'Class deleted', id: parseInt(id) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/classes/:id/students — students in class
router.get('/:id/students', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verify class belongs to this school first (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      const classCheck = await query('SELECT id FROM classes WHERE id = $1 AND school_id = $2', [id, req.user.school_id]);
      if (classCheck.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Class not found' });
      }
    }

    const result = await query(
      `SELECT s.*, u.nom AS parent_nom, u.prenom AS parent_prenom, u.phone AS parent_phone
       FROM students s
       LEFT JOIN users u ON u.id = s.parent_id
       WHERE s.classe_id = $1 AND s.school_id = $2
       ORDER BY s.nom, s.prenom`,
      [id, req.user.school_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
