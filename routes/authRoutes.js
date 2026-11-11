const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  // registerClinic,
  getDoctors,
  updateProfile,
  changePassword,
  getMe,
  demoHeartbeat,
  demoSessionEnd,
  demoManualReset,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

router.get("/me", authMiddleware, getMe);
router.get("/doctors", authMiddleware, getDoctors);
router.post(
  "/register",
  authMiddleware,
  authorizeRoles("SuperAdmin", "ClinicAdmin"),
  registerUser,
);
router.post("/login", loginUser);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
// router.post("/register-clinic", registerClinic);
router.patch("/profile", authMiddleware, updateProfile);
router.patch("/change-password", authMiddleware, changePassword);

// مسارات إدارة جلسات وإعادة ضبط حساب الديمو
router.post("/demo/heartbeat", authMiddleware, demoHeartbeat);
router.post("/demo/session-end", authMiddleware, demoSessionEnd);
router.post("/demo/reset", authMiddleware, demoManualReset);

module.exports = router;