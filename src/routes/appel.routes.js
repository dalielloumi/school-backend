const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

// ─────────────────────────────────────────────────────────────
// GET /api/appel/parent-records — parent sees child's absent/exclu records
// ─────────────────────────────────────────────────────────────
router.get('/parent-records', authenticate, async (req, res, next) => {
  try {
    let studentIds;
    if (req.user.role === 'parent') {
      const childResult = await query(
        'SELECT id FROM students WHERE parent_id = $1',
        [req.user.id]
      );
      studentIds = childResult.rows.map(r => r.id);
      if (studentIds.length === 0) return res.json({ success: true, data: [] });
    } else if (req.query.student_id) {
      studentIds = [parseInt(req.query.student_id)];
    } else {
      return res.status(400).json({ success: false, message: 'student_id required' });
    }

    const result = await query(
      `SELECT a.student_id, a.date, a.session, a.status,
              TO_CHAR(a.updated_at, 'HH24:MI') AS time_str,
              cl.nom AS classe_nom
       FROM appel a
       JOIN classes cl ON cl.id = a.classe_id
       WHERE a.student_id = ANY($1)
         AND a.status IN ('absent', 'exclu')
       ORDER BY a.date DESC, a.updated_at DESC`,
      [studentIds]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/appel?classe_id=&date=&session=
// Returns existing records for this session.
// For students with no record yet, pre-fills from their LAST session:
//   - last status was absent/exclu  → pre-fill as 'absent'
//   - last status was present        → pre-fill as 'present'
//   - no previous record at all      → pre-fill as 'present'
// ─────────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('admin', 'teacher'), async (req, res, next) => {
  try {
    const { classe_id, date, session } = req.query;
    if (!classe_id || !date || !session) {
      return res.status(400).json({ success: false, message: 'classe_id, date and session required' });
    }

    const school_id = req.user.school_id;

    // 1. All students in this class
    const studentsResult = await query(
      `SELECT s.id, s.nom, s.prenom
       FROM students s
       WHERE s.classe_id = $1 AND s.school_id = $2
       ORDER BY s.nom, s.prenom`,
      [classe_id, school_id]
    );

    if (studentsResult.rows.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const studentIds = studentsResult.rows.map(s => s.id);

    // 2. Existing records for this exact session
    const existingResult = await query(
      `SELECT student_id, status, teacher_id, updated_at
       FROM appel
       WHERE classe_id = $1 AND date = $2 AND session = $3
         AND student_id = ANY($4)`,
      [classe_id, date, session, studentIds]
    );
    const existingMap = {};
    for (const row of existingResult.rows) {
      existingMap[row.student_id] = { status: row.status, teacher_id: row.teacher_id, updated_at: row.updated_at, is_existing: true };
    }

    // 3. For students not yet recorded, fetch their LAST status before this date
    const unrecordedIds = studentIds.filter(id => !existingMap[id]);
    const lastStatusMap = {};

    if (unrecordedIds.length > 0) {
      const lastResult = await query(
        `SELECT DISTINCT ON (student_id)
           student_id, status
         FROM appel
         WHERE student_id = ANY($1)
           AND (date < $2 OR (date = $2 AND session = 'Matin' AND $3 = 'Après-midi'))
         ORDER BY student_id, date DESC, session DESC`,
        [unrecordedIds, date, session]
      );
      for (const row of lastResult.rows) {
        // absent or exclu → pre-fill as absent; present → pre-fill as present
        lastStatusMap[row.student_id] = (row.status === 'present') ? 'present' : 'absent';
      }
    }

    // 4. Build response
    const data = studentsResult.rows.map(s => {
      if (existingMap[s.id]) {
        return {
          student_id: s.id,
          nom: s.nom,
          prenom: s.prenom,
          status: existingMap[s.id].status,
          is_existing: true,
          updated_at: existingMap[s.id].updated_at,
        };
      }
      // Pre-fill: if last status was absent/exclu → absent, else present (fresh start)
      const prefill = lastStatusMap[s.id] ?? null; // null = no prior record
      return {
        student_id: s.id,
        nom: s.nom,
        prenom: s.prenom,
        status: prefill === 'absent' ? 'absent' : 'present',
        is_existing: false,
        prefilled_absent: prefill === 'absent', // flag so UI can highlight
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/appel/bulk  — upsert full class attendance
// Body: { classe_id, date, session, records: [{student_id, status}] }
// ─────────────────────────────────────────────────────────────
router.post('/bulk', authenticate, authorize('admin', 'teacher'), async (req, res, next) => {
  try {
    const { classe_id, date, session, records } = req.body;
    if (!classe_id || !date || !session || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const school_id = req.user.school_id;
    const teacher_id = req.user.id;
    const validStatuses = ['present', 'absent', 'exclu'];

    const studentIds = records.filter(r => r.student_id).map(r => r.student_id);

    // Capture statuses before upsert to detect changes
    const existingResult = studentIds.length > 0
      ? await query(
          `SELECT student_id, status FROM appel
           WHERE classe_id = $1 AND date = $2 AND session = $3 AND student_id = ANY($4)`,
          [classe_id, date, session, studentIds]
        )
      : { rows: [] };
    const prevStatusMap = {};
    for (const row of existingResult.rows) {
      prevStatusMap[row.student_id] = row.status;
    }

    for (const r of records) {
      if (!r.student_id || !validStatuses.includes(r.status)) continue;
      await query(
        `INSERT INTO appel (school_id, student_id, classe_id, teacher_id, date, session, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (student_id, date, session, classe_id)
         DO UPDATE SET status = EXCLUDED.status, teacher_id = EXCLUDED.teacher_id, updated_at = NOW()`,
        [school_id, r.student_id, classe_id, teacher_id, date, session, r.status]
      );
    }

    // Notify parents only when a student is newly marked absent/exclu
    const toNotify = records.filter(r => {
      if (!r.student_id || !validStatuses.includes(r.status)) return false;
      if (r.status === 'present') return false;
      const prev = prevStatusMap[r.student_id];
      return prev === undefined || prev === 'present';
    });

    if (toNotify.length > 0) {
      const notifyIds = toNotify.map(r => r.student_id);
      const studentsResult = await query(
        `SELECT s.id, s.nom, s.prenom, s.parent_id
         FROM students s
         WHERE s.id = ANY($1) AND s.parent_id IS NOT NULL`,
        [notifyIds]
      );
      for (const student of studentsResult.rows) {
        const record = toNotify.find(r => r.student_id === student.id);
        const statusLabel = record.status === 'exclu' ? 'exclu(e)' : 'absent(e)';
        const msg = `Votre enfant ${student.prenom} ${student.nom} était ${statusLabel} le ${date}`;
        await query(
          `INSERT INTO notifications (user_id, school_id, title, message, type, data)
           VALUES ($1, $2, $3, $4, 'absence', $5)`,
          [student.parent_id, school_id, 'Absence signalée', msg,
           JSON.stringify({ student_id: student.id, date, session })]
        );
        const tokens = await getTokensForUsers([student.parent_id]);
        if (tokens.length) {
          await sendPush(tokens, '⚠️ Absence signalée', msg, { type: 'absence' });
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/appel/:studentId  — update single student status
// Body: { classe_id, date, session, status }
// ─────────────────────────────────────────────────────────────
router.patch('/:studentId', authenticate, authorize('admin', 'teacher'), async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { classe_id, date, session, status } = req.body;
    const validStatuses = ['present', 'absent', 'exclu'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const school_id = req.user.school_id;
    const teacher_id = req.user.id;

    await query(
      `INSERT INTO appel (school_id, student_id, classe_id, teacher_id, date, session, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (student_id, date, session, classe_id)
       DO UPDATE SET status = EXCLUDED.status, teacher_id = EXCLUDED.teacher_id, updated_at = NOW()`,
      [school_id, studentId, classe_id, teacher_id, date, session, status]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
