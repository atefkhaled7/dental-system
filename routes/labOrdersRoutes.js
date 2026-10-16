const express = require("express");
const router = express.Router();
const {
  createLabOrder,
  getLabOrders,
  updateLabOrderStatus,
  updateLabOrder,
  recordLabOrderPayment,
  getDistinctLabs,
  saveLabToDirectory,
} = require("../controllers/labOrdersController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);
router.use(authMiddleware);

router.post(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createLabOrder,
);
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getLabOrders,
);
router.get(
  "/labs",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getDistinctLabs,
);
router.post(
  "/labs",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  saveLabToDirectory,
);
router.put(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateLabOrder,
);
router.patch(
  "/:id/status",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  updateLabOrderStatus,
);
router.post(
  "/:id/pay",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  recordLabOrderPayment,
);

module.exports = router;
