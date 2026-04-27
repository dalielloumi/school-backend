// ============================================================
// Master subject list — Tunisian curriculum
// applicable_for: which school types include this subject
// niveaux: which specific year levels this subject applies to
// ============================================================

const SUBJECTS_MASTER = [
  // ── PRIMAIRE ──────────────────────────────────────────────
  { nom: 'Arabe',                code: 'AR',    color: '#10B981', coefficient: 4, applicable_for: ['primaire','college','secondaire'], niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Français',             code: 'FR',    color: '#3B82F6', coefficient: 3, applicable_for: ['primaire','college','secondaire'], niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Mathématiques',        code: 'MATH',  color: '#6366F1', coefficient: 4, applicable_for: ['primaire','college','secondaire'], niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Éducation islamique',  code: 'ISLA',  color: '#F59E0B', coefficient: 2, applicable_for: ['primaire','college','secondaire'], niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec'] },
  { nom: 'Éducation civique',    code: 'CIVI',  color: '#8B5CF6', coefficient: 2, applicable_for: ['primaire','college'],             niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème'] },
  { nom: 'Éducation physique',   code: 'EPS',   color: '#EF4444', coefficient: 2, applicable_for: ['primaire','college','secondaire'], niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Éducation artistique', code: 'ART',   color: '#EC4899', coefficient: 1, applicable_for: ['primaire'],                       niveaux: ['1ère','2ème','3ème','4ème','5ème','6ème'] },
  { nom: 'Éveil scientifique',   code: 'EVSC',  color: '#14B8A6', coefficient: 2, applicable_for: ['primaire'],                       niveaux: ['1ère','2ème'] },
  { nom: 'Sciences',             code: 'SCI',   color: '#14B8A6', coefficient: 3, applicable_for: ['primaire'],                       niveaux: ['3ème','4ème','5ème','6ème'] },
  { nom: 'Histoire',             code: 'HIST',  color: '#92400E', coefficient: 2, applicable_for: ['primaire','college','secondaire'], niveaux: ['3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Géographie',           code: 'GEO',   color: '#065F46', coefficient: 2, applicable_for: ['primaire','college','secondaire'], niveaux: ['3ème','4ème','5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Anglais',              code: 'ANG',   color: '#1D4ED8', coefficient: 2, applicable_for: ['primaire','college','secondaire'], niveaux: ['5ème','6ème','7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },

  // ── COLLÈGE ───────────────────────────────────────────────
  { nom: 'SVT',                  code: 'SVT',   color: '#16A34A', coefficient: 3, applicable_for: ['college','secondaire'],            niveaux: ['7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Physique-Chimie',      code: 'PHY',   color: '#7C3AED', coefficient: 3, applicable_for: ['college','secondaire'],            niveaux: ['7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Technologie',          code: 'TECH',  color: '#0284C7', coefficient: 2, applicable_for: ['college','secondaire'],            niveaux: ['7ème','8ème','1ère sec'] },
  { nom: 'Informatique',         code: 'INFO',  color: '#0F766E', coefficient: 2, applicable_for: ['college','secondaire'],            niveaux: ['7ème','8ème','9ème','1ère sec','2ème sec','3ème sec','4ème sec'] },

  // ── SECONDAIRE ────────────────────────────────────────────
  { nom: 'Philosophie',          code: 'PHILO', color: '#6D28D9', coefficient: 2, applicable_for: ['secondaire'],                     niveaux: ['1ère sec','2ème sec','3ème sec','4ème sec'] },
  { nom: 'Économie',             code: 'ECO',   color: '#D97706', coefficient: 3, applicable_for: ['secondaire'],                     niveaux: ['2ème sec','3ème sec','4ème sec'] },
  { nom: 'Gestion',              code: 'GEST',  color: '#B45309', coefficient: 3, applicable_for: ['secondaire'],                     niveaux: ['2ème sec','3ème sec','4ème sec'] },
];

/**
 * Returns deduplicated subjects for the given school types
 * @param {string[]} types — e.g. ['primaire','college']
 */
function getSubjectsForTypes(types) {
  const seen = new Set();
  return SUBJECTS_MASTER.filter(s => {
    if (!s.applicable_for.some(t => types.includes(t))) return false;
    if (seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });
}

/**
 * Returns subjects applicable to a specific niveau
 * @param {string} niveau — e.g. '7ème', '2ème sec'
 */
function getSubjectsForNiveau(niveau) {
  return SUBJECTS_MASTER.filter(s => s.niveaux.includes(niveau));
}

module.exports = { SUBJECTS_MASTER, getSubjectsForTypes, getSubjectsForNiveau };
