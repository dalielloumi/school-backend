const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { getSubjectsForTypes } = require('../db/subjects_master');

// ============================================================
// SUPER ADMIN ROUTES — manage schools + admin accounts
// ============================================================

const requireSuperAdmin = [authenticate, authorize('superAdmin')];

// GET /api/accounts/schools — list all schools
router.get('/schools', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT s.*, COUNT(u.id) FILTER (WHERE u.role = 'admin') AS admin_count,
             COUNT(u.id) FILTER (WHERE u.role = 'teacher') AS teacher_count,
             COUNT(u.id) FILTER (WHERE u.role = 'parent') AS parent_count
      FROM schools s
      LEFT JOIN users u ON u.school_id = s.id
      GROUP BY s.id
      ORDER BY s.nom
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/accounts/schools — create a school
router.post('/schools', requireSuperAdmin,
  [
    body('nom').notEmpty().withMessage('School name required'),
    body('ville').notEmpty().withMessage('City required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }
      const { nom, adresse, ville, phone, email, school_types } = req.body;

      // Validate school_types
      const validTypes = ['primaire', 'college', 'secondaire'];
      const types = Array.isArray(school_types)
        ? school_types.filter(t => validTypes.includes(t))
        : [];

      const result = await query(
        `INSERT INTO schools (nom, adresse, ville, phone, email, school_types)
         VALUES ($1,$2,$3,$4,$5,$6::text[])
         RETURNING *`,
        [nom, adresse || null, ville, phone || null, email || null, types]
      );
      const school = result.rows[0];

      // Auto-create subjects for the selected school types
      if (types.length > 0) {
        const subjects = getSubjectsForTypes(types);
        for (const s of subjects) {
          await query(
            `INSERT INTO subjects (school_id, nom, code, coefficient, color, applicable_for, niveaux)
             VALUES ($1,$2,$3,$4::numeric,$5,$6::text[],$7::text[])
             ON CONFLICT (school_id, code) DO NOTHING`,
            [school.id, s.nom, s.code, s.coefficient, s.color, s.applicable_for, s.niveaux]
          );
        }

        // Auto-create base classes for the selected school types
        const classesByType = {
          primaire:    ['1ère','2ème','3ème','4ème','5ème','6ème'],
          college:     ['7ème','8ème','9ème'],
          secondaire:  ['1ère sec','2ème sec','3ème sec','4ème sec'],
        };
        for (const type of types) {
          for (const niveau of classesByType[type]) {
            const nom = `${niveau} 1`;
            await query(
              `INSERT INTO classes (school_id, nom, niveau)
               SELECT $1::int, $2::text, $3::text
               WHERE NOT EXISTS (
                 SELECT 1 FROM classes WHERE school_id = $1::int AND nom = $2::text
               )`,
              [school.id, nom, niveau]
            );
          }
        }
      }

      res.status(201).json({ success: true, data: school });
    } catch (err) { next(err); }
  }
);

// PUT /api/accounts/schools/:id — update a school
router.put('/schools/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const { nom, adresse, ville, phone, email, is_active, school_types } = req.body;

    const validTypes = ['primaire', 'college', 'secondaire'];
    const types = Array.isArray(school_types)
      ? school_types.filter(t => validTypes.includes(t))
      : null;

    const result = await query(
      `UPDATE schools SET
         nom          = COALESCE($1, nom),
         adresse      = COALESCE($2, adresse),
         ville        = COALESCE($3, ville),
         phone        = COALESCE($4, phone),
         email        = COALESCE($5, email),
         is_active    = COALESCE($6, is_active),
         school_types = COALESCE($7::text[], school_types)
       WHERE id = $8 RETURNING *`,
      [nom, adresse, ville, phone, email, is_active, types, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/accounts/schools/:id — delete school (cascades everything)
router.delete('/schools/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM schools WHERE id = $1 RETURNING id, nom',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }
    res.json({ success: true, data: { message: 'School deleted', school: result.rows[0] } });
  } catch (err) { next(err); }
});

// GET /api/accounts — list all admin accounts (superAdmin sees all)
router.get('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const { school_id, is_active, search } = req.query;
    let sql = `
      SELECT u.id, u.school_id, u.nom, u.prenom, u.email, u.role,
             u.phone, u.avatar_url, u.is_active, u.created_at,
             s.nom AS school_nom
      FROM users u
      LEFT JOIN schools s ON u.school_id = s.id
      WHERE u.role = 'admin'
    `;
    const params = [];

    if (school_id) {
      params.push(school_id);
      sql += ` AND u.school_id = $${params.length}`;
    }
    if (is_active !== undefined && is_active !== '') {
      params.push(is_active === 'true');
      sql += ` AND u.is_active = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (u.nom ILIKE $${params.length} OR u.prenom ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
    }

    sql += ' ORDER BY s.nom, u.nom, u.prenom';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/accounts — superAdmin creates an admin account for a school
router.post('/', requireSuperAdmin,
  [
    body('nom').notEmpty().withMessage('Last name required'),
    body('prenom').notEmpty().withMessage('First name required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
    body('school_id').isInt({ min: 1 }).withMessage('School ID required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, prenom, email, password, school_id, phone, avatar_url } = req.body;

      // Verify school exists
      const school = await query('SELECT id FROM schools WHERE id = $1', [school_id]);
      if (school.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'School not found' });
      }

      // Check if school already has an admin
      const existing = await query(
        "SELECT id FROM users WHERE school_id = $1 AND role = 'admin'",
        [school_id]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'This school already has an admin account' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await query(
        `INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone, avatar_url)
         VALUES ($1,$2,$3,$4,$5,'admin'::user_role,$6,$7)
         RETURNING id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at`,
        [school_id, nom, prenom, email, passwordHash, phone || null, avatar_url || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// PATCH /api/accounts/:id/toggle-active
router.patch('/:id/toggle-active', requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate your own account' });
    }
    const result = await query(
      'UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING id, nom, prenom, email, role, is_active',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const u = result.rows[0];
    res.json({ success: true, data: { ...u, message: u.is_active ? 'Account activated' : 'Account deactivated' } });
  } catch (err) { next(err); }
});

// PATCH /api/accounts/:id/reset-password
router.patch('/:id/reset-password', requireSuperAdmin,
  [body('new_password').isLength({ min: 6 }).withMessage('Password min 6 characters')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }
      const passwordHash = await bcrypt.hash(req.body.new_password, 12);
      const result = await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, nom, prenom, email',
        [passwordHash, req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, data: { message: 'Password reset successfully', user: result.rows[0] } });
    } catch (err) { next(err); }
  }
);

// DELETE /api/accounts/:id
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }
    const result = await query(
      'DELETE FROM users WHERE id = $1 RETURNING id, nom, prenom, email, role',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, data: { message: 'User deleted', user: result.rows[0] } });
  } catch (err) { next(err); }
});

// ============================================================
// ADMIN ROUTES — manage teachers + parents for their school
// ============================================================

const requireAdmin = [authenticate, authorize('admin')];

// GET /api/accounts/staff — list teachers + parents of this school
router.get('/staff', requireAdmin, async (req, res, next) => {
  try {
    const { role, is_active, search } = req.query;
    let sql = `
      SELECT id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at
      FROM users
      WHERE school_id = $1 AND role IN ('teacher','parent')
    `;
    const params = [req.user.school_id];

    if (role && ['teacher', 'parent'].includes(role)) {
      params.push(role);
      sql += ` AND role = $${params.length}::user_role`;
    }
    if (is_active !== undefined && is_active !== '') {
      params.push(is_active === 'true');
      sql += ` AND is_active = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (nom ILIKE $${params.length} OR prenom ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }

    sql += ' ORDER BY role, nom, prenom';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/accounts/staff — admin creates teacher or parent account
router.post('/staff', requireAdmin,
  [
    body('nom').notEmpty().withMessage('Last name required'),
    body('prenom').notEmpty().withMessage('First name required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
    body('role').isIn(['teacher', 'parent']).withMessage('Role must be teacher or parent'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, prenom, email, password, role, phone, cin, avatar_url } = req.body;

      // Unique email check
      const emailCheck = await query(
        `SELECT id FROM users WHERE email = $1 AND school_id = $2`,
        [email.toLowerCase(), req.user.school_id]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé par un autre compte' });
      }

      // Unique phone check (parents only)
      if (role === 'parent' && phone) {
        const phoneCheck = await query(
          `SELECT id FROM users WHERE phone = $1 AND school_id = $2 AND role = 'parent'`,
          [phone, req.user.school_id]
        );
        if (phoneCheck.rows.length > 0) {
          return res.status(409).json({ success: false, message: 'Ce numéro de téléphone est déjà utilisé par un autre parent' });
        }
      }

      // Unique CIN check (parents only) — stored on users.cin
      if (role === 'parent' && cin) {
        const cinCheck = await query(
          `SELECT id FROM users WHERE cin = $1 AND school_id = $2 AND role = 'parent'`,
          [cin, req.user.school_id]
        );
        if (cinCheck.rows.length > 0) {
          return res.status(409).json({ success: false, message: 'Ce CIN est déjà utilisé par un autre parent' });
        }
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const result = await query(
        `INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone, cin, avatar_url)
         VALUES ($1,$2,$3,$4,$5,$6::user_role,$7,$8,$9)
         RETURNING id, school_id, nom, prenom, email, role, phone, cin, avatar_url, is_active, created_at`,
        [req.user.school_id, nom, prenom, email.toLowerCase(), passwordHash, role, phone || null, cin || null, avatar_url || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
      }
      next(err);
    }
  }
);

// PUT /api/accounts/staff/:id — admin updates a staff member
router.put('/staff/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    // Make sure this user belongs to the admin's school
    const check = await query(
      "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role IN ('teacher','parent')",
      [id, req.user.school_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found in your school' });
    }

    const { nom, prenom, email, phone, avatar_url } = req.body;
    const result = await query(
      `UPDATE users SET
         nom        = COALESCE($1, nom),
         prenom     = COALESCE($2, prenom),
         email      = COALESCE($3, email),
         phone      = COALESCE($4, phone),
         avatar_url = COALESCE($5, avatar_url)
       WHERE id = $6
       RETURNING id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at`,
      [nom, prenom, email, phone, avatar_url, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/accounts/staff/:id/toggle-active
router.patch('/staff/:id/toggle-active', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const check = await query(
      "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role IN ('teacher','parent')",
      [id, req.user.school_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found in your school' });
    }
    const result = await query(
      'UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING id, nom, prenom, email, role, is_active',
      [id]
    );
    const u = result.rows[0];
    res.json({ success: true, data: { ...u, message: u.is_active ? 'Account activated' : 'Account deactivated' } });
  } catch (err) { next(err); }
});

// PATCH /api/accounts/staff/:id/reset-password
router.patch('/staff/:id/reset-password', requireAdmin,
  [body('new_password').isLength({ min: 6 }).withMessage('Password min 6 characters')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }
      const { id } = req.params;
      const check = await query(
        "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role IN ('teacher','parent')",
        [id, req.user.school_id]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found in your school' });
      }
      const passwordHash = await bcrypt.hash(req.body.new_password, 12);
      const result = await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, nom, prenom, email',
        [passwordHash, id]
      );
      res.json({ success: true, data: { message: 'Password reset successfully', user: result.rows[0] } });
    } catch (err) { next(err); }
  }
);

// DELETE /api/accounts/staff/:id
router.delete('/staff/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      "DELETE FROM users WHERE id = $1 AND school_id = $2 AND role IN ('teacher','parent') RETURNING id, nom, prenom, email, role",
      [id, req.user.school_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found in your school' });
    }
    res.json({ success: true, data: { message: 'User deleted', user: result.rows[0] } });
  } catch (err) { next(err); }
});

module.exports = router;
