const express = require('express');
const router = express.Router();
const { createInvoice, getInvoiceById, getInvoices, cancelInvoice } = require('../controllers/invoicesController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/', createInvoice);
router.get('/', getInvoices);
router.get('/:id', getInvoiceById);
router.patch('/:id/cancel', cancelInvoice);

module.exports = router;