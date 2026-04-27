-- ============================================================
-- Add 5 extra parents + students to existing database
-- Safe to run — no TRUNCATE, no DELETE
-- ============================================================

DO $$
DECLARE
  school1_id  INT;
  school2_id  INT;
  classe1_id  INT;  -- 8ème 1 school1
  classe2_id  INT;  -- 5ème 1 school2
  classe3_id  INT;  -- 8ème 1 school2

  -- teacher IDs (needed for grades)
  t_math1     INT;  -- Math teacher school1
  t_lang1     INT;  -- Arabe/FR teacher school1
  t_other1    INT;  -- HG/EI/EP/Ang teacher school1
  t_math2     INT;  -- Math teacher school2
  t_lang2     INT;  -- Arabe/FR teacher school2

  -- New parent IDs
  p1_id INT; -- Khaled Mejri    (school1)
  p2_id INT; -- Sabrine Ouali   (school1)
  p3_id INT; -- Nizar Hamdi     (school1)
  p4_id INT; -- Dorra Slim      (school2)
  p5_id INT; -- Ramzi Ayari     (school2)

  -- New student IDs
  s1_id INT; -- Rania Mejri
  s2_id INT; -- Anis Ouali
  s3_id INT; -- Sara Hamdi
  s4_id INT; -- Bilel Slim
  s5_id INT; -- Lina Ayari

  -- Subject IDs school1
  sub_math1 INT; sub_arab1 INT; sub_fr1 INT;
  sub_sci1  INT; sub_hg1  INT; sub_ei1 INT;
  sub_ep1   INT; sub_ang1 INT;

  -- Subject IDs school2
  sub_math2 INT; sub_arab2 INT; sub_fr2 INT;
  sub_sci2  INT; sub_hg2  INT; sub_ei2 INT;
  sub_ep2   INT;

BEGIN
  -- ── Resolve IDs from existing data ──────────────────────
  SELECT id INTO school1_id FROM schools WHERE nom = 'Collège Ibn Khaldoun';
  SELECT id INTO school2_id FROM schools WHERE nom = 'École El Amal';

  SELECT id INTO classe1_id FROM classes WHERE school_id = school1_id AND nom = '8ème 1';
  SELECT id INTO classe2_id FROM classes WHERE school_id = school2_id AND nom = '5ème 1';
  SELECT id INTO classe3_id FROM classes WHERE school_id = school2_id AND nom = '8ème 1';

  SELECT id INTO t_math1  FROM users WHERE email = 'karim.nasri@ibnkhaldoun.tn';
  SELECT id INTO t_lang1  FROM users WHERE email = 'sonia.belhadj@ibnkhaldoun.tn';
  SELECT id INTO t_other1 FROM users WHERE email = 'hedi.zouari@ibnkhaldoun.tn';
  SELECT id INTO t_math2  FROM users WHERE email = 'amina.mansouri@elalmal.tn';
  SELECT id INTO t_lang2  FROM users WHERE email = 'walid.chaabane@elalmal.tn';

  SELECT id INTO sub_math1 FROM subjects WHERE school_id = school1_id AND code = 'MATH';
  SELECT id INTO sub_arab1 FROM subjects WHERE school_id = school1_id AND code = 'ARAB';
  SELECT id INTO sub_fr1   FROM subjects WHERE school_id = school1_id AND code = 'FR';
  SELECT id INTO sub_sci1  FROM subjects WHERE school_id = school1_id AND code = 'SCI';
  SELECT id INTO sub_hg1   FROM subjects WHERE school_id = school1_id AND code = 'HG';
  SELECT id INTO sub_ei1   FROM subjects WHERE school_id = school1_id AND code = 'EI';
  SELECT id INTO sub_ep1   FROM subjects WHERE school_id = school1_id AND code = 'EP';
  SELECT id INTO sub_ang1  FROM subjects WHERE school_id = school1_id AND code = 'ANG';

  SELECT id INTO sub_math2 FROM subjects WHERE school_id = school2_id AND code = 'MATH';
  SELECT id INTO sub_arab2 FROM subjects WHERE school_id = school2_id AND code = 'ARAB';
  SELECT id INTO sub_fr2   FROM subjects WHERE school_id = school2_id AND code = 'FR';
  SELECT id INTO sub_sci2  FROM subjects WHERE school_id = school2_id AND code = 'SCI';
  SELECT id INTO sub_hg2   FROM subjects WHERE school_id = school2_id AND code = 'HG';
  SELECT id INTO sub_ei2   FROM subjects WHERE school_id = school2_id AND code = 'EI';
  SELECT id INTO sub_ep2   FROM subjects WHERE school_id = school2_id AND code = 'EP';

  -- ── Insert Parents ───────────────────────────────────────
  INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone)
    VALUES (school1_id, 'Mejri',  'Khaled',  'khaled.mejri@gmail.com',  crypt('test123', gen_salt('bf',10)), 'parent', '+216 71 555 005')
    RETURNING id INTO p1_id;

  INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone)
    VALUES (school1_id, 'Ouali',  'Sabrine', 'sabrine.ouali@gmail.com', crypt('test123', gen_salt('bf',10)), 'parent', '+216 71 555 006')
    RETURNING id INTO p2_id;

  INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone)
    VALUES (school1_id, 'Hamdi',  'Nizar',   'nizar.hamdi@gmail.com',   crypt('test123', gen_salt('bf',10)), 'parent', '+216 71 555 007')
    RETURNING id INTO p3_id;

  INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone)
    VALUES (school2_id, 'Slim',   'Dorra',   'dorra.slim@gmail.com',    crypt('test123', gen_salt('bf',10)), 'parent', '+216 74 666 005')
    RETURNING id INTO p4_id;

  INSERT INTO users (school_id, nom, prenom, email, password_hash, role, phone)
    VALUES (school2_id, 'Ayari',  'Ramzi',   'ramzi.ayari@gmail.com',   crypt('test123', gen_salt('bf',10)), 'parent', '+216 74 666 006')
    RETURNING id INTO p5_id;

  -- ── Insert Students ──────────────────────────────────────
  INSERT INTO students (school_id, nom, prenom, email, date_naissance, classe_id, parent_id)
    VALUES (school1_id, 'Mejri',    'Rania',  'rania.mejri@student.tn',    '2012-06-10', classe1_id, p1_id)
    RETURNING id INTO s1_id;

  INSERT INTO students (school_id, nom, prenom, email, date_naissance, classe_id, parent_id)
    VALUES (school1_id, 'Ouali',    'Anis',   'anis.ouali@student.tn',     '2011-09-25', classe1_id, p2_id)
    RETURNING id INTO s2_id;

  INSERT INTO students (school_id, nom, prenom, email, date_naissance, classe_id, parent_id)
    VALUES (school1_id, 'Hamdi',    'Sara',   'sara.hamdi@student.tn',     '2012-02-14', classe1_id, p3_id)
    RETURNING id INTO s3_id;

  INSERT INTO students (school_id, nom, prenom, email, date_naissance, classe_id, parent_id)
    VALUES (school2_id, 'Slim',     'Bilel',  'bilel.slim@student.tn',     '2014-11-03', classe2_id, p4_id)
    RETURNING id INTO s4_id;

  INSERT INTO students (school_id, nom, prenom, email, date_naissance, classe_id, parent_id)
    VALUES (school2_id, 'Ayari',    'Lina',   'lina.ayari@student.tn',     '2011-07-19', classe3_id, p5_id)
    RETURNING id INTO s5_id;

  -- ── Grades T1 — Rania (school1, bon élève ~14) ──────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s1_id,sub_math1,classe1_id,t_math1,  14,'devoir','2025-10-10',1),
  (school1_id,s1_id,sub_math1,classe1_id,t_math1,  15,'examen','2025-11-20',1),
  (school1_id,s1_id,sub_arab1,classe1_id,t_lang1,  13,'devoir','2025-10-12',1),
  (school1_id,s1_id,sub_arab1,classe1_id,t_lang1,  14,'examen','2025-11-18',1),
  (school1_id,s1_id,sub_fr1,  classe1_id,t_lang1,  14,'devoir','2025-10-14',1),
  (school1_id,s1_id,sub_fr1,  classe1_id,t_lang1,  13,'examen','2025-11-22',1),
  (school1_id,s1_id,sub_sci1, classe1_id,t_math1,  15,'devoir','2025-10-16',1),
  (school1_id,s1_id,sub_sci1, classe1_id,t_math1,  14,'examen','2025-11-15',1),
  (school1_id,s1_id,sub_hg1,  classe1_id,t_other1, 13,'devoir','2025-10-20',1),
  (school1_id,s1_id,sub_ei1,  classe1_id,t_other1, 15,'devoir','2025-10-22',1),
  (school1_id,s1_id,sub_ep1,  classe1_id,t_other1, 16,'tp',    '2025-11-05',1),
  (school1_id,s1_id,sub_ang1, classe1_id,t_other1, 13,'devoir','2025-10-24',1),
  (school1_id,s1_id,sub_ang1, classe1_id,t_other1, 14,'examen','2025-11-25',1);

  -- ── Grades T2 — Rania ────────────────────────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s1_id,sub_math1,classe1_id,t_math1,  15,'devoir','2026-01-12',2),
  (school1_id,s1_id,sub_math1,classe1_id,t_math1,  14,'examen','2026-02-10',2),
  (school1_id,s1_id,sub_arab1,classe1_id,t_lang1,  14,'devoir','2026-01-14',2),
  (school1_id,s1_id,sub_arab1,classe1_id,t_lang1,  13,'examen','2026-02-12',2),
  (school1_id,s1_id,sub_fr1,  classe1_id,t_lang1,  13,'devoir','2026-01-16',2),
  (school1_id,s1_id,sub_sci1, classe1_id,t_math1,  15,'devoir','2026-01-18',2),
  (school1_id,s1_id,sub_hg1,  classe1_id,t_other1, 14,'devoir','2026-01-22',2),
  (school1_id,s1_id,sub_ei1,  classe1_id,t_other1, 15,'devoir','2026-01-24',2),
  (school1_id,s1_id,sub_ep1,  classe1_id,t_other1, 16,'tp',    '2026-02-05',2),
  (school1_id,s1_id,sub_ang1, classe1_id,t_other1, 13,'devoir','2026-01-26',2);

  -- ── Grades T1 — Anis (school1, moyen ~11) ────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s2_id,sub_math1,classe1_id,t_math1,  11,'devoir','2025-10-10',1),
  (school1_id,s2_id,sub_math1,classe1_id,t_math1,  10,'examen','2025-11-20',1),
  (school1_id,s2_id,sub_arab1,classe1_id,t_lang1,  12,'devoir','2025-10-12',1),
  (school1_id,s2_id,sub_arab1,classe1_id,t_lang1,  11,'examen','2025-11-18',1),
  (school1_id,s2_id,sub_fr1,  classe1_id,t_lang1,  10,'devoir','2025-10-14',1),
  (school1_id,s2_id,sub_fr1,  classe1_id,t_lang1,  11,'examen','2025-11-22',1),
  (school1_id,s2_id,sub_sci1, classe1_id,t_math1,  11,'devoir','2025-10-16',1),
  (school1_id,s2_id,sub_hg1,  classe1_id,t_other1, 10,'devoir','2025-10-20',1),
  (school1_id,s2_id,sub_ei1,  classe1_id,t_other1, 12,'devoir','2025-10-22',1),
  (school1_id,s2_id,sub_ep1,  classe1_id,t_other1, 13,'tp',    '2025-11-05',1),
  (school1_id,s2_id,sub_ang1, classe1_id,t_other1,  9,'devoir','2025-10-24',1);

  -- ── Grades T2 — Anis ─────────────────────────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s2_id,sub_math1,classe1_id,t_math1,  10,'devoir','2026-01-12',2),
  (school1_id,s2_id,sub_math1,classe1_id,t_math1,  12,'examen','2026-02-10',2),
  (school1_id,s2_id,sub_arab1,classe1_id,t_lang1,  11,'devoir','2026-01-14',2),
  (school1_id,s2_id,sub_fr1,  classe1_id,t_lang1,  10,'devoir','2026-01-16',2),
  (school1_id,s2_id,sub_sci1, classe1_id,t_math1,  11,'devoir','2026-01-18',2),
  (school1_id,s2_id,sub_hg1,  classe1_id,t_other1, 10,'devoir','2026-01-22',2),
  (school1_id,s2_id,sub_ep1,  classe1_id,t_other1, 13,'tp',    '2026-02-05',2),
  (school1_id,s2_id,sub_ang1, classe1_id,t_other1, 10,'devoir','2026-01-26',2);

  -- ── Grades T1 — Sara (school1, excellent ~17) ────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s3_id,sub_math1,classe1_id,t_math1,  17,'devoir','2025-10-10',1),
  (school1_id,s3_id,sub_math1,classe1_id,t_math1,  18,'examen','2025-11-20',1),
  (school1_id,s3_id,sub_arab1,classe1_id,t_lang1,  16,'devoir','2025-10-12',1),
  (school1_id,s3_id,sub_arab1,classe1_id,t_lang1,  17,'examen','2025-11-18',1),
  (school1_id,s3_id,sub_fr1,  classe1_id,t_lang1,  17,'devoir','2025-10-14',1),
  (school1_id,s3_id,sub_fr1,  classe1_id,t_lang1,  16,'examen','2025-11-22',1),
  (school1_id,s3_id,sub_sci1, classe1_id,t_math1,  18,'devoir','2025-10-16',1),
  (school1_id,s3_id,sub_sci1, classe1_id,t_math1,  17,'examen','2025-11-15',1),
  (school1_id,s3_id,sub_hg1,  classe1_id,t_other1, 16,'devoir','2025-10-20',1),
  (school1_id,s3_id,sub_ei1,  classe1_id,t_other1, 17,'devoir','2025-10-22',1),
  (school1_id,s3_id,sub_ep1,  classe1_id,t_other1, 18,'tp',    '2025-11-05',1),
  (school1_id,s3_id,sub_ang1, classe1_id,t_other1, 15,'devoir','2025-10-24',1),
  (school1_id,s3_id,sub_ang1, classe1_id,t_other1, 16,'examen','2025-11-25',1);

  -- ── Grades T2 — Sara ─────────────────────────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school1_id,s3_id,sub_math1,classe1_id,t_math1,  18,'devoir','2026-01-12',2),
  (school1_id,s3_id,sub_math1,classe1_id,t_math1,  17,'examen','2026-02-10',2),
  (school1_id,s3_id,sub_arab1,classe1_id,t_lang1,  16,'devoir','2026-01-14',2),
  (school1_id,s3_id,sub_arab1,classe1_id,t_lang1,  17,'examen','2026-02-12',2),
  (school1_id,s3_id,sub_fr1,  classe1_id,t_lang1,  17,'devoir','2026-01-16',2),
  (school1_id,s3_id,sub_sci1, classe1_id,t_math1,  18,'devoir','2026-01-18',2),
  (school1_id,s3_id,sub_hg1,  classe1_id,t_other1, 16,'devoir','2026-01-22',2),
  (school1_id,s3_id,sub_ei1,  classe1_id,t_other1, 17,'devoir','2026-01-24',2),
  (school1_id,s3_id,sub_ep1,  classe1_id,t_other1, 19,'tp',    '2026-02-05',2),
  (school1_id,s3_id,sub_ang1, classe1_id,t_other1, 15,'devoir','2026-01-26',2);

  -- ── Grades T1 — Bilel (school2, 5ème, moyen ~12) ─────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school2_id,s4_id,sub_math2,classe2_id,t_math2,  12,'devoir','2025-10-10',1),
  (school2_id,s4_id,sub_math2,classe2_id,t_math2,  11,'examen','2025-11-18',1),
  (school2_id,s4_id,sub_arab2,classe2_id,t_lang2,  13,'devoir','2025-10-13',1),
  (school2_id,s4_id,sub_arab2,classe2_id,t_lang2,  12,'examen','2025-11-20',1),
  (school2_id,s4_id,sub_fr2,  classe2_id,t_lang2,  11,'devoir','2025-10-15',1),
  (school2_id,s4_id,sub_fr2,  classe2_id,t_lang2,  12,'examen','2025-11-22',1),
  (school2_id,s4_id,sub_sci2, classe2_id,t_math2,  12,'devoir','2025-10-17',1),
  (school2_id,s4_id,sub_ei2,  classe2_id,t_lang2,  13,'devoir','2025-10-21',1),
  (school2_id,s4_id,sub_ep2,  classe2_id,t_lang2,  14,'tp',    '2025-11-06',1);

  -- ── Grades T2 — Bilel ────────────────────────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school2_id,s4_id,sub_math2,classe2_id,t_math2,  11,'devoir','2026-01-12',2),
  (school2_id,s4_id,sub_math2,classe2_id,t_math2,  13,'examen','2026-02-10',2),
  (school2_id,s4_id,sub_arab2,classe2_id,t_lang2,  12,'devoir','2026-01-14',2),
  (school2_id,s4_id,sub_fr2,  classe2_id,t_lang2,  11,'devoir','2026-01-16',2),
  (school2_id,s4_id,sub_sci2, classe2_id,t_math2,  12,'devoir','2026-01-18',2),
  (school2_id,s4_id,sub_ei2,  classe2_id,t_lang2,  13,'devoir','2026-01-22',2),
  (school2_id,s4_id,sub_ep2,  classe2_id,t_lang2,  14,'tp',    '2026-02-06',2);

  -- ── Grades T1 — Lina (school2, 8ème, bon ~15) ────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school2_id,s5_id,sub_math2,classe3_id,t_math2,  15,'devoir','2025-10-10',1),
  (school2_id,s5_id,sub_math2,classe3_id,t_math2,  14,'examen','2025-11-18',1),
  (school2_id,s5_id,sub_arab2,classe3_id,t_lang2,  15,'devoir','2025-10-13',1),
  (school2_id,s5_id,sub_arab2,classe3_id,t_lang2,  14,'examen','2025-11-20',1),
  (school2_id,s5_id,sub_fr2,  classe3_id,t_lang2,  14,'devoir','2025-10-15',1),
  (school2_id,s5_id,sub_fr2,  classe3_id,t_lang2,  15,'examen','2025-11-22',1),
  (school2_id,s5_id,sub_sci2, classe3_id,t_math2,  16,'devoir','2025-10-17',1),
  (school2_id,s5_id,sub_hg2,  classe3_id,t_lang2,  14,'devoir','2025-10-20',1),
  (school2_id,s5_id,sub_ei2,  classe3_id,t_lang2,  15,'devoir','2025-10-22',1),
  (school2_id,s5_id,sub_ep2,  classe3_id,t_lang2,  17,'tp',    '2025-11-06',1);

  -- ── Grades T2 — Lina ─────────────────────────────────────
  INSERT INTO grades (school_id,student_id,subject_id,classe_id,teacher_id,valeur,type,date,trimestre) VALUES
  (school2_id,s5_id,sub_math2,classe3_id,t_math2,  16,'devoir','2026-01-12',2),
  (school2_id,s5_id,sub_math2,classe3_id,t_math2,  15,'examen','2026-02-10',2),
  (school2_id,s5_id,sub_arab2,classe3_id,t_lang2,  14,'devoir','2026-01-14',2),
  (school2_id,s5_id,sub_arab2,classe3_id,t_lang2,  15,'examen','2026-02-12',2),
  (school2_id,s5_id,sub_fr2,  classe3_id,t_lang2,  15,'devoir','2026-01-16',2),
  (school2_id,s5_id,sub_sci2, classe3_id,t_math2,  16,'devoir','2026-01-18',2),
  (school2_id,s5_id,sub_hg2,  classe3_id,t_lang2,  13,'devoir','2026-01-22',2),
  (school2_id,s5_id,sub_ep2,  classe3_id,t_lang2,  17,'tp',    '2026-02-06',2);

  -- ── Absences ──────────────────────────────────────────────
  INSERT INTO absences (school_id,student_id,classe_id,subject_id,teacher_id,date,session,justified) VALUES
  (school1_id,s1_id,classe1_id,sub_math1,t_math1,  '2025-10-21','matin',     false),
  (school1_id,s2_id,classe1_id,sub_arab1,t_lang1,  '2025-11-06','apres_midi',false),
  (school1_id,s2_id,classe1_id,sub_fr1,  t_lang1,  '2025-11-07','matin',     true),
  (school1_id,s3_id,classe1_id,sub_sci1, t_math1,  '2026-01-15','matin',     false),
  (school2_id,s4_id,classe2_id,sub_math2,t_math2,  '2025-10-16','matin',     false),
  (school2_id,s5_id,classe3_id,sub_arab2,t_lang2,  '2025-11-04','apres_midi',true);

  -- ── Payments ─────────────────────────────────────────────
  INSERT INTO payments (school_id,student_id,classe_id,parent_id,montant,frequence,mode_paiement,mois,annee,statut,date_echeance,date_paiement) VALUES
  -- Rania (school1, 150 TND)
  (school1_id,s1_id,classe1_id,p1_id, 150,'mensuelle','especes', 9,2025,'paye',   '2025-09-30','2025-09-28'),
  (school1_id,s1_id,classe1_id,p1_id, 150,'mensuelle','especes',10,2025,'paye',   '2025-10-31','2025-10-29'),
  (school1_id,s1_id,classe1_id,p1_id, 150,'mensuelle','especes',11,2025,'paye',   '2025-11-30','2025-11-26'),
  (school1_id,s1_id,classe1_id,p1_id, 150,'mensuelle',NULL,     12,2025,'enRetard','2025-12-31',NULL),
  (school1_id,s1_id,classe1_id,p1_id, 150,'mensuelle',NULL,      1,2026,'enRetard','2026-01-31',NULL),
  -- Anis (school1, 150 TND)
  (school1_id,s2_id,classe1_id,p2_id, 150,'mensuelle','cheque',  9,2025,'paye',   '2025-09-30','2025-09-25'),
  (school1_id,s2_id,classe1_id,p2_id, 150,'mensuelle','cheque', 10,2025,'paye',   '2025-10-31','2025-10-24'),
  (school1_id,s2_id,classe1_id,p2_id, 150,'mensuelle','cheque', 11,2025,'paye',   '2025-11-30','2025-11-25'),
  (school1_id,s2_id,classe1_id,p2_id, 150,'mensuelle','cheque', 12,2025,'paye',   '2025-12-31','2025-12-22'),
  (school1_id,s2_id,classe1_id,p2_id, 150,'mensuelle',NULL,      1,2026,'enRetard','2026-01-31',NULL),
  -- Sara (school1, 150 TND) — tout payé
  (school1_id,s3_id,classe1_id,p3_id, 150,'mensuelle','especes', 9,2025,'paye',   '2025-09-30','2025-09-27'),
  (school1_id,s3_id,classe1_id,p3_id, 150,'mensuelle','especes',10,2025,'paye',   '2025-10-31','2025-10-28'),
  (school1_id,s3_id,classe1_id,p3_id, 150,'mensuelle','especes',11,2025,'paye',   '2025-11-30','2025-11-24'),
  (school1_id,s3_id,classe1_id,p3_id, 150,'mensuelle','especes',12,2025,'paye',   '2025-12-31','2025-12-19'),
  (school1_id,s3_id,classe1_id,p3_id, 150,'mensuelle','especes', 1,2026,'paye',   '2026-01-31','2026-01-22'),
  -- Bilel (school2, 120 TND)
  (school2_id,s4_id,classe2_id,p4_id, 120,'mensuelle','especes', 9,2025,'paye',   '2025-09-30','2025-09-29'),
  (school2_id,s4_id,classe2_id,p4_id, 120,'mensuelle','especes',10,2025,'paye',   '2025-10-31','2025-10-27'),
  (school2_id,s4_id,classe2_id,p4_id, 120,'mensuelle',NULL,     11,2025,'enRetard','2025-11-30',NULL),
  (school2_id,s4_id,classe2_id,p4_id, 120,'mensuelle',NULL,     12,2025,'enRetard','2025-12-31',NULL),
  -- Lina (school2, 120 TND)
  (school2_id,s5_id,classe3_id,p5_id, 120,'mensuelle','cheque',  9,2025,'paye',   '2025-09-30','2025-09-26'),
  (school2_id,s5_id,classe3_id,p5_id, 120,'mensuelle','cheque', 10,2025,'paye',   '2025-10-31','2025-10-23'),
  (school2_id,s5_id,classe3_id,p5_id, 120,'mensuelle','cheque', 11,2025,'paye',   '2025-11-30','2025-11-21'),
  (school2_id,s5_id,classe3_id,p5_id, 120,'mensuelle',NULL,     12,2025,'enRetard','2025-12-31',NULL),
  (school2_id,s5_id,classe3_id,p5_id, 120,'mensuelle',NULL,      1,2026,'enRetard','2026-01-31',NULL);

  -- ── Notifications ─────────────────────────────────────────
  INSERT INTO notifications (school_id,user_id,title,message,type,is_read) VALUES
  (school1_id,p1_id,'Nouvelle note',      'Rania Mejri a obtenu 15/20 en Mathématiques (examen)',         'grade',   false),
  (school1_id,p2_id,'Absence signalée',   'Anis Ouali était absent le 06/11/2025',                        'absence', false),
  (school1_id,p3_id,'Nouvelle note',      'Sara Hamdi a obtenu 18/20 en Mathématiques (devoir)',           'grade',   false),
  (school1_id,p1_id,'Paiement en retard', 'Le paiement de décembre 2025 pour Rania est en retard',        'payment', false),
  (school2_id,p4_id,'Paiement en retard', 'Plusieurs mensualités de Bilel Slim sont en retard',           'payment', false),
  (school2_id,p5_id,'Nouvelle note',      'Lina Ayari a obtenu 16/20 en Sciences (devoir)',               'grade',   false);

  RAISE NOTICE 'Done — 5 parents + 5 students added successfully';
  RAISE NOTICE 'Parent logins (password: test123):';
  RAISE NOTICE '  khaled.mejri@gmail.com    → Rania  (school1, 8ème1)';
  RAISE NOTICE '  sabrine.ouali@gmail.com   → Anis   (school1, 8ème1)';
  RAISE NOTICE '  nizar.hamdi@gmail.com     → Sara   (school1, 8ème1)';
  RAISE NOTICE '  dorra.slim@gmail.com      → Bilel  (school2, 5ème1)';
  RAISE NOTICE '  ramzi.ayari@gmail.com     → Lina   (school2, 8ème1)';
END $$;
