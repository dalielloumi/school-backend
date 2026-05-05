const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const requireAdmin   = [authenticate, authorize('admin', 'superAdmin')];
const requireParent  = [authenticate];

// ── Check if school has cantine enabled ──────────────────
// GET /api/cantine/features
router.get('/features', authenticate, async (req, res, next) => {
  try {
    const school_id = req.user.school_id;
    if (!school_id) return res.json({ success: true, has_cantine: false });
    const result = await query('SELECT has_cantine FROM schools WHERE id = $1', [school_id]);
    const has_cantine = result.rows[0]?.has_cantine ?? false;
    res.json({ success: true, has_cantine });
  } catch (err) { next(err); }
});

// ── Get menus ─────────────────────────────────────────────
// GET /api/cantine?date_from=&date_to=
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { date_from, date_to } = req.query;

    // Check feature enabled for this school
    let school_id = req.user.school_id;

    // Parent: derive school from child
    if (req.user.role === 'parent') {
      const child = await query('SELECT school_id FROM students WHERE parent_id = $1 LIMIT 1', [req.user.id]);
      school_id = child.rows[0]?.school_id ?? school_id;
    }

    if (!school_id) return res.json({ success: true, data: [] });

    const feat = await query('SELECT has_cantine FROM schools WHERE id = $1', [school_id]);
    if (!feat.rows[0]?.has_cantine) return res.json({ success: true, data: [] });

    const params = [school_id];
    let sql = 'SELECT * FROM cantine_menus WHERE school_id = $1';
    if (date_from) { params.push(date_from); sql += ` AND date >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   sql += ` AND date <= $${params.length}`; }
    sql += ' ORDER BY date ASC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// ── Upsert a menu (admin) ─────────────────────────────────
// POST /api/cantine  body: { date, plats }
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { date, plats } = req.body;
    if (!date || !plats || !plats.trim()) {
      return res.status(400).json({ success: false, message: 'date and plats required' });
    }
    const school_id = req.user.school_id;

    // Check feature enabled
    const feat = await query('SELECT has_cantine FROM schools WHERE id = $1', [school_id]);
    if (!feat.rows[0]?.has_cantine) {
      return res.status(403).json({ success: false, message: 'Cantine not enabled for this school' });
    }

    const result = await query(
      `INSERT INTO cantine_menus (school_id, date, plats, created_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (school_id, date)
       DO UPDATE SET plats = EXCLUDED.plats, created_by = EXCLUDED.created_by, updated_at = NOW()
       RETURNING *`,
      [school_id, date, plats.trim(), req.user.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Delete a menu (admin) ─────────────────────────────────
// DELETE /api/cantine/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM cantine_menus WHERE id = $1 AND school_id = $2 RETURNING id',
      [req.params.id, req.user.school_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
