const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getParentTokensForClasse, getTokensForUsers } = require('../utils/fcm');

async function notifyScheduleChange(schoolId, classeId, classeNom, dayName) {
  const msg = `L'emploi du temps de la classe ${classeNom} a été mis à jour (${dayName}).`;

  // Notify parents
  const parents = await query(
    `SELECT DISTINCT s.parent_id AS id FROM students s
     JOIN users u ON u.id = s.parent_id
     WHERE s.classe_id = $1 AND s.school_id = $2 AND s.parent_id IS NOT NULL AND u.role = 'parent'`,
    [classeId, schoolId]
  );
  for (const row of parents.rows) {
    await query(
      `INSERT INTO notifications (user_id, school_id, title, message, type)
       VALUES ($1,$2,$3,$4,'general')`,
      [row.id, schoolId, 'Emploi du temps modifié', msg]
    );
  }
  const parentFcm = await getParentTokensForClasse(schoolId, classeId);
  if (parentFcm.length) await sendPush(parentFcm, '📅 Emploi du temps', msg, { type: 'schedule' });

  // Notify ALL teachers who teach in this class
  const teachers = await query(
    `SELECT DISTINCT teacher_id AS id FROM schedules WHERE classe_id = $1 AND school_id = $2`,
    [classeId, schoolId]
  );
  const teacherMsg = `Votre emploi du temps pour la classe ${classeNom} a été mis à jour (${dayName}).`;
  for (const row of teachers.rows) {
    await query(
      `INSERT INTO notifications (user_id, school_id, title, message, type)
       VALUES ($1,$2,$3,$4,'general')`,
      [row.id, schoolId, 'Emploi du temps modifié', teacherMsg]
    );
  }
  const teacherFcm = await getTokensForUsers(teachers.rows.map((r) => r.id));
  if (teacherFcm.length) await sendPush(teacherFcm, '📅 Emploi du temps', teacherMsg, { type: 'schedule' });
}

const SCHEDULE_SELECT = `
  SELECT sch.*,
         c.nom AS classe_nom, c.niveau AS classe_niveau,
         sub.nom AS subject_nom, sub.code AS subject_code, sub.color AS subject_color,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM schedules sch
  JOIN classes c ON c.id = sch.classe_id
  JOIN subjects sub ON sub.id = sch.subject_id
  JOIN users u ON u.id = sch.teacher_id
`;

const DAY_NAMES = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

// GET /api/schedules  — filters: classe_id, teacher_id, day_of_week
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { classe_id, teacher_id, day_of_week } = req.query;

    let sql = SCHEDULE_SELECT;
    const params = [];
    const conditions = [];

    // Scope by school_id (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`sch.school_id = $${params.length}`);
    }

    if (req.user.role === 'teacher') {
      params.push(req.user.id);
      conditions.push(`sch.teacher_id = $${params.length}`);
    } else if (req.user.role === 'parent') {
      const childResult = await query(
        'SELECT classe_id FROM students WHERE parent_id = $1 AND classe_id IS NOT NULL AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      const classeIds = [...new Set(childResult.rows.map((r) => r.classe_id))];
      if (classeIds.length === 0) return res.json({ success: true, data: [] });
      params.push(classeIds);
      conditions.push(`sch.classe_id = ANY($${params.length})`);
    } else if (req.user.role === 'student') {
      const studentResult = await query(
        'SELECT classe_id FROM students WHERE id = $1 AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      if (studentResult.rows.length === 0 || !studentResult.rows[0].classe_id) {
        return res.json({ success: true, data: [] });
      }
      params.push(studentResult.rows[0].classe_id);
      conditions.push(`sch.classe_id = $${params.length}`);
    }

    if (classe_id && req.user.role !== 'parent') {
      params.push(classe_id); conditions.push(`sch.classe_id = $${params.length}`);
    }
    if (teacher_id && req.user.role !== 'teacher') {
      params.push(teacher_id); conditions.push(`sch.teacher_id = $${params.length}`);
    }
    if (day_of_week) {
      params.push(day_of_week); conditions.push(`sch.day_of_week = $${params.length}`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY sch.day_of_week, sch.start_time';

    const result = await query(sql, params);
    const data = result.rows.map((r) => ({ ...r, day_name: DAY_NAMES[r.day_of_week] || '' }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/schedules/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const scheduleSql = req.user.role === 'superAdmin'
      ? `${SCHEDULE_SELECT} WHERE sch.id = $1`
      : `${SCHEDULE_SELECT} WHERE sch.id = $1 AND sch.school_id = $2`;
    const scheduleParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(scheduleSql, scheduleParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }
    const row = { ...result.rows[0], day_name: DAY_NAMES[result.rows[0].day_of_week] || '' };
    res.json({ success: true, data: row });
  } catch (err) {
    next(err);
  }
});

// POST /api/schedules  — admin+
router.post(
  '/',
  authenticate,
  authorize('admin', 'superAdmin'),
  [
    body('classe_id').isInt().withMessage('classe_id required'),
    body('teacher_id').isInt().withMessage('teacher_id required'),
    body('subject_id').isInt().withMessage('subject_id required'),
    body('day_of_week').isInt({ min: 1, max: 6 }).withMessage('day_of_week must be 1–6'),
    body('start_time').matches(/^\d{2}:\d{2}$/).withMessage('start_time format: HH:MM'),
    body('end_time').matches(/^\d{2}:\d{2}$/).withMessage('end_time format: HH:MM'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { classe_id, teacher_id, subject_id, salle_nom, day_of_week, start_time, end_time, color } = req.body;
      const school_id = req.user.school_id;

      // Check for time conflicts on same class & day within this school
      const conflictSql = school_id
        ? `SELECT id FROM schedules
           WHERE school_id = $1 AND classe_id = $2 AND day_of_week = $3
             AND (start_time, end_time) OVERLAPS ($4::time, $5::time)`
        : `SELECT id FROM schedules
           WHERE classe_id = $1 AND day_of_week = $2
             AND (start_time, end_time) OVERLAPS ($3::time, $4::time)`;
      const conflictParams = school_id
        ? [school_id, classe_id, day_of_week, start_time, end_time]
        : [classe_id, day_of_week, start_time, end_time];

      const conflict = await query(conflictSql, conflictParams);

      if (conflict.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Time slot conflicts with existing schedule for this class' });
      }

      const result = await query(
        `INSERT INTO schedules (school_id, classe_id, teacher_id, subject_id, salle_nom, day_of_week, start_time, end_time, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [school_id, classe_id, teacher_id, subject_id, salle_nom || null, day_of_week, start_time, end_time, color || null]
      );

      // Notify parents and teacher about new schedule slot
      const classeInfo = await query('SELECT nom FROM classes WHERE id = $1', [classe_id]);
      if (classeInfo.rows.length > 0) {
        await notifyScheduleChange(school_id, classe_id, classeInfo.rows[0].nom, DAY_NAMES[day_of_week] || '');
      }

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/schedules/:id  — admin+
router.put('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT id FROM schedules WHERE id = $1'
      : 'SELECT id FROM schedules WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    const { classe_id, teacher_id, subject_id, salle_nom, day_of_week, start_time, end_time, color } = req.body;

    const result = await query(
      `UPDATE schedules SET
         classe_id = COALESCE($1, classe_id),
         teacher_id = COALESCE($2, teacher_id),
         subject_id = COALESCE($3, subject_id),
         salle_nom = COALESCE($4, salle_nom),
         day_of_week = COALESCE($5, day_of_week),
         start_time = COALESCE($6::time, start_time),
         end_time = COALESCE($7::time, end_time),
         color = COALESCE($8, color)
       WHERE id = $9 RETURNING *`,
      [classe_id, teacher_id, subject_id, salle_nom, day_of_week, start_time, end_time, color, id]
    );

    // Notify parents and teacher about the updated slot
    const updated = result.rows[0];
    const classeInfoUp = await query('SELECT nom FROM classes WHERE id = $1', [updated.classe_id]);
    if (classeInfoUp.rows.length > 0) {
      await notifyScheduleChange(
        updated.school_id, updated.classe_id, classeInfoUp.rows[0].nom,
        DAY_NAMES[updated.day_of_week] || ''
      );
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/schedules/:id  — admin+
router.delete('/:id', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const deleteSql = req.user.role === 'superAdmin'
      ? 'DELETE FROM schedules WHERE id = $1 RETURNING id'
      : 'DELETE FROM schedules WHERE id = $1 AND school_id = $2 RETURNING id';
    const deleteParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(deleteSql, deleteParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }
    res.json({ success: true, data: { message: 'Schedule deleted', id: parseInt(req.params.id) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/schedules/classe/:classeId — full week for a class
router.get('/classe/:classeId', authenticate, async (req, res, next) => {
  try {
    const scheduleSql = req.user.role === 'superAdmin'
      ? `${SCHEDULE_SELECT} WHERE sch.classe_id = $1 ORDER BY sch.day_of_week, sch.start_time`
      : `${SCHEDULE_SELECT} WHERE sch.classe_id = $1 AND sch.school_id = $2 ORDER BY sch.day_of_week, sch.start_time`;
    const scheduleParams = req.user.role === 'superAdmin'
      ? [req.params.classeId]
      : [req.params.classeId, req.user.school_id];

    const result = await query(scheduleSql, scheduleParams);
    const data = result.rows.map((r) => ({ ...r, day_name: DAY_NAMES[r.day_of_week] || '' }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/schedules/teacher/:teacherId — full week for a teacher
router.get('/teacher/:teacherId', authenticate, async (req, res, next) => {
  try {
    if (req.user.role === 'teacher' && parseInt(req.params.teacherId) !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const scheduleSql = req.user.role === 'superAdmin'
      ? `${SCHEDULE_SELECT} WHERE sch.teacher_id = $1 ORDER BY sch.day_of_week, sch.start_time`
      : `${SCHEDULE_SELECT} WHERE sch.teacher_id = $1 AND sch.school_id = $2 ORDER BY sch.day_of_week, sch.start_time`;
    const scheduleParams = req.user.role === 'superAdmin'
      ? [req.params.teacherId]
      : [req.params.teacherId, req.user.school_id];

    const result = await query(scheduleSql, scheduleParams);
    const data = result.rows.map((r) => ({ ...r, day_name: DAY_NAMES[r.day_of_week] || '' }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
