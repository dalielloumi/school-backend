const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

const requireAdmin = [authenticate, authorize('admin', 'superAdmin')];

const VALID_TYPES = ['reunion', 'sortie', 'fete', 'examen', 'sport', 'general'];

const TYPE_LABELS = {
  reunion: 'Réunion parents',
  sortie:  'Sortie scolaire',
  fete:    'Fête / Cérémonie',
  examen:  'Examen',
  sport:   'Compétition sportive',
  general: 'Événement général',
};

// GET /api/events — list events scoped by role
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { date_from, date_to } = req.query;
    let school_id = req.user.school_id;
    let parentClasseIds = null;

    if (req.user.role === 'parent') {
      const children = await query(
        'SELECT school_id, classe_id FROM students WHERE parent_id = $1',
        [req.user.id]
      );
      parentClasseIds = children.rows.map(r => r.classe_id).filter(Boolean);
      school_id = children.rows[0]?.school_id ?? school_id;
    }

    if (!school_id) return res.json({ success: true, data: [] });

    let sql = `
      SELECT e.*, c.nom AS classe_nom
      FROM school_events e
      LEFT JOIN classes c ON c.id = e.classe_id
      WHERE e.school_id = $1
    `;
    const params = [school_id];
    const conditions = [];

    if (req.user.role === 'parent') {
      if (parentClasseIds && parentClasseIds.length > 0) {
        params.push(parentClasseIds);
        conditions.push(`(e.classe_id IS NULL OR e.classe_id = ANY($${params.length}))`);
      } else {
        conditions.push(`e.classe_id IS NULL`);
      }
    }

    if (date_from) { params.push(date_from); conditions.push(`e.date_event >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   conditions.push(`e.date_event <= $${params.length}`); }

    if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
    sql += ' ORDER BY e.date_event ASC, e.created_at DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/events — create event (admin only), auto-notify parents
router.post('/', requireAdmin, [
  body('titre').notEmpty().withMessage('titre required'),
  body('date_event').isDate().withMessage('Valid date required'),
  body('type').optional().isIn(VALID_TYPES).withMessage('Invalid event type'),
], async (req, res, next) => {
  const client = await getClient();
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { titre, description, type, date_event, heure_debut, heure_fin, classe_id } = req.body;
    const school_id = req.user.school_id;
    const eventType = type || 'general';

    await client.query('BEGIN');

    const eventResult = await client.query(
      `INSERT INTO school_events
         (school_id, titre, description, type, date_event, heure_debut, heure_fin, classe_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [school_id, titre, description || null, eventType, date_event,
       heure_debut || null, heure_fin || null, classe_id || null, req.user.id]
    );

    const event = eventResult.rows[0];

    // Gather parents to notify
    let parentIds = [];
    if (classe_id) {
      const rows = await client.query(
        `SELECT DISTINCT parent_id FROM students WHERE classe_id = $1 AND parent_id IS NOT NULL`,
        [classe_id]
      );
      parentIds = rows.rows.map(r => r.parent_id);
    } else {
      const rows = await client.query(
        `SELECT id FROM users WHERE school_id = $1 AND role = 'parent' AND is_active = true`,
        [school_id]
      );
      parentIds = rows.rows.map(r => r.id);
    }

    const typeLabel = TYPE_LABELS[eventType] ?? 'Événement';
    const notifTitle = `📅 ${typeLabel}`;
    const notifBody  = description ? `${titre} — ${description}` : titre;

    for (const parentId of parentIds) {
      await client.query(
        `INSERT INTO notifications (user_id, school_id, title, message, type, data)
         VALUES ($1, $2, $3, $4, 'general', $5)`,
        [parentId, school_id, notifTitle, notifBody,
         JSON.stringify({ event_id: event.id, date_event })]
      );
    }

    if (parentIds.length > 0) {
      const tokens = await getTokensForUsers(parentIds);
      await sendPush(tokens, notifTitle, titre, {
        type: 'event',
        event_id: String(event.id),
      });
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: event });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/events/:id — admin only
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM school_events WHERE id = $1 AND school_id = $2 RETURNING id',
      [req.params.id, req.user.school_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
