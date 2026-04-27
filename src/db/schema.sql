-- ============================================================
-- School Management System - PostgreSQL Schema
-- Multi-school architecture:
--   superAdmin (1) → creates Admin accounts (1 per school)
--   Admin (1/school) → creates Teacher + Parent accounts
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('superAdmin', 'admin', 'teacher', 'parent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE grade_type AS ENUM ('devoir', 'examen', 'tp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE session_type AS ENUM ('matin', 'apres_midi');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE notification_type AS ENUM ('absence', 'grade', 'general', 'message', 'exam', 'payment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE payment_frequence AS ENUM ('mensuelle', 'trimestrielle', 'annuelle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE payment_mode AS ENUM ('especes', 'cheque');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE payment_statut AS ENUM ('enAttente', 'paye', 'enRetard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE examen_type AS ENUM ('fin6eme', 'fin9eme', 'bac');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE examen_statut AS ENUM ('inscrit', 'enCours', 'passe', 'echoue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- SCHOOLS  (managed by superAdmin)
-- ============================================================

CREATE TABLE IF NOT EXISTS schools (
  id           SERIAL PRIMARY KEY,
  nom          VARCHAR(200) NOT NULL,
  adresse      TEXT,
  ville        VARCHAR(100),
  phone        VARCHAR(30),
  email        VARCHAR(255),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  school_types TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USERS
-- superAdmin: school_id IS NULL
-- admin/teacher/parent: school_id references their school
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  school_id      INT REFERENCES schools(id) ON DELETE CASCADE,
  nom            VARCHAR(100) NOT NULL,
  prenom         VARCHAR(100) NOT NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  role           user_role NOT NULL DEFAULT 'parent',
  phone          VARCHAR(30),
  avatar_url     TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- superAdmin has no school, others must have one
  CONSTRAINT chk_school_required CHECK (
    role = 'superAdmin' OR school_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_users_email     ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_school    ON users(school_id);

-- ============================================================
-- CLASSES  (scoped to school)
-- ============================================================

CREATE TABLE IF NOT EXISTS classes (
  id              SERIAL PRIMARY KEY,
  school_id       INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  nom             VARCHAR(100) NOT NULL,
  niveau          VARCHAR(50),
  section         VARCHAR(50),
  specialite      VARCHAR(50),
  total_students  INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);

-- ============================================================
-- SUBJECTS  (scoped to school)
-- ============================================================

CREATE TABLE IF NOT EXISTS subjects (
  id              SERIAL PRIMARY KEY,
  school_id       INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  nom             VARCHAR(100) NOT NULL,
  code            VARCHAR(20) NOT NULL,
  description     TEXT,
  coefficient     NUMERIC(4,2) NOT NULL DEFAULT 1,
  color           VARCHAR(20),
  applicable_for  TEXT[] NOT NULL DEFAULT '{}',
  niveaux         TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_subjects_school ON subjects(school_id);

-- ============================================================
-- STUDENTS  (scoped to school via classe)
-- ============================================================

CREATE TABLE IF NOT EXISTS students (
  id                SERIAL PRIMARY KEY,
  school_id         INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  nom               VARCHAR(100) NOT NULL,
  prenom            VARCHAR(100) NOT NULL,
  email             VARCHAR(255),
  phone             VARCHAR(30),
  date_naissance    DATE,
  avatar_url        TEXT,
  classe_id         INT REFERENCES classes(id) ON DELETE SET NULL,
  parent_id         INT REFERENCES users(id) ON DELETE SET NULL,
  moyenne_generale  NUMERIC(4,2),
  total_absences    INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_students_school  ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_students_classe  ON students(classe_id);
CREATE INDEX IF NOT EXISTS idx_students_parent  ON students(parent_id);

-- ============================================================
-- TEACHER <-> CLASSES  (many-to-many, scoped by school implicitly)
-- ============================================================

CREATE TABLE IF NOT EXISTS teacher_classes (
  teacher_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classe_id   INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, classe_id)
);

-- ============================================================
-- TEACHER <-> SUBJECTS  (many-to-many)
-- ============================================================

CREATE TABLE IF NOT EXISTS teacher_subjects (
  teacher_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, subject_id)
);

-- ============================================================
-- GRADES
-- ============================================================

CREATE TABLE IF NOT EXISTS grades (
  id          SERIAL PRIMARY KEY,
  school_id   INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id  INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id  INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  classe_id   INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valeur      NUMERIC(5,2) NOT NULL CHECK (valeur >= 0 AND valeur <= 20),
  type        grade_type NOT NULL DEFAULT 'devoir',
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  comment     TEXT,
  trimestre   SMALLINT NOT NULL CHECK (trimestre BETWEEN 1 AND 3),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grades_school    ON grades(school_id);
CREATE INDEX IF NOT EXISTS idx_grades_student   ON grades(student_id);
CREATE INDEX IF NOT EXISTS idx_grades_classe    ON grades(classe_id);
CREATE INDEX IF NOT EXISTS idx_grades_teacher   ON grades(teacher_id);
CREATE INDEX IF NOT EXISTS idx_grades_trimestre ON grades(trimestre);

-- ============================================================
-- ABSENCES
-- ============================================================

CREATE TABLE IF NOT EXISTS absences (
  id                    SERIAL PRIMARY KEY,
  school_id             INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id            INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  classe_id             INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id            INT REFERENCES subjects(id) ON DELETE SET NULL,
  teacher_id            INT REFERENCES users(id) ON DELETE SET NULL,
  date                  DATE NOT NULL DEFAULT CURRENT_DATE,
  session               session_type NOT NULL DEFAULT 'matin',
  justified             BOOLEAN NOT NULL DEFAULT FALSE,
  justification_reason  TEXT,
  justification_date    DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_absences_school  ON absences(school_id);
CREATE INDEX IF NOT EXISTS idx_absences_student ON absences(student_id);
CREATE INDEX IF NOT EXISTS idx_absences_classe  ON absences(classe_id);
CREATE INDEX IF NOT EXISTS idx_absences_date    ON absences(date);

-- ============================================================
-- SCHEDULES
-- ============================================================

CREATE TABLE IF NOT EXISTS schedules (
  id           SERIAL PRIMARY KEY,
  school_id    INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  classe_id    INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  salle_nom    VARCHAR(50),
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  color        VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_schedules_school   ON schedules(school_id);
CREATE INDEX IF NOT EXISTS idx_schedules_classe   ON schedules(classe_id);
CREATE INDEX IF NOT EXISTS idx_schedules_teacher  ON schedules(teacher_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  school_id   INT REFERENCES schools(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  message     TEXT NOT NULL,
  type        notification_type NOT NULL DEFAULT 'general',
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_school ON notifications(school_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read   ON notifications(is_read);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  school_id       INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  classe_id       INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  parent_id       INT REFERENCES users(id) ON DELETE SET NULL,
  montant         NUMERIC(10,3) NOT NULL,
  frequence       payment_frequence NOT NULL DEFAULT 'mensuelle',
  mode_paiement   payment_mode,
  mois            SMALLINT CHECK (mois BETWEEN 1 AND 12),
  trimestre       SMALLINT CHECK (trimestre BETWEEN 1 AND 3),
  annee           INT NOT NULL,
  statut          payment_statut NOT NULL DEFAULT 'enAttente',
  date_echeance   DATE NOT NULL,
  date_paiement   DATE,
  numero_cheque   VARCHAR(50),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_school   ON payments(school_id);
CREATE INDEX IF NOT EXISTS idx_payments_student  ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_parent   ON payments(parent_id);
CREATE INDEX IF NOT EXISTS idx_payments_statut   ON payments(statut);

-- ============================================================
-- COURS
-- ============================================================

CREATE TABLE IF NOT EXISTS cours (
  id                SERIAL PRIMARY KEY,
  school_id         INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classe_id         INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id        INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  titre             VARCHAR(255) NOT NULL,
  description       TEXT,
  date_publication  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cours_school   ON cours(school_id);
CREATE INDEX IF NOT EXISTS idx_cours_classe   ON cours(classe_id);
CREATE INDEX IF NOT EXISTS idx_cours_teacher  ON cours(teacher_id);

-- ============================================================
-- EXERCICES
-- ============================================================

CREATE TABLE IF NOT EXISTS exercices (
  id                SERIAL PRIMARY KEY,
  school_id         INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classe_id         INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id        INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  titre             VARCHAR(255) NOT NULL,
  description       TEXT,
  date_publication  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date_limite       DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exercices_school   ON exercices(school_id);
CREATE INDEX IF NOT EXISTS idx_exercices_classe   ON exercices(classe_id);
CREATE INDEX IF NOT EXISTS idx_exercices_teacher  ON exercices(teacher_id);

-- ============================================================
-- EXAMENS NATIONAUX
-- ============================================================

CREATE TABLE IF NOT EXISTS examens_nationaux (
  id              SERIAL PRIMARY KEY,
  school_id       INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type            examen_type NOT NULL,
  statut          examen_statut NOT NULL DEFAULT 'inscrit',
  annee           INT NOT NULL,
  note            NUMERIC(5,2) CHECK (note IS NULL OR (note >= 0 AND note <= 20)),
  specialisation  VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_examens_school   ON examens_nationaux(school_id);
CREATE INDEX IF NOT EXISTS idx_examens_student  ON examens_nationaux(student_id);

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION update_student_absences()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE students SET total_absences = total_absences + 1 WHERE id = NEW.student_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE students SET total_absences = GREATEST(total_absences - 1, 0) WHERE id = OLD.student_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_student_absences ON absences;
CREATE TRIGGER trg_update_student_absences
AFTER INSERT OR DELETE ON absences
FOR EACH ROW EXECUTE FUNCTION update_student_absences();

CREATE OR REPLACE FUNCTION update_class_student_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.classe_id IS NOT NULL THEN
    UPDATE classes SET total_students = total_students + 1 WHERE id = NEW.classe_id;
  ELSIF TG_OP = 'DELETE' AND OLD.classe_id IS NOT NULL THEN
    UPDATE classes SET total_students = GREATEST(total_students - 1, 0) WHERE id = OLD.classe_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.classe_id IS DISTINCT FROM NEW.classe_id THEN
    IF OLD.classe_id IS NOT NULL THEN
      UPDATE classes SET total_students = GREATEST(total_students - 1, 0) WHERE id = OLD.classe_id;
    END IF;
    IF NEW.classe_id IS NOT NULL THEN
      UPDATE classes SET total_students = total_students + 1 WHERE id = NEW.classe_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_class_student_count ON students;
CREATE TRIGGER trg_update_class_student_count
AFTER INSERT OR DELETE OR UPDATE OF classe_id ON students
FOR EACH ROW EXECUTE FUNCTION update_class_student_count();

CREATE OR REPLACE FUNCTION refresh_late_payments()
RETURNS VOID AS $$
BEGIN
  UPDATE payments
  SET statut = 'enRetard'
  WHERE statut = 'enAttente' AND date_echeance < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;
