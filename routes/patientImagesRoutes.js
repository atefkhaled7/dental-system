const express = require("express");
const router = express.Router();
const {
  uploadPatientImage,
  getPatientImages,
  getProtectedImageFile,
  archivePatientImage,
} = require("../controllers/patientImagesController");
const authMiddleware = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

router.post(
  "/patients/:patientId",
  authMiddleware,
  upload.single("image"),
  uploadPatientImage
);
router.get("/patients/:patientId", authMiddleware, getPatientImages);
router.get("/:id/file", authMiddleware, getProtectedImageFile);
router.patch("/:id/archive", authMiddleware, archivePatientImage);

module.exports = router;
