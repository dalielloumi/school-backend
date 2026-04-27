const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/dashboard  — admin/superAdmin dashboard stats
router.get('/', authenticate, authorize('admin', 'superAdmin'), async (req, res, next) => {
  try {
    const school_id = req.user.school_id; // null for superAdmin

    // Auto-refresh late payments for this school
    if (school_id) {
      await query(
        "UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE AND school_id = $1",
        [school_id]
      );
    } else {
      await query("UPDATE payments SET statut = 'enRetard' WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE");
    }

    const [
      studentsResult,
      teachersResult,
      classesResult,
      absencesMonthResult,
      paymentsMonthResult,
      unpaidResult,
      recentAbsencesResult,
      recentGradesResult,
      latePaymentsResult,
    ] = await Promise.all([
      school_id
        ? query('SELECT COUNT(*) AS total FROM students WHERE school_id = $1', [school_id])
        : query('SELECT COUNT(*) AS total FROM students'),

      school_id
        ? query("SELECT COUNT(*) AS total FROM users WHERE role = 'teacher' AND is_active = TRUE AND school_id = $1", [school_id])
        : query("SELECT COUNT(*) AS total FROM users WHERE role = 'teacher' AND is_active = TRUE"),

      school_id
        ? query('SELECT COUNT(*) AS total FROM classes WHERE school_id = $1', [school_id])
        : query('SELECT COUNT(*) AS total FROM classes'),

      school_id
        ? query(
            `SELECT COUNT(*) AS total FROM absences
             WHERE school_id = $1
               AND date_trunc('month', date) = date_trunc('month', CURRENT_DATE)`,
            [school_id]
          )
        : query(
            `SELECT COUNT(*) AS total FROM absences
             WHERE date_trunc('month', date) = date_trunc('month', CURRENT_DATE)`
          ),

      school_id
        ? query(
            `SELECT COALESCE(SUM(montant), 0) AS total, COUNT(*) AS count FROM payments
             WHERE school_id = $1 AND statut = 'paye'
               AND date_trunc('month', date_paiement) = date_trunc('month', CURRENT_DATE)`,
            [school_id]
          )
        : query(
            `SELECT COALESCE(SUM(montant), 0) AS total, COUNT(*) AS count FROM payments
             WHERE statut = 'paye'
               AND date_trunc('month', date_paiement) = date_trunc('month', CURRENT_DATE)`
          ),

      school_id
        ? query("SELECT COUNT(*) AS total FROM payments WHERE school_id = $1 AND statut != 'paye'", [school_id])
        : query("SELECT COUNT(*) AS total FROM payments WHERE statut != 'paye'"),

      school_id
        ? query(
            `SELECT a.*, s.nom AS student_nom, s.prenom AS student_prenom, c.nom AS classe_nom
             FROM absences a
             JOIN students s ON s.id = a.student_id
             JOIN classes c ON c.id = a.classe_id
             WHERE a.school_id = $1
             ORDER BY a.created_at DESC LIMIT 5`,
            [school_id]
          )
        : query(
            `SELECT a.*, s.nom AS student_nom, s.prenom AS student_prenom, c.nom AS classe_nom
             FROM absences a
             JOIN students s ON s.id = a.student_id
             JOIN classes c ON c.id = a.classe_id
             ORDER BY a.created_at DESC LIMIT 5`
          ),

      school_id
        ? query(
            `SELECT g.*, s.nom AS student_nom, s.prenom AS student_prenom,
                    sub.nom AS subject_nom, c.nom AS classe_nom
             FROM grades g
             JOIN students s ON s.id = g.student_id
             JOIN subjects sub ON sub.id = g.subject_id
             JOIN classes c ON c.id = g.classe_id
             WHERE g.school_id = $1
             ORDER BY g.created_at DESC LIMIT 5`,
            [school_id]
          )
        : query(
            `SELECT g.*, s.nom AS student_nom, s.prenom AS student_prenom,
                    sub.nom AS subject_nom, c.nom AS classe_nom
             FROM grades g
             JOIN students s ON s.id = g.student_id
             JOIN subjects sub ON sub.id = g.subject_id
             JOIN classes c ON c.id = g.classe_id
             ORDER BY g.created_at DESC LIMIT 5`
          ),

      school_id
        ? query(
            `SELECT p.*, s.nom AS student_nom, s.prenom AS student_prenom, c.nom AS classe_nom
             FROM payments p
             JOIN students s ON s.id = p.student_id
             JOIN classes c ON c.id = p.classe_id
             WHERE p.statut = 'enRetard' AND p.school_id = $1
             ORDER BY p.date_echeance ASC LIMIT 5`,
            [school_id]
          )
        : query(
            `SELECT p.*, s.nom AS student_nom, s.prenom AS student_prenom, c.nom AS classe_nom
             FROM payments p
             JOIN students s ON s.id = p.student_id
             JOIN classes c ON c.id = p.classe_id
             WHERE p.statut = 'enRetard'
             ORDER BY p.date_echeance ASC LIMIT 5`
          ),
    ]);

    // Per-class stats — scoped by school
    const classStatsResult = school_id
      ? await query(
          `SELECT c.id, c.nom, c.niveau, c.total_students,
                  COUNT(DISTINCT a.id) FILTER (WHERE date_trunc('month', a.date) = date_trunc('month', CURRENT_DATE)) AS absences_month,
                  ROUND(AVG(g.valeur), 2) AS moyenne_generale
           FROM classes c
           LEFT JOIN absences a ON a.classe_id = c.id
           LEFT JOIN grades g ON g.classe_id = c.id
           WHERE c.school_id = $1
           GROUP BY c.id, c.nom, c.niveau, c.total_students
           ORDER BY c.nom`,
          [school_id]
        )
      : await query(
          `SELECT c.id, c.nom, c.niveau, c.total_students,
                  COUNT(DISTINCT a.id) FILTER (WHERE date_trunc('month', a.date) = date_trunc('month', CURRENT_DATE)) AS absences_month,
                  ROUND(AVG(g.valeur), 2) AS moyenne_generale
           FROM classes c
           LEFT JOIN absences a ON a.classe_id = c.id
           LEFT JOIN grades g ON g.classe_id = c.id
           GROUP BY c.id, c.nom, c.niveau, c.total_students
           ORDER BY c.nom`
        );

    res.json({
      success: true,
      data: {
        stats: {
          total_students: parseInt(studentsResult.rows[0].total),
          total_teachers: parseInt(teachersResult.rows[0].total),
          total_classes: parseInt(classesResult.rows[0].total),
          absences_this_month: parseInt(absencesMonthResult.rows[0].total),
          payments_this_month: {
            total: parseFloat(paymentsMonthResult.rows[0].total),
            count: parseInt(paymentsMonthResult.rows[0].count),
          },
          unpaid_count: parseInt(unpaidResult.rows[0].total),
        },
        recent_absences: recentAbsencesResult.rows,
        recent_grades: recentGradesResult.rows,
        late_payments: latePaymentsResult.rows,
        class_stats: classStatsResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/teacher  — teacher's own dashboard
router.get('/teacher', authenticate, authorize('teacher', 'admin', 'superAdmin'), async (req, res, next) => {
  try {
    const teacherId = req.user.role === 'teacher' ? req.user.id : (req.query.teacher_id || req.user.id);
    const school_id = req.user.school_id;

    const [
      classesResult,
      studentsResult,
      absencesResult,
      gradesResult,
      coursResult,
      exercicesResult,
    ] = await Promise.all([
      school_id
        ? query(
            `SELECT c.* FROM classes c
             JOIN teacher_classes tc ON tc.classe_id = c.id
             WHERE tc.teacher_id = $1 AND c.school_id = $2
             ORDER BY c.nom`,
            [teacherId, school_id]
          )
        : query(
            `SELECT c.* FROM classes c
             JOIN teacher_classes tc ON tc.classe_id = c.id
             WHERE tc.teacher_id = $1 ORDER BY c.nom`,
            [teacherId]
          ),

      school_id
        ? query(
            `SELECT COUNT(DISTINCT s.id) AS total FROM students s
             JOIN teacher_classes tc ON tc.classe_id = s.classe_id
             WHERE tc.teacher_id = $1 AND s.school_id = $2`,
            [teacherId, school_id]
          )
        : query(
            `SELECT COUNT(DISTINCT s.id) AS total FROM students s
             JOIN teacher_classes tc ON tc.classe_id = s.classe_id
             WHERE tc.teacher_id = $1`,
            [teacherId]
          ),

      school_id
        ? query(
            `SELECT COUNT(*) AS total FROM absences
             WHERE teacher_id = $1 AND school_id = $2
               AND date_trunc('month', date) = date_trunc('month', CURRENT_DATE)`,
            [teacherId, school_id]
          )
        : query(
            `SELECT COUNT(*) AS total FROM absences
             WHERE teacher_id = $1
               AND date_trunc('month', date) = date_trunc('month', CURRENT_DATE)`,
            [teacherId]
          ),

      school_id
        ? query(
            `SELECT g.*, s.nom AS student_nom, s.prenom AS student_prenom, sub.nom AS subject_nom
             FROM grades g
             JOIN students s ON s.id = g.student_id
             JOIN subjects sub ON sub.id = g.subject_id
             WHERE g.teacher_id = $1 AND g.school_id = $2
             ORDER BY g.created_at DESC LIMIT 10`,
            [teacherId, school_id]
          )
        : query(
            `SELECT g.*, s.nom AS student_nom, s.prenom AS student_prenom, sub.nom AS subject_nom
             FROM grades g
             JOIN students s ON s.id = g.student_id
             JOIN subjects sub ON sub.id = g.subject_id
             WHERE g.teacher_id = $1
             ORDER BY g.created_at DESC LIMIT 10`,
            [teacherId]
          ),

      school_id
        ? query(
            `SELECT co.*, c.nom AS classe_nom, sub.nom AS subject_nom
             FROM cours co
             JOIN classes c ON c.id = co.classe_id
             JOIN subjects sub ON sub.id = co.subject_id
             WHERE co.teacher_id = $1 AND co.school_id = $2
             ORDER BY co.date_publication DESC LIMIT 5`,
            [teacherId, school_id]
          )
        : query(
            `SELECT co.*, c.nom AS classe_nom, sub.nom AS subject_nom
             FROM cours co
             JOIN classes c ON c.id = co.classe_id
             JOIN subjects sub ON sub.id = co.subject_id
             WHERE co.teacher_id = $1
             ORDER BY co.date_publication DESC LIMIT 5`,
            [teacherId]
          ),

      school_id
        ? query(
            `SELECT ex.*, c.nom AS classe_nom, sub.nom AS subject_nom
             FROM exercices ex
             JOIN classes c ON c.id = ex.classe_id
             JOIN subjects sub ON sub.id = ex.subject_id
             WHERE ex.teacher_id = $1 AND ex.school_id = $2
             ORDER BY ex.date_publication DESC LIMIT 5`,
            [teacherId, school_id]
          )
        : query(
            `SELECT ex.*, c.nom AS classe_nom, sub.nom AS subject_nom
             FROM exercices ex
             JOIN classes c ON c.id = ex.classe_id
             JOIN subjects sub ON sub.id = ex.subject_id
             WHERE ex.teacher_id = $1
             ORDER BY ex.date_publication DESC LIMIT 5`,
            [teacherId]
          ),
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          total_classes: classesResult.rows.length,
          total_students: parseInt(studentsResult.rows[0].total),
          absences_this_month: parseInt(absencesResult.rows[0].total),
        },
        classes: classesResult.rows,
        recent_grades: gradesResult.rows,
        recent_cours: coursResult.rows,
        recent_exercices: exercicesResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/parent  — parent's child overview
router.get('/parent', authenticate, async (req, res, next) => {
  try {
    const parentId = req.user.role === 'parent' ? req.user.id : (req.query.parent_id || req.user.id);
    const school_id = req.user.school_id;

    if (req.user.role === 'parent' && parseInt(parentId) !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const childrenSql = school_id
      ? `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau
         FROM students s
         LEFT JOIN classes c ON c.id = s.classe_id
         WHERE s.parent_id = $1 AND s.school_id = $2`
      : `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau
         FROM students s
         LEFT JOIN classes c ON c.id = s.classe_id
         WHERE s.parent_id = $1`;
    const childrenParams = school_id ? [parentId, school_id] : [parentId];

    const childrenResult = await query(childrenSql, childrenParams);

    if (childrenResult.rows.length === 0) {
      return res.json({ success: true, data: { children: [], message: 'No children linked to this account' } });
    }

    const childrenData = await Promise.all(
      childrenResult.rows.map(async (child) => {
        const [gradesResult, absencesResult, paymentsResult, coursResult, exercicesResult] =
          await Promise.all([
            query(
              `SELECT g.*, sub.nom AS subject_nom, sub.coefficient
               FROM grades g
               JOIN subjects sub ON sub.id = g.subject_id
               WHERE g.student_id = $1
               ORDER BY g.date DESC LIMIT 10`,
              [child.id]
            ),
            query(
              `SELECT a.*, sub.nom AS subject_nom, c2.nom AS classe_nom
               FROM absences a
               LEFT JOIN subjects sub ON sub.id = a.subject_id
               LEFT JOIN classes c2 ON c2.id = a.classe_id
               WHERE a.student_id = $1
               ORDER BY a.date DESC LIMIT 10`,
              [child.id]
            ),
            query(
              'SELECT * FROM payments WHERE student_id = $1 ORDER BY date_echeance DESC LIMIT 6',
              [child.id]
            ),
            child.classe_id
              ? query(
                  `SELECT co.*, sub.nom AS subject_nom, u.nom AS teacher_nom, u.prenom AS teacher_prenom
                   FROM cours co
                   JOIN subjects sub ON sub.id = co.subject_id
                   JOIN users u ON u.id = co.teacher_id
                   WHERE co.classe_id = $1
                   ORDER BY co.date_publication DESC LIMIT 5`,
                  [child.classe_id]
                )
              : { rows: [] },
            child.classe_id
              ? query(
                  `SELECT ex.*, sub.nom AS subject_nom, u.nom AS teacher_nom, u.prenom AS teacher_prenom
                   FROM exercices ex
                   JOIN subjects sub ON sub.id = ex.subject_id
                   JOIN users u ON u.id = ex.teacher_id
                   WHERE ex.classe_id = $1
                   ORDER BY ex.date_publication DESC LIMIT 5`,
                  [child.classe_id]
                )
              : { rows: [] },
          ]);

        return {
          ...child,
          recent_grades: gradesResult.rows,
          recent_absences: absencesResult.rows,
          recent_payments: paymentsResult.rows,
          recent_cours: coursResult.rows,
          recent_exercices: exercicesResult.rows,
        };
      })
    );

    res.json({ success: true, data: { children: childrenData } });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/parent/child  — shorthand: single child info (first child)
router.get('/parent/child', authenticate, async (req, res, next) => {
  try {
    const parentId = req.user.role === 'parent' ? req.user.id : (req.query.parent_id || req.user.id);
    const school_id = req.user.school_id;

    const childSql = school_id
      ? `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau
         FROM students s
         LEFT JOIN classes c ON c.id = s.classe_id
         WHERE s.parent_id = $1 AND s.school_id = $2
         ORDER BY s.id LIMIT 1`
      : `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau
         FROM students s
         LEFT JOIN classes c ON c.id = s.classe_id
         WHERE s.parent_id = $1
         ORDER BY s.id LIMIT 1`;
    const childParams = school_id ? [parentId, school_id] : [parentId];

    const childResult = await query(childSql, childParams);

    if (childResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No child linked to this account' });
    }

    const child = childResult.rows[0];

    const [gradesResult, absencesResult, paymentsResult, coursResult, exercicesResult] =
      await Promise.all([
        query(
          `SELECT g.*, sub.nom AS subject_nom, sub.coefficient
           FROM grades g
           JOIN subjects sub ON sub.id = g.subject_id
           WHERE g.student_id = $1
           ORDER BY g.date DESC LIMIT 10`,
          [child.id]
        ),
        query(
          `SELECT a.*, sub.nom AS subject_nom
           FROM absences a
           LEFT JOIN subjects sub ON sub.id = a.subject_id
           WHERE a.student_id = $1
           ORDER BY a.date DESC LIMIT 10`,
          [child.id]
        ),
        query(
          'SELECT * FROM payments WHERE student_id = $1 ORDER BY date_echeance DESC LIMIT 6',
          [child.id]
        ),
        child.classe_id
          ? query(
              `SELECT co.*, sub.nom AS subject_nom, u.nom AS teacher_nom, u.prenom AS teacher_prenom
               FROM cours co
               JOIN subjects sub ON sub.id = co.subject_id
               JOIN users u ON u.id = co.teacher_id
               WHERE co.classe_id = $1
               ORDER BY co.date_publication DESC LIMIT 5`,
              [child.classe_id]
            )
          : { rows: [] },
        child.classe_id
          ? query(
              `SELECT ex.*, sub.nom AS subject_nom, u.nom AS teacher_nom, u.prenom AS teacher_prenom
               FROM exercices ex
               JOIN subjects sub ON sub.id = ex.subject_id
               JOIN users u ON u.id = ex.teacher_id
               WHERE ex.classe_id = $1
               ORDER BY ex.date_publication DESC LIMIT 5`,
              [child.classe_id]
            )
          : { rows: [] },
      ]);

    res.json({
      success: true,
      data: {
        child,
        recent_grades: gradesResult.rows,
        recent_absences: absencesResult.rows,
        recent_payments: paymentsResult.rows,
        recent_cours: coursResult.rows,
        recent_exercices: exercicesResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
