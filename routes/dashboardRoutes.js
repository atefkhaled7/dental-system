const express = require("express");
const router = express.Router();
const { getDashboardStats } = require("../controllers/dashboardController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");

router.get(
  "/stats",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor","Receptionist"),
  getDashboardStats
);

module.exports = router;
