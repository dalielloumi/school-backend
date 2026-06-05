const router  = require('express').Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// genAI is created per-request so it always picks up the env var
function getGenAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server');
  return new GoogleGenerativeAI(key);
}

// ── Fetch all child data for AI context ─────────────────
async function fetchChildContext(parentId, studentId, schoolId) {
  // Verify parent owns this student
  const studentRes = await query(
    `SELECT s.id, s.nom, s.prenom, s.date_naissance,
            c.nom AS classe_nom, c.niveau AS classe_niveau
     FROM students s
     LEFT JOIN classes c ON c.id = s.classe_id
     WHERE s.id = $1 AND s.parent_id = $2 AND s.school_id = $3`,
    [studentId, parentId, schoolId]
  );
  if (studentRes.rows.length === 0) return null;
  const student = studentRes.rows[0];

  // Grades (last 20)
  const gradesRes = await query(
    `SELECT g.valeur, g.type, g.trimestre, g.date,
            sub.nom AS subject_nom
     FROM grades g
     JOIN subjects sub ON sub.id = g.subject_id
     WHERE g.student_id = $1
     ORDER BY g.date DESC LIMIT 20`,
    [studentId]
  );

  // Absences (last 30 days)
  const absencesRes = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE justified = true)  AS justifiees,
            COUNT(*) FILTER (WHERE justified = false) AS injustifiees
     FROM absences
     WHERE student_id = $1 AND date >= NOW() - INTERVAL '30 days'`,
    [studentId]
  );

  // Comportements (last 5)
  const comportRes = await query(
    `SELECT type, description, date
     FROM comportements
     WHERE student_id = $1
     ORDER BY date DESC LIMIT 5`,
    [studentId]
  );

  // Payments
  const paymentsRes = await query(
    `SELECT statut, montant, date_echeance
     FROM payments
     WHERE student_id = $1
     ORDER BY date_echeance DESC LIMIT 5`,
    [studentId]
  );

  // Pending exercises
  const exercicesRes = await query(
    `SELECT ex.titre, ex.date_limite, sub.nom AS subject_nom
     FROM exercices ex
     JOIN subjects sub ON sub.id = ex.subject_id
     JOIN students st ON st.classe_id = ex.classe_id
     WHERE st.id = $1 AND ex.date_limite >= NOW()
     ORDER BY ex.date_limite ASC LIMIT 5`,
    [studentId]
  );

  // Average per subject
  const avgRes = await query(
    `SELECT sub.nom AS subject_nom,
            ROUND(AVG(g.valeur), 2) AS moyenne
     FROM grades g
     JOIN subjects sub ON sub.id = g.subject_id
     WHERE g.student_id = $1
     GROUP BY sub.nom
     ORDER BY sub.nom`,
    [studentId]
  );

  return { student, grades: gradesRes.rows, absences: absencesRes.rows[0],
           comportements: comportRes.rows, payments: paymentsRes.rows,
           exercices: exercicesRes.rows, averages: avgRes.rows };
}

// ── Build system prompt ──────────────────────────────────
function buildSystemPrompt(ctx) {
  const { student, grades, absences, comportements, payments, exercices, averages } = ctx;
  const fullName = `${student.prenom} ${student.nom}`;

  const avgText = averages.length > 0
    ? averages.map(a => `  - ${a.subject_nom}: ${a.moyenne}/20`).join('\n')
    : '  Aucune note disponible.';

  const recentGrades = grades.length > 0
    ? grades.slice(0, 5).map(g => `  - ${g.subject_nom}: ${g.valeur}/20 (${g.type}, T${g.trimestre})`).join('\n')
    : '  Aucune note récente.';

  const absText = `${absences.total} absence(s) ce mois (${absences.justifiees} justifiée(s), ${absences.injustifiees} injustifiée(s))`;

  const comportText = comportements.length > 0
    ? comportements.map(c => `  - [${c.type}] ${c.description || ''}`).join('\n')
    : '  Aucun rapport de comportement récent.';

  const payText = payments.length > 0
    ? payments.map(p => `  - ${p.montant} DT — ${p.statut} (échéance: ${new Date(p.date_echeance).toLocaleDateString('fr-FR')})`).join('\n')
    : '  Aucune information de paiement.';

  const exText = exercices.length > 0
    ? exercices.map(e => `  - ${e.subject_nom}: "${e.titre}" (à rendre le ${new Date(e.date_limite).toLocaleDateString('fr-FR')})`).join('\n')
    : '  Aucun devoir en attente.';

  return `Tu es un assistant scolaire intelligent intégré dans la plateforme علّمني (Allamni).
Tu aides les parents à comprendre et suivre la situation scolaire de leur enfant.
Réponds toujours en français, de manière claire, bienveillante, concise et encourageante.
Ne donne que des informations basées sur les données fournies. Si tu ne sais pas, dis-le honnêtement.

═══ DONNÉES DE L'ÉLÈVE ═══

Nom complet  : ${fullName}
Classe       : ${student.classe_nom || 'Non assigné'} (${student.classe_niveau || ''})

MOYENNES PAR MATIÈRE :
${avgText}

NOTES RÉCENTES :
${recentGrades}

ABSENCES (30 derniers jours) :
  ${absText}

COMPORTEMENT :
${comportText}

DEVOIRS EN ATTENTE :
${exText}

PAIEMENTS :
${payText}
═══════════════════════════

Réponds de façon naturelle et personnalisée en utilisant le prénom "${student.prenom}".`;
}

// ── POST /api/ai/chat ────────────────────────────────────
router.post('/chat', authenticate, authorize('parent'), async (req, res, next) => {
  try {
    const { message, student_id, history = [] } = req.body;

    if (!message || !student_id) {
      return res.status(400).json({ success: false, message: 'message et student_id requis' });
    }

    const ctx = await fetchChildContext(req.user.id, student_id, req.user.school_id);
    if (!ctx) {
      return res.status(403).json({ success: false, message: 'Élève introuvable ou accès refusé' });
    }

    const model = getGenAI().getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    // Inject system prompt as first turn of history
    const systemTurn = [
      { role: 'user',  parts: [{ text: buildSystemPrompt(ctx) }] },
      { role: 'model', parts: [{ text: 'Compris ! Je suis prêt à vous aider.' }] },
    ];

    const geminiHistory = [
      ...systemTurn,
      ...history.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      })),
    ];

    const chat = model.startChat({
      history: geminiHistory,
      generationConfig: { maxOutputTokens: 1024 },
    });

    const result = await chat.sendMessage(message);
    const reply  = result.response.text();

    res.json({ success: true, data: { reply, student: ctx.student } });
  } catch (err) {
    console.error('[AI] Error:', err?.message || err);
    res.status(500).json({ success: false, message: err?.message || 'AI error', detail: err?.toString() });
  }
});

module.exports = router;
