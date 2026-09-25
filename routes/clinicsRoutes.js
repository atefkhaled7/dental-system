const express = require('express');
const router = express.Router();
const {createClinic, getClinics, updateClinic, deleteClinic} = require('../controllers/clinicsController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.post('/', authMiddleware, authorizeRole('SuperAdmin'), createClinic);
router.get('/', authMiddleware, authorizeRole('SuperAdmin','ClinicAdmin'), getClinics);
router.put('/:id', authMiddleware, authorizeRole('SuperAdmin','ClinicAdmin'), updateClinic);
router.delete('/:id',authMiddleware, authorizeRole('SuperAdmin'), deleteClinic);

module.exports = router;