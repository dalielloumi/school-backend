-- ============================================================
-- Migrations (safe to re-run — add columns if missing)
-- ============================================================
ALTER TABLE cours      ADD COLUMN IF NOT EXISTS file_url      TEXT;
ALTER TABLE cours      ADD COLUMN IF NOT EXISTS content_type  VARCHAR(20) DEFAULT 'text';
ALTER TABLE exercices  ADD COLUMN IF NOT EXISTS file_url      TEXT;
ALTER TABLE exercices  ADD COLUMN IF NOT EXISTS content_type  VARCHAR(20) DEFAULT 'text';

-- ============================================================
-- Seed Data — Super Admin only
-- All other data (schools, admins, teachers, students…)
-- is created through the application.
-- ============================================================

TRUNCATE TABLE examens_nationaux, exercices, cours, payments, notifications,
               schedules, absences, grades, teacher_subjects, teacher_classes,
               students, subjects, classes, users, schools
RESTART IDENTITY CASCADE;

-- ============================================================
-- SUPER ADMIN  (no school_id)
-- password: super123
-- ============================================================
INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone) VALUES
(NULL, 'Admin', 'Super', 'superadmin@school.com',
 '$2a$12$4cyLxCDfcNoUIAVkKlrdU.UZeCYWVhpgr6d5oro8psMEKyZXQ8MP6',
 'superAdmin', NULL);
