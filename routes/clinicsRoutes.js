const express = require('express');
const router = express.Router();
const {createClinic, getClinics, updateClinic, deleteClinic} = require('../controllers/clinicsController');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

router.post('/', authMiddleware, authorizeRole('Admin'), createClinic);
router.get('/', authMiddleware, authorizeRole('Admin'), getClinics);
router.put('/:id', authMiddleware, authorizeRole('Admin'), updateClinic);
router.delete('/:id',authMiddleware, authorizeRole('Admin'), deleteClinic);

module.exports = router;