const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const requireAdmin = [authenticate, authorize('admin', 'superAdmin')];

// GET /api/clubs — list clubs for school (admin/teacher) or child's clubs (parent)
router.get('/', authenticate, async (req, res, next) => {
  try {
    let school_id = req.user.school_id;

    if (req.user.role === 'parent') {
      const children = await query(
        'SELECT id, school_id FROM students WHERE parent_id = $1',
        [req.user.id]
      );
      if (children.rows.length === 0) return res.json({ success: true, data: [] });
      school_id = children.rows[0].school_id;
      const childIds = children.rows.map(r => r.id);

      const result = await query(
        `SELECT c.*,
                array_agg(DISTINCT s.prenom || ' ' || s.nom) FILTER (WHERE s.id IS NOT NULL) AS membres_noms,
                COUNT(cm2.eleve_id) AS total_membres
         FROM clubs c
         LEFT JOIN club_membres cm ON cm.club_id = c.id AND cm.eleve_id = ANY($2)
         LEFT JOIN club_membres cm2 ON cm2.club_id = c.id
         LEFT JOIN students s ON s.id = cm.eleve_id
         WHERE c.school_id = $1 AND cm.eleve_id = ANY($2)
         GROUP BY c.id
         ORDER BY c.nom ASC`,
        [school_id, childIds]
      );
      return res.json({ success: true, data: result.rows });
    }

    if (!school_id) return res.json({ success: true, data: [] });

    const result = await query(
      `SELECT c.*, COUNT(cm.eleve_id) AS total_membres
       FROM clubs c
       LEFT JOIN club_membres cm ON cm.club_id = c.id
       WHERE c.school_id = $1
       GROUP BY c.id
       ORDER BY c.nom ASC`,
      [school_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clubs — create club (admin only)
router.post('/', requireAdmin, [
  body('nom').notEmpty().withMessage('nom required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { nom, description, emoji, couleur } = req.body;
    const school_id = req.user.school_id;

    const result = await query(
      `INSERT INTO clubs (school_id, nom, description, emoji, couleur)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [school_id, nom, description || null, emoji || '🏫', couleur || '#4A90D9']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/clubs/:id — update club (admin only)
router.put('/:id', requireAdmin, [
  body('nom').notEmpty().withMessage('nom required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { nom, description, emoji, couleur } = req.body;

    const result = await query(
      `UPDATE clubs SET nom=$1, description=$2, emoji=$3, couleur=$4
       WHERE id=$5 AND school_id=$6 RETURNING *`,
      [nom, description || null, emoji || '🏫', couleur || '#4A90D9',
       req.params.id, req.user.school_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Club not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/clubs/:id — admin only
router.delete('/:id', requireAdmin, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM club_membres WHERE club_id = $1', [req.params.id]);
    const result = await client.query(
      'DELETE FROM clubs WHERE id = $1 AND school_id = $2 RETURNING id',
      [req.params.id, req.user.school_id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Club not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/clubs/:id/membres — list members of a club
router.get('/:id/membres', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.id, s.nom, s.prenom, cl.nom AS classe_nom
       FROM club_membres cm
       JOIN students s ON s.id = cm.eleve_id
       LEFT JOIN classes cl ON cl.id = s.classe_id
       WHERE cm.club_id = $1
       ORDER BY s.nom ASC, s.prenom ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clubs/:id/membres — add student to club
router.post('/:id/membres', requireAdmin, [
  body('eleve_id').notEmpty().withMessage('eleve_id required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { eleve_id } = req.body;

    // Verify club belongs to this school
    const club = await query(
      'SELECT id FROM clubs WHERE id = $1 AND school_id = $2',
      [req.params.id, req.user.school_id]
    );
    if (club.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Club not found' });
    }

    await query(
      `INSERT INTO club_membres (club_id, eleve_id) VALUES ($1, $2)
       ON CONFLICT (club_id, eleve_id) DO NOTHING`,
      [req.params.id, eleve_id]
    );
    res.status(201).json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/clubs/:id/membres/:eleveId — remove student from club
router.delete('/:id/membres/:eleveId', requireAdmin, async (req, res, next) => {
  try {
    await query(
      'DELETE FROM club_membres WHERE club_id = $1 AND eleve_id = $2',
      [req.params.id, req.params.eleveId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
