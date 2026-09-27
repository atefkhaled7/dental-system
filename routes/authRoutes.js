const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  registerClinic,
  getDoctors,
} = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

router.get("/doctors", authMiddleware, getDoctors);
router.post("/register", authMiddleware, authorizeRoles("SuperAdmin", "ClinicAdmin"), registerUser);
router.post("/login", loginUser);
router.post("/register-clinic", registerClinic);


module.exports = router;
