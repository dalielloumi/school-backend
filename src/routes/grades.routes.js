const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendPush, getTokensForUsers } = require('../utils/fcm');

const GRADE_SELECT = `
  SELECT g.*,
         s.nom AS student_nom, s.prenom AS student_prenom,
         sub.nom AS subject_nom, sub.code AS subject_code, sub.coefficient,
         c.nom AS classe_nom,
         u.nom AS teacher_nom, u.prenom AS teacher_prenom
  FROM grades g
  JOIN students s ON s.id = g.student_id
  JOIN subjects sub ON sub.id = g.subject_id
  JOIN classes c ON c.id = g.classe_id
  JOIN users u ON u.id = g.teacher_id
`;

/**
 * Calculate average grades per subject for a result set
 */
function computeAverages(rows) {
  const byStudentSubject = {};
  for (const row of rows) {
    const key = `${row.student_id}_${row.subject_id}`;
    if (!byStudentSubject[key]) {
      byStudentSubject[key] = { sum: 0, count: 0 };
    }
    byStudentSubject[key].sum += parseFloat(row.valeur);
    byStudentSubject[key].count += 1;
  }
  return rows.map((row) => {
    const key = `${row.student_id}_${row.subject_id}`;
    const avg = byStudentSubject[key]
      ? (byStudentSubject[key].sum / byStudentSubject[key].count).toFixed(2)
      : null;
    return { ...row, moyenne_matiere: avg };
  });
}

// GET /api/grades  — with optional filters: student_id, classe_id, subject_id, trimestre, teacher_id
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { student_id, classe_id, subject_id, trimestre, teacher_id } = req.query;

    let sql = GRADE_SELECT;
    const params = [];
    const conditions = [];

    // Scope by school_id (superAdmin exempt)
    if (req.user.role !== 'superAdmin') {
      params.push(req.user.school_id);
      conditions.push(`g.school_id = $${params.length}`);
    }

    // Role-based restrictions
    if (req.user.role === 'teacher') {
      params.push(req.user.id);
      conditions.push(`g.teacher_id = $${params.length}`);
    } else if (req.user.role === 'parent') {
      // Parent only sees their child's grades
      const childResult = await query(
        'SELECT id FROM students WHERE parent_id = $1 AND school_id = $2',
        [req.user.id, req.user.school_id]
      );
      const childIds = childResult.rows.map((r) => r.id);
      if (childIds.length === 0) {
        return res.json({ success: true, data: [] });
      }
      params.push(childIds);
      conditions.push(`g.student_id = ANY($${params.length})`);
    }

    if (student_id) { params.push(student_id); conditions.push(`g.student_id = $${params.length}`); }
    if (classe_id)  { params.push(classe_id);  conditions.push(`g.classe_id = $${params.length}`); }
    if (subject_id) { params.push(subject_id); conditions.push(`g.subject_id = $${params.length}`); }
    if (trimestre)  { params.push(trimestre);  conditions.push(`g.trimestre = $${params.length}`); }
    if (teacher_id && req.user.role !== 'teacher') {
      params.push(teacher_id);
      conditions.push(`g.teacher_id = $${params.length}`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY g.date DESC, g.created_at DESC';

    const result = await query(sql, params);
    res.json({ success: true, data: computeAverages(result.rows) });
  } catch (err) {
    next(err);
  }
});

// GET /api/grades/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const gradeSql = req.user.role === 'superAdmin'
      ? `${GRADE_SELECT} WHERE g.id = $1`
      : `${GRADE_SELECT} WHERE g.id = $1 AND g.school_id = $2`;
    const gradeParams = req.user.role === 'superAdmin'
      ? [req.params.id]
      : [req.params.id, req.user.school_id];

    const result = await query(gradeSql, gradeParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Grade not found' });
    }

    const grade = result.rows[0];

    if (req.user.role === 'parent') {
      const child = await query('SELECT id FROM students WHERE id = $1 AND parent_id = $2', [grade.student_id, req.user.id]);
      if (child.rows.length === 0) return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (req.user.role === 'teacher' && grade.teacher_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: grade });
  } catch (err) {
    next(err);
  }
});

// POST /api/grades  — teacher, admin+
router.post(
  '/',
  authenticate,
  authorize('teacher', 'admin', 'superAdmin'),
  [
    body('student_id').isInt().withMessage('student_id required'),
    body('subject_id').isInt().withMessage('subject_id required'),
    body('classe_id').isInt().withMessage('classe_id required'),
    body('valeur').isFloat({ min: 0, max: 20 }).withMessage('Grade must be 0–20'),
    body('trimestre').isInt({ min: 1, max: 3 }).withMessage('Trimestre must be 1, 2, or 3'),
    body('type').isIn(['devoir', 'examen', 'tp']).withMessage('Type must be devoir, examen, or tp'),
  ],
  async (req, res, next) => {
    const client = await getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { student_id, subject_id, classe_id, valeur, type, date, comment, trimestre } = req.body;
      const teacher_id = req.user.role === 'teacher' ? req.user.id : (req.body.teacher_id || req.user.id);
      const school_id = req.user.school_id;

      await client.query('BEGIN');

      const gradeResult = await client.query(
        `INSERT INTO grades (school_id, student_id, subject_id, classe_id, teacher_id, valeur, type, date, comment, trimestre)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [school_id, student_id, subject_id, classe_id, teacher_id, valeur, type, date || new Date(), comment || null, trimestre]
      );

      const grade = gradeResult.rows[0];

      // Auto-notify parent
      const studentResult = await client.query(
        'SELECT s.nom, s.prenom, s.parent_id, sub.nom AS subject_nom FROM students s JOIN subjects sub ON sub.id = $2 WHERE s.id = $1',
        [student_id, subject_id]
      );

      if (studentResult.rows.length > 0) {
        const student = studentResult.rows[0];
        if (student.parent_id) {
          await client.query(
            `INSERT INTO notifications (user_id, title, message, type, data)
             VALUES ($1, $2, $3, 'grade', $4)`,
            [
              student.parent_id,
              'Nouvelle note',
              `${student.prenom} ${student.nom} a obtenu ${valeur}/20 en ${student.subject_nom} (${type})`,
              JSON.stringify({ grade_id: grade.id, student_id, subject_id, valeur, type, trimestre }),
            ]
          );
          const tokens = await getTokensForUsers([student.parent_id]);
          await sendPush(tokens, `⭐ Nouvelle note`, `${student.prenom} ${student.nom} a obtenu ${valeur}/20 en ${student.subject_nom}`, { type: 'grade', grade_id: String(grade.id) });
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ success: true, data: grade });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// PUT /api/grades/:id  — teacher (own), admin+
router.put('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM grades WHERE id = $1'
      : 'SELECT * FROM grades WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Grade not found' });
    }

    if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Cannot edit another teacher\'s grade' });
    }

    const { valeur, type, date, comment, trimestre } = req.body;

    const result = await query(
      `UPDATE grades SET
         valeur = COALESCE($1, valeur),
         type = COALESCE($2::grade_type, type),
         date = COALESCE($3, date),
         comment = COALESCE($4, comment),
         trimestre = COALESCE($5, trimestre)
       WHERE id = $6 RETURNING *`,
      [valeur, type, date, comment, trimestre, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/grades/:id  — teacher (own), admin+
router.delete('/:id', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const checkSql = req.user.role === 'superAdmin'
      ? 'SELECT * FROM grades WHERE id = $1'
      : 'SELECT * FROM grades WHERE id = $1 AND school_id = $2';
    const checkParams = req.user.role === 'superAdmin' ? [id] : [id, req.user.school_id];

    const check = await query(checkSql, checkParams);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Grade not found' });
    }

    if (req.user.role === 'teacher' && check.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Cannot delete another teacher\'s grade' });
    }

    await query('DELETE FROM grades WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Grade deleted', id: parseInt(id) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/grades/bulletin/:studentId?trimestre=N  — full bulletin scolaire
router.get('/bulletin/:studentId', authenticate, async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { trimestre } = req.query;

    // Access check
    if (req.user.role === 'parent') {
      const child = await query(
        'SELECT id FROM students WHERE id = $1 AND parent_id = $2',
        [studentId, req.user.id]
      );
      if (child.rows.length === 0)
        return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    const schoolId = req.user.role === 'superAdmin' ? null : req.user.school_id;

    // Student + school info
    const studentResult = await query(
      `SELECT s.id, s.nom, s.prenom, s.date_naissance,
              c.id AS classe_id, c.nom AS classe_nom, c.niveau AS classe_niveau,
              sc.nom AS school_nom
       FROM students s
       JOIN classes c ON c.id = s.classe_id
       JOIN schools sc ON sc.id = s.school_id
       WHERE s.id = $1 ${schoolId ? 'AND s.school_id = $2' : ''}`,
      schoolId ? [studentId, schoolId] : [studentId]
    );

    if (studentResult.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Élève introuvable' });

    const student = studentResult.rows[0];

    // Grades per subject for this student + trimestre
    const gradesSql = `
      SELECT g.id, g.valeur, g.type, g.date, g.comment, g.trimestre,
             sub.id AS subject_id, sub.nom AS subject_nom,
             sub.coefficient, sub.color
      FROM grades g
      JOIN subjects sub ON sub.id = g.subject_id
      WHERE g.student_id = $1
      ${trimestre ? 'AND g.trimestre = $2' : ''}
      ORDER BY sub.nom, g.date
    `;
    const gradesSqlParams = trimestre ? [studentId, trimestre] : [studentId];
    const gradesResult = await query(gradesSql, gradesSqlParams);

    // Group grades by subject
    const subjectMap = {};
    for (const row of gradesResult.rows) {
      const sid = row.subject_id;
      if (!subjectMap[sid]) {
        subjectMap[sid] = {
          subject_id: sid,
          subject_nom: row.subject_nom,
          coefficient: parseFloat(row.coefficient),
          color: row.color,
          grades: [],
        };
      }
      subjectMap[sid].grades.push({
        id: row.id,
        valeur: parseFloat(row.valeur),
        type: row.type,
        date: row.date,
        comment: row.comment,
        trimestre: row.trimestre,
      });
    }

    // Compute moyenne per subject
    const subjects = Object.values(subjectMap).map((s) => {
      const sum = s.grades.reduce((acc, g) => acc + g.valeur, 0);
      const moyenne = s.grades.length > 0 ? sum / s.grades.length : null;
      return { ...s, moyenne: moyenne !== null ? parseFloat(moyenne.toFixed(2)) : null };
    });

    // Weighted moyenne générale for this student
    let totalCoeff = 0;
    let weightedSum = 0;
    for (const s of subjects) {
      if (s.moyenne !== null) {
        totalCoeff += s.coefficient;
        weightedSum += s.moyenne * s.coefficient;
      }
    }
    const moyenneGenerale = totalCoeff > 0 ? parseFloat((weightedSum / totalCoeff).toFixed(2)) : null;

    // Rank in class — compare with all classmates (same trimestre)
    const classmatesResult = await query(
      `SELECT g.student_id,
              SUM(g.valeur * sub.coefficient) / NULLIF(SUM(sub.coefficient), 0) AS moy_gen
       FROM grades g
       JOIN subjects sub ON sub.id = g.subject_id
       WHERE g.classe_id = $1 ${trimestre ? 'AND g.trimestre = $2' : ''}
       GROUP BY g.student_id`,
      trimestre ? [student.classe_id, trimestre] : [student.classe_id]
    );

    const sortedMoyennes = classmatesResult.rows
      .map((r) => parseFloat(parseFloat(r.moy_gen).toFixed(2)))
      .filter((m) => !isNaN(m))
      .sort((a, b) => b - a);

    const rank = moyenneGenerale !== null
      ? sortedMoyennes.findIndex((m) => m <= moyenneGenerale) + 1
      : null;
    const totalStudents = classmatesResult.rows.length;

    // Absences count (total for the year)
    const absencesResult = await query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE justified = true) AS justifiees
       FROM absences
       WHERE student_id = $1`,
      [studentId]
    );

    const absences = absencesResult.rows[0];

    res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          nom: student.nom,
          prenom: student.prenom,
          date_naissance: student.date_naissance,
          classe_nom: student.classe_nom,
          classe_niveau: student.classe_niveau,
        },
        school_nom: student.school_nom,
        trimestre: trimestre ? parseInt(trimestre) : null,
        subjects: subjects.sort((a, b) => a.subject_nom.localeCompare(b.subject_nom)),
        moyenne_generale: moyenneGenerale,
        rank,
        total_students: totalStudents,
        nb_absences: parseInt(absences.total),
        nb_absences_justifiees: parseInt(absences.justifiees),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/grades/student/:studentId/average  — average per subject per trimestre
router.get('/student/:studentId/average', authenticate, async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { trimestre } = req.query;

    if (req.user.role === 'parent') {
      const child = await query('SELECT id FROM students WHERE id = $1 AND parent_id = $2', [studentId, req.user.id]);
      if (child.rows.length === 0) return res.status(403).json({ success: false, message: 'Access denied' });
    }

    let sql = `
      SELECT sub.id AS subject_id, sub.nom AS subject_nom, sub.coefficient,
             g.trimestre,
             ROUND(AVG(g.valeur), 2) AS moyenne,
             COUNT(g.id) AS nb_notes
      FROM grades g
      JOIN subjects sub ON sub.id = g.subject_id
      WHERE g.student_id = $1 AND g.school_id = $2
    `;
    const params = [studentId, req.user.school_id];

    if (trimestre) {
      params.push(trimestre);
      sql += ` AND g.trimestre = $${params.length}`;
    }

    sql += ' GROUP BY sub.id, sub.nom, sub.coefficient, g.trimestre ORDER BY sub.nom, g.trimestre';

    const result = await query(sql, params);

    // Weighted overall average
    let totalCoeff = 0;
    let weightedSum = 0;
    const seen = new Set();
    for (const row of result.rows) {
      const key = `${row.subject_id}_${row.trimestre}`;
      if (!seen.has(key)) {
        seen.add(key);
        totalCoeff += parseFloat(row.coefficient);
        weightedSum += parseFloat(row.moyenne) * parseFloat(row.coefficient);
      }
    }
    const moyenneGenerale = totalCoeff > 0 ? (weightedSum / totalCoeff).toFixed(2) : null;

    res.json({ success: true, data: { averages: result.rows, moyenne_generale: moyenneGenerale } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
