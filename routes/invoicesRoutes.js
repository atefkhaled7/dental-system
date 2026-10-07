const express = require("express");
const router = express.Router();
const {
  createInvoice,
  getInvoiceById,
  getInvoices,
  cancelInvoice,
  archiveInvoice,
  exportInvoices,
} = require("../controllers/invoicesController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);

router.use(authMiddleware);

router.get("/export",authorizeRole("ClinicAdmin"), exportInvoices);

router.post(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  createInvoice
);
router.get(
  "/",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getInvoices
);
router.get(
  "/:id",
  authorizeRole("ClinicAdmin", "Doctor", "Receptionist"),
  getInvoiceById
);
router.patch("/:id/cancel", authorizeRole("ClinicAdmin"), cancelInvoice);
router.patch("/:id/archive", authorizeRole("ClinicAdmin"), archiveInvoice);

module.exports = router;
