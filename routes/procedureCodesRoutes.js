const express = require('express');
const router = express.Router();
const { createProcedureCode, getProcedureCodes } = require('../controllers/procedureCodesController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.post('/', authorizeRole('ClinicAdmin'), createProcedureCode);
router.get('/', authorizeRole('ClinicAdmin', 'Doctor', 'Receptionist'), getProcedureCodes);

module.exports = router;