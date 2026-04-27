const router = require('express').Router();
const { sendPush, getTokensForUsers, getParentTokensForClasses, getTokensByRole } = require('../utils/fcm');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/notifications  — current user's notifications
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { is_read, type, limit = 50, offset = 0 } = req.query;

    // Notifications are user-scoped (user_id), so school_id is implicitly correct
    // because users already belong to a school. No additional school_id filter needed.
    let sql = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [req.user.id];

    if (is_read !== undefined && is_read !== '') {
      params.push(is_read === 'true');
      sql += ` AND is_read = $${params.length}`;
    }
    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';
    params.push(parseInt(limit));
    sql += ` LIMIT $${params.length}`;
    params.push(parseInt(offset));
    sql += ` OFFSET $${params.length}`;

    const result = await query(sql, params);
    const unreadCount = (await query('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.id])).rows[0].count;

    res.json({ success: true, data: result.rows, unread_count: parseInt(unreadCount) });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read  — mark single notification as read
router.patch('/:id/read', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/mark-all-read  — mark all as read for current user
router.patch('/mark-all-read', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE RETURNING id',
      [req.user.id]
    );
    res.json({ success: true, data: { updated: result.rowCount, message: 'All notifications marked as read' } });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications  — admin+ can create for any user; others create only for themselves
router.post(
  '/',
  authenticate,
  [
    body('title').notEmpty().withMessage('Title required'),
    body('message').notEmpty().withMessage('Message required'),
    body('type').isIn(['absence', 'grade', 'general', 'message', 'exam', 'payment']).withMessage('Invalid type'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { title, message, type, data } = req.body;
      let { user_id } = req.body;

      // Non-admin users can only create notifications for themselves
      if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
        user_id = req.user.id;
      } else {
        user_id = user_id || req.user.id;

        // Admin can only notify users within their own school
        if (req.user.role === 'admin' && user_id !== req.user.id) {
          const userCheck = await query(
            'SELECT id FROM users WHERE id = $1 AND school_id = $2',
            [user_id, req.user.school_id]
          );
          if (userCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Target user not in your school' });
          }
        }
      }

      const result = await query(
        `INSERT INTO notifications (user_id, title, message, type, data)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [user_id, title, message, type, data ? JSON.stringify(data) : null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/notifications/broadcast  — admin+ sends to multiple users
// Supports: role, user_ids, classe_id (filters teachers by class), file_url attachment
router.post('/broadcast', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { user_ids, role, classe_id, title, message, type = 'general', data, file_url } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message required' });
    }

    let targetUserIds = [];

    if (user_ids && user_ids.length > 0) {
      // Explicit user list — validate school membership for admin
      if (req.user.role === 'admin') {
        const validUsers = await query(
          'SELECT id FROM users WHERE id = ANY($1) AND school_id = $2',
          [user_ids, req.user.school_id]
        );
        targetUserIds = validUsers.rows.map((r) => r.id);
      } else {
        targetUserIds = user_ids;
      }
    } else if (classe_id && role === 'teacher') {
      // Teachers who teach a specific class (from schedules)
      const r = await query(
        `SELECT DISTINCT teacher_id AS id FROM schedules
         WHERE classe_id = $1 AND school_id = $2`,
        [classe_id, req.user.school_id]
      );
      targetUserIds = r.rows.map((row) => row.id);
    } else if (role) {
      // All users with given role in the school — never include sender
      const roleQuery = req.user.role === 'admin'
        ? 'SELECT id FROM users WHERE role = $1 AND is_active = TRUE AND school_id = $2 AND id != $3'
        : 'SELECT id FROM users WHERE role = $1 AND is_active = TRUE AND id != $2';
      const roleParams = req.user.role === 'admin'
        ? [role, req.user.school_id, req.user.id]
        : [role, req.user.id];
      const rolesResult = await query(roleQuery, roleParams);
      targetUserIds = rolesResult.rows.map((r) => r.id);
    }

    if (targetUserIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No target users specified' });
    }

    const notifData = { ...(data || {}), ...(file_url ? { file_url } : {}) };

    const inserts = [];
    for (const uid of targetUserIds) {
      const r = await query(
        `INSERT INTO notifications (user_id, title, message, type, data)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [uid, title, message, type, Object.keys(notifData).length ? JSON.stringify(notifData) : null]
      );
      inserts.push(r.rows[0].id);
    }

    const fcmTokens = await getTokensForUsers(targetUserIds);
    await sendPush(fcmTokens, title, message, { type, ...(file_url ? { file_url } : {}) });

    res.status(201).json({ success: true, data: { sent_to: targetUserIds.length, notification_ids: inserts } });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/notify-classe — admin/teacher sends to parents of one/many/all classes
// Body: { title, message, type?, all?: bool, classe_ids?: int[], classe_id?: int }
router.post('/notify-classe', authenticate, authorize('admin', 'superAdmin', 'teacher'), async (req, res, next) => {
  try {
    const { title, message, type = 'general' } = req.body;
    let { all, classe_ids, classe_id } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'title et message requis' });
    }

    // Normalise: support legacy single classe_id + new classe_ids array + all flag
    let targetClassIds = [];

    if (all) {
      if (req.user.role === 'teacher') {
        // Teacher "all" = only their assigned classes
        const teacherClasses = await query(
          `SELECT DISTINCT classe_id AS id FROM teacher_classes WHERE teacher_id=$1
           UNION SELECT DISTINCT classe_id AS id FROM schedules WHERE teacher_id=$1`,
          [req.user.id]
        );
        targetClassIds = teacherClasses.rows.map((r) => r.id);
      } else {
        // Admin/superAdmin: all classes in school
        const allClasses = await query(
          'SELECT id FROM classes WHERE school_id = $1',
          [req.user.school_id]
        );
        targetClassIds = allClasses.rows.map((r) => r.id);
      }
    } else {
      if (classe_ids && Array.isArray(classe_ids) && classe_ids.length > 0) {
        targetClassIds = classe_ids.map(Number);
      } else if (classe_id) {
        targetClassIds = [Number(classe_id)];
      } else {
        return res.status(400).json({ success: false, message: 'all, classe_ids ou classe_id requis' });
      }

      // Verify classes belong to school (admin) or teacher's assignment (teacher)
      if (req.user.role === 'teacher') {
        const teacherClasses = await query(
          `SELECT DISTINCT classe_id AS id FROM teacher_classes WHERE teacher_id=$1 AND classe_id=ANY($2)
           UNION SELECT DISTINCT classe_id AS id FROM schedules WHERE teacher_id=$1 AND classe_id=ANY($2)`,
          [req.user.id, targetClassIds]
        );
        targetClassIds = teacherClasses.rows.map((r) => r.id);
        if (targetClassIds.length === 0) {
          return res.status(403).json({ success: false, message: 'Vous n\'êtes pas assigné à ces classes' });
        }
      } else if (req.user.role === 'admin') {
        const check = await query(
          'SELECT id FROM classes WHERE id = ANY($1) AND school_id = $2',
          [targetClassIds, req.user.school_id]
        );
        if (check.rows.length !== targetClassIds.length) {
          return res.status(403).json({ success: false, message: 'Une ou plusieurs classes ne font pas partie de votre école' });
        }
      }
    }

    if (targetClassIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucune classe trouvée' });
    }

    // Get all distinct parents of students in target classes — role must be 'parent'
    const parentsResult = await query(
      `SELECT DISTINCT s.parent_id FROM students s
       JOIN users u ON u.id = s.parent_id
       WHERE s.classe_id = ANY($1) AND s.parent_id IS NOT NULL AND s.school_id = $2
         AND u.role = 'parent'`,
      [targetClassIds, req.user.school_id]
    );

    if (parentsResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun parent trouvé pour ces classes' });
    }

    const ids = [];
    for (const row of parentsResult.rows) {
      const r = await query(
        `INSERT INTO notifications (user_id, school_id, title, message, type)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [row.parent_id, req.user.school_id, title, message, type]
      );
      ids.push(r.rows[0].id);
    }

    const parentIds = parentsResult.rows.map((r) => r.parent_id);
    const fcmTokens = await getTokensForUsers(parentIds);
    await sendPush(fcmTokens, title, message, { type });

    res.status(201).json({ success: true, data: { sent_to: ids.length, notification_ids: ids } });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, data: { message: 'Notification deleted' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
