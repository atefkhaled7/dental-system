const express = require("express");
const router = express.Router();
const {
  getBookingRequests,
  approveBookingRequest,
  rejectBookingRequest,
} = require("../controllers/bookingRequestsController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);
router.use(authMiddleware);

router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getBookingRequests
);
router.patch(
  "/:id/approve",
  authorizeRole("ClinicAdmin", "Receptionist"),
  approveBookingRequest
);
router.patch(
  "/:id/reject",
  authorizeRole("ClinicAdmin", "Receptionist"),
  rejectBookingRequest
);

module.exports = router;
