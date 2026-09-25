const express = require('express');
const router = express.Router();
const { recordPayment } = require('../controllers/paymentsController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.post('/', authorizeRole('ClinicAdmin', 'Receptionist'), recordPayment);

module.exports = router;