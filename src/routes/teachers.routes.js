const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const TEACHER_SELECT = `
  SELECT u.id, u.nom, u.prenom, u.email, u.phone, u.avatar_url, u.is_active, u.created_at,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', c.id, 'nom', c.nom, 'niveau', c.niveau)) FILTER (WHERE c.id IS NOT NULL),
           '[]'
         ) AS classes,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', sub.id, 'nom', sub.nom, 'code', sub.code)) FILTER (WHERE sub.id IS NOT NULL),
           '[]'
         ) AS subjects
  FROM users u
  LEFT JOIN teacher_classes tc ON tc.teacher_id = u.id
  LEFT JOIN classes c ON c.id = tc.classe_id
  LEFT JOIN teacher_subjects ts ON ts.teacher_id = u.id
  LEFT JOIN subjects sub ON sub.id = ts.subject_id
  WHERE u.role = 'teacher'
`;

// GET /api/teachers
router.get('/', authenticate, authorize('admin', 'superAdmin', 'teacher'), async (req, res, next) => {
  try {
    let sql = TEACHER_SELECT;
    const params = [];

    // Scope by school_id for admin/teacher (superAdmin sees all)
    if (req.user.role === 'admin') {
      params.push(req.user.school_id);
      sql += ` AND u.school_id = $${params.length}`;
    } else if (req.user.role === 'teacher') {
      // A teacher can only see themselves
      params.push(req.user.school_id);
      sql += ` AND u.school_id = $${params.length}`;
      params.push(req.user.id);
      sql += ` AND u.id = $${params.length}`;
    }

    sql += ' GROUP BY u.id ORDER BY u.nom, u.prenom';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/teachers/:id
router.get('/:id', authenticate, authorize('admin', 'superAdmin', 'teacher'), async (req, res, next) => {
  try {
    const { id } = req.params;

    if (req.user.role === 'teacher' && parseInt(id) !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Scope by school_id (superAdmin has no school_id restriction)
    let sql = TEACHER_SELECT + ' AND u.id = $1';
    const params = [id];

    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      sql += ` AND u.school_id = $${params.length}`;
    }

    sql += ' GROUP BY u.id';
    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/teachers  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('nom').notEmpty().withMessage('Last name required'),
    body('prenom').notEmpty().withMessage('First name required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
  ],
  async (req, res, next) => {
    const client = await getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, prenom, email, password, phone, avatar_url, classe_ids = [], subject_ids = [] } = req.body;
      const school_id = req.user.school_id;

      const passwordHash = await bcrypt.hash(password, 12);

      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone, avatar_url)
         VALUES ($1,$2,$3,$4,$5,'teacher',$6,$7) RETURNING id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at`,
        [school_id, nom, prenom, email, passwordHash, phone || null, avatar_url || null]
      );
      const teacher = userResult.rows[0];

      for (const cid of classe_ids) {
        await client.query('INSERT INTO teacher_classes (teacher_id, classe_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [teacher.id, cid]);
      }
      for (const sid of subject_ids) {
        await client.query('INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [teacher.id, sid]);
      }

      await client.query('COMMIT');
      res.status(201).json({ success: true, data: teacher });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// PUT /api/teachers/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { id } = req.params;
    const { nom, prenom, email, phone, avatar_url, is_active, classe_ids, subject_ids } = req.body;

    // Scope by school_id
    const checkSql = req.user.role === 'superAdmin'
      ? "SELECT id FROM users WHERE id = $1 AND role = 'teacher'"
      : "SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2";
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await client.query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE users SET
         nom = COALESCE($1, nom),
         prenom = COALESCE($2, prenom),
         email = COALESCE($3, email),
         phone = COALESCE($4, phone),
         avatar_url = COALESCE($5, avatar_url),
         is_active = COALESCE($6, is_active)
       WHERE id = $7
       RETURNING id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at`,
      [nom, prenom, email, phone, avatar_url, is_active, id]
    );

    if (classe_ids !== undefined) {
      await client.query('DELETE FROM teacher_classes WHERE teacher_id = $1', [id]);
      for (const cid of classe_ids) {
        await client.query('INSERT INTO teacher_classes (teacher_id, classe_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, cid]);
      }
    }

    if (subject_ids !== undefined) {
      await client.query('DELETE FROM teacher_subjects WHERE teacher_id = $1', [id]);
      for (const sid of subject_ids) {
        await client.query('INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sid]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/teachers/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const deleteSql = req.user.role === 'superAdmin'
      ? "DELETE FROM users WHERE id = $1 AND role = 'teacher' RETURNING id"
      : "DELETE FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2 RETURNING id";
    const deleteParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }

    res.json({ success: true, data: { message: 'Teacher deleted', id: parseInt(id) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/teachers/:id/classes
router.get('/:id/classes', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.user.role === 'teacher' && parseInt(id) !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Scope classes by school_id
    let sql;
    let params;
    if (req.user.role === 'superAdmin') {
      sql = `SELECT c.* FROM classes c
             JOIN teacher_classes tc ON tc.classe_id = c.id
             WHERE tc.teacher_id = $1
             ORDER BY c.nom`;
      params = [id];
    } else {
      sql = `SELECT c.* FROM classes c
             JOIN teacher_classes tc ON tc.classe_id = c.id
             WHERE tc.teacher_id = $1 AND c.school_id = $2
             ORDER BY c.nom`;
      params = [id, req.user.school_id];
    }

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
