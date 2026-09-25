const express = require('express');
const router = express.Router();
const { createInvoice, getInvoiceById, getInvoices, cancelInvoice } = require('../controllers/invoicesController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.post('/', authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), createInvoice);
router.get('/', authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), getInvoices);
router.get('/:id', authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), getInvoiceById);
router.patch('/:id/cancel', authorizeRole('ClinicAdmin'), cancelInvoice);

module.exports = router;