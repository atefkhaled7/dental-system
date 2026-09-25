const express = require('express');
const router = express.Router();
const { recordPayment } = require('../controllers/paymentsController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/', recordPayment);

module.exports = router;