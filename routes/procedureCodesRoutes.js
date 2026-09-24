const express = require('express');
const router = express.Router();
const { createProcedureCode, getProcedureCodes } = require('../controllers/procedureCodesController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/procedure-codes', createProcedureCode);
router.get('/procedure-codes', getProcedureCodes);

module.exports = router;