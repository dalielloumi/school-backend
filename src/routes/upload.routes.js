const router  = require('express').Router();
const path    = require('path');
const { authenticate } = require('../middleware/auth');
const upload  = require('../middleware/upload');

// POST /api/upload  — authenticated users can upload a file (PDF, image, doc)
router.post('/', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Aucun fichier reçu' });
  }

  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  // Return url at top level — Flutter client reads response.data['url'] directly
  res.status(201).json({ success: true, url: fileUrl, filename: req.file.filename });
});

module.exports = router;
