const express = require('express');
const router = express.Router();
const { getAppointments, createAppointment } = require('../controllers/appointmentsController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/', getAppointments);
router.post('/',authMiddleware, createAppointment);

module.exports = router;