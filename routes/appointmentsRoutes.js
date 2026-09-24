const express = require('express');
const router = express.Router();
const { getAppointments, createAppointment, updateAppointmentStatus } = require('../controllers/appointmentsController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/',authMiddleware, getAppointments);
router.post('/',authMiddleware, createAppointment);
router.patch('/:id/status',authMiddleware, updateAppointmentStatus);

module.exports = router;