const express = require('express');
const router = express.Router();
const { getAppointments, createAppointment, updateAppointmentStatus } = require('../controllers/appointmentsController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.get('/',authMiddleware, authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), getAppointments);
router.post('/',authMiddleware, authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), createAppointment);
router.patch('/:id/status',authMiddleware, authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), updateAppointmentStatus);

module.exports = router;