const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/profile  — current user's profile
router.get('/', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/profile  — update own profile (nom, prenom, phone, avatar_url)
router.put(
  '/',
  authenticate,
  [
    body('email').optional().isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').optional().isMobilePhone('any', { strictMode: false }).withMessage('Valid phone required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { nom, prenom, phone, avatar_url, email } = req.body;

      // If email change requested, check uniqueness
      if (email && email !== req.user.email) {
        const existing = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.user.id]);
        if (existing.rows.length > 0) {
          return res.status(409).json({ success: false, message: 'Email already in use' });
        }
      }

      const result = await query(
        `UPDATE users SET
           nom = COALESCE($1, nom),
           prenom = COALESCE($2, prenom),
           phone = COALESCE($3, phone),
           avatar_url = COALESCE($4, avatar_url),
           email = COALESCE($5, email)
         WHERE id = $6
         RETURNING id, school_id, nom, prenom, email, role, phone, avatar_url, is_active, created_at`,
        [nom, prenom, phone, avatar_url, email, req.user.id]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/profile/change-password  — change own password
router.patch(
  '/change-password',
  authenticate,
  [
    body('current_password').notEmpty().withMessage('Current password required'),
    body('new_password').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { current_password, new_password } = req.body;

      // Fetch current hash
      const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const match = await bcrypt.compare(current_password, result.rows[0].password_hash);
      if (!match) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect' });
      }

      const newHash = await bcrypt.hash(new_password, 12);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

      res.json({ success: true, data: { message: 'Password changed successfully' } });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
