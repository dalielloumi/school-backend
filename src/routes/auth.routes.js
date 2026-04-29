const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, generateToken } = require('../middleware/auth');

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { email, password } = req.body;

      const result = await query(
        'SELECT id, school_id, nom, prenom, email, password_hash, role, phone, avatar_url, is_active FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      const user = result.rows[0];

      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'Account is deactivated' });
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      const token = generateToken(user);

      const { password_hash, ...safeUser } = user;

      res.json({
        success: true,
        data: {
          token,
          user: safeUser,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/auth/fcm-token  — save device FCM token
router.put('/fcm-token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required' });
    // Clear this token from any other user first (one device = one active user)
    await query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id != $2', [token, req.user.id]);
    await query('UPDATE users SET fcm_token = $1 WHERE id = $2', [token, req.user.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  // Stateless JWT: simply acknowledge logout
  // For production, maintain a token blacklist in Redis
  res.json({ success: true, data: { message: 'Logged out successfully' } });
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
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

module.exports = router;
