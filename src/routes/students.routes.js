const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const BASE_SELECT = `
  SELECT s.*,
         c.nom AS classe_nom, c.niveau AS classe_niveau,
         u.nom AS parent_nom, u.prenom AS parent_prenom, u.phone AS parent_phone
  FROM students s
  LEFT JOIN classes c ON c.id = s.classe_id
  LEFT JOIN users u ON u.id = s.parent_id
`;

// GET /api/students  — admin/superAdmin: all; teacher: only students in their classes; parent: own child
router.get('/', authenticate, async (req, res, next) => {
  try {
    let rows;

    if (req.user.role === 'superAdmin' || req.user.role === 'admin') {
      const { classe_id, search } = req.query;
      let sql = BASE_SELECT;
      const params = [];
      const conditions = [];

      // Scope by school_id for admin (superAdmin has no school_id, sees all)
      if (req.user.role === 'admin') {
        params.push(req.user.school_id);
        conditions.push(`s.school_id = $${params.length}`);
      }

      if (classe_id) {
        params.push(classe_id);
        conditions.push(`s.classe_id = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(s.nom ILIKE $${params.length} OR s.prenom ILIKE $${params.length})`);
      }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY s.nom, s.prenom';
      rows = (await query(sql, params)).rows;
    } else if (req.user.role === 'teacher') {
      // Teacher sees students in classes assigned via teacher_classes OR schedules
      const sql = `
        ${BASE_SELECT}
        WHERE s.school_id = $1
          AND s.classe_id IN (
            SELECT classe_id FROM teacher_classes WHERE teacher_id = $2
            UNION
            SELECT DISTINCT classe_id FROM schedules WHERE teacher_id = $2 AND school_id = $1
          )
        ORDER BY s.nom, s.prenom
      `;
      rows = (await query(sql, [req.user.school_id, req.user.id])).rows;
    } else if (req.user.role === 'parent') {
      const sql = `${BASE_SELECT} WHERE s.parent_id = $1 AND s.school_id = $2 ORDER BY s.nom, s.prenom`;
      rows = (await query(sql, [req.user.id, req.user.school_id])).rows;
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/students/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(`${BASE_SELECT} WHERE s.id = $1 AND s.school_id = $2`, [id, req.user.school_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const student = result.rows[0];

    // Parent can only view their own child
    if (req.user.role === 'parent' && student.parent_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Teacher can view only students in their classes
    if (req.user.role === 'teacher') {
      const check = await query(
        'SELECT 1 FROM teacher_classes WHERE teacher_id = $1 AND classe_id = $2',
        [req.user.id, student.classe_id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
});

// POST /api/students  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('nom').notEmpty().withMessage('Last name required'),
    body('prenom').notEmpty().withMessage('First name required'),
    body('classe_id').optional().isInt().withMessage('classe_id must be integer'),
    body('parent_id').optional().isInt().withMessage('parent_id must be integer'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, prenom, email, phone, date_naissance, avatar_url, classe_id, parent_id, moyenne_generale } = req.body;
      const school_id = req.user.school_id;

      const result = await query(
        `INSERT INTO students (school_id, nom, prenom, email, phone, date_naissance, avatar_url, classe_id, parent_id, moyenne_generale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [school_id, nom, prenom, email || null, phone || null, date_naissance || null, avatar_url || null,
         classe_id || null, parent_id || null, moyenne_generale || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/students/:id  — admin+
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'superAdmin'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { nom, prenom, email, phone, date_naissance, avatar_url, classe_id, parent_id, moyenne_generale } = req.body;

      const check = await query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [id, req.user.school_id]);
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }

      const result = await query(
        `UPDATE students SET
           nom = COALESCE($1, nom),
           prenom = COALESCE($2, prenom),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           date_naissance = COALESCE($5, date_naissance),
           avatar_url = COALESCE($6, avatar_url),
           classe_id = COALESCE($7, classe_id),
           parent_id = COALESCE($8, parent_id),
           moyenne_generale = COALESCE($9, moyenne_generale)
         WHERE id = $10 AND school_id = $11
         RETURNING *`,
        [nom, prenom, email, phone, date_naissance, avatar_url, classe_id, parent_id, moyenne_generale, id, req.user.school_id]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/students/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM students WHERE id = $1 AND school_id = $2 RETURNING id', [id, req.user.school_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    res.json({ success: true, data: { message: 'Student deleted', id: parseInt(id) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
