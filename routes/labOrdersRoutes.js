const express = require('express');
const router = express.Router();
const { 
  createLabOrder, 
  getLabOrders, 
  updateLabOrderStatus 
} = require('../controllers/labOrdersController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/', createLabOrder);
router.get('/', getLabOrders);
router.patch('/:id/status', updateLabOrderStatus);

module.exports = router;