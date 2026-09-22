const express = require('express');
const router = express.Router();
const {createClinic, getClinics, updateClinic, deleteClinic} = require('../controllers/clinicsController');

router.post('/', createClinic);
router.get('/', getClinics);
router.put('/:id', updateClinic);
router.delete('/:id', deleteClinic);

module.exports = router;