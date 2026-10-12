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
// router.post("/register-clinic", registerClinic);
router.patch("/profile", authMiddleware, updateProfile);
router.patch("/change-password", authMiddleware, changePassword);

module.exports = router;
