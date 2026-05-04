const router = require('express').Router();

const authRoutes          = require('./auth.routes');
const studentsRoutes      = require('./students.routes');
const teachersRoutes      = require('./teachers.routes');
const classesRoutes       = require('./classes.routes');
const subjectsRoutes      = require('./subjects.routes');
const gradesRoutes        = require('./grades.routes');
const absencesRoutes      = require('./absences.routes');
const appelRoutes         = require('./appel.routes');
const scheduleRoutes      = require('./schedule.routes');
const notificationsRoutes = require('./notifications.routes');
const paymentsRoutes      = require('./payments.routes');
const coursRoutes         = require('./cours.routes');
const exercicesRoutes     = require('./exercices.routes');
const comportementsRoutes = require('./comportements.routes');
const examensRoutes       = require('./examens.routes');
const dashboardRoutes     = require('./dashboard.routes');
const accountsRoutes      = require('./accounts.routes');
const profileRoutes       = require('./profile.routes');
const uploadRoutes        = require('./upload.routes');

// Auth
router.use('/auth', authRoutes);

// Core entities
router.use('/students',      studentsRoutes);
router.use('/teachers',      teachersRoutes);
router.use('/classes',       classesRoutes);
router.use('/subjects',      subjectsRoutes);

// Academic
router.use('/grades',        gradesRoutes);
router.use('/absences',      absencesRoutes);
router.use('/appel',         appelRoutes);
router.use('/schedules',     scheduleRoutes);
router.use('/cours',         coursRoutes);
router.use('/exercices',     exercicesRoutes);
router.use('/comportements', comportementsRoutes);
router.use('/examens',       examensRoutes);

// Admin / Finance
router.use('/notifications', notificationsRoutes);
router.use('/payments',      paymentsRoutes);
router.use('/dashboard',     dashboardRoutes);

// Accounts (superAdmin: /accounts + /accounts/schools; admin: /accounts/staff)
// Schools CRUD is handled at /api/accounts/schools by accounts.routes.js
router.use('/accounts',      accountsRoutes);

// User self-service
router.use('/profile',       profileRoutes);

// File upload
router.use('/upload',        uploadRoutes);

module.exports = router;
