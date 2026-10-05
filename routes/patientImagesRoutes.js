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
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["patientId","id"]);

router.post(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  upload.single("image"),
  uploadPatientImage
);
router.get(
  "/patients/:patientId",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getPatientImages
);
router.get(
  "/:id/file",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getProtectedImageFile
);
router.patch(
  "/:id/archive",
  authMiddleware,
  authorizeRole("ClinicAdmin", "Doctor"),
  archivePatientImage
);

module.exports = router;
