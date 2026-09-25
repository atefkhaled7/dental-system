const express = require("express");
const router = express.Router();
const {
  createLabOrder,
  getLabOrders,
  updateLabOrderStatus,
} = require("../controllers/labOrdersController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

router.use(authMiddleware);

router.post(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createLabOrder
);
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getLabOrders
);
router.patch(
  "/:id/status",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateLabOrderStatus
);

module.exports = router;
