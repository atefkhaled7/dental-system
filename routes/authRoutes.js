const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  registerClinic,
} = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

router.post("/register", authMiddleware, registerUser);
router.post("/login", loginUser);
router.post("/register-clinic", registerClinic);

module.exports = router;
