const express = require('express');
const router = express.Router();
const {createClinic, getClinics, updateClinic, deleteClinic} = require('../controllers/clinicsController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.post('/', authMiddleware, authorizeRole('ClinicAdmin'), createClinic);
router.get('/', authMiddleware, authorizeRole('ClinicAdmin'), getClinics);
router.put('/:id', authMiddleware, authorizeRole('ClinicAdmin'), updateClinic);
router.delete('/:id',authMiddleware, authorizeRole('ClinicAdmin'), deleteClinic);

module.exports = router;