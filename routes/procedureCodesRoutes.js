const express = require("express");
const router = express.Router();
const {
  createProcedureCode,
  getProcedureCodes,
  updateProcedureCode,
  deleteProcedureCode,
} = require("../controllers/procedureCodesController");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRole = require("../middleware/roleMiddleware");
const { applyUuidParams } = require("../middleware/validateUuid");

applyUuidParams(router, ["id"]);
router.use(authMiddleware);

router.post("/", authorizeRole("ClinicAdmin"), createProcedureCode);
router.get("/", authorizeRole("ClinicAdmin", "Doctor", "Receptionist"), getProcedureCodes);
router.put("/:id", authorizeRole("ClinicAdmin"), updateProcedureCode);
router.delete("/:id", authorizeRole("ClinicAdmin"), deleteProcedureCode);

module.exports = router;