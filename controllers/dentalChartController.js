const pool = require("../db");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

// الحالات الـ 9 المعتمدة لحالة السن والأسطح (Phase 6)
const VALID_CONDITIONS = [
  "sound", // سليم
  "caries", // تسوس
  "filled", // حشو
  "rct", // علاج جذور / عصب
  "crown", // تاج / تركيبة
  "missing", // مخلوع / مفقود
  "implant", // زراعة
  "fracture", // كسر
  "sealant", // سيلانت وقائي
];

// الأسطح التشريحية المعتمدة
const VALID_SURFACES = new Set(["M", "O", "D", "B", "L", "I"]);
const CANONICAL_SURFACE_ORDER = ["M", "O", "D", "B", "L", "I"];

// أرقام الأسنان الدائمة حسب ترقيم FDI (11–48)
const VALID_ADULT_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33,
  34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
]);

// أرقام الأسنان اللبنية للأطفال حسب ترقيم FDI (51–85)
const VALID_DECIDUOUS_TEETH = new Set([
  51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84,
  85,
]);

// دالة مساعدة لتحديد نوع التسنين والتحقق من صحة رقم السن
const getToothDentition = (toothNum) => {
  if (VALID_ADULT_TEETH.has(toothNum)) return "permanent";
  if (VALID_DECIDUOUS_TEETH.has(toothNum)) return "deciduous";
  return null;
};

// أولوية الحالات لاستنتاج حالة السن الإجمالية من الأسطح عند الحاجة
const CONDITION_PRIORITY = [
  "missing",
  "implant",
  "crown",
  "rct",
  "fracture",
  "caries",
  "filled",
  "sealant",
  "sound",
];

const deriveToothConditionFromSurfaces = (surfaceRows, fallback = "sound") => {
  if (!Array.isArray(surfaceRows) || surfaceRows.length === 0) return fallback;
  const activeConditions = new Set(
    surfaceRows
      .map((s) => (s.condition || "").toLowerCase())
      .filter((c) => VALID_CONDITIONS.includes(c)),
  );
  for (const cond of CONDITION_PRIORITY) {
    if (activeConditions.has(cond)) return cond;
  }
  return fallback;
};

// حساب التسنين الافتراضي حسب عمر المريض (أقل من 12 سنة -> لبني)
const calculateDefaultDentition = (dateOfBirth) => {
  if (!dateOfBirth) return "permanent";
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return "permanent";
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 0 && age < 12 ? "deciduous" : "permanent";
};

// ============================================================
// 1. جلب كل الأسنان المسجلة لمريض معين + الأسطح الخمسة لكل سن
// ============================================================
const getPatientTeeth = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({
        error: "معرّف المريض غير صالح",
        code: "VALIDATION_ERROR",
      });
    }

    const patientCheck = await pool.query(
      `SELECT id, date_of_birth
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    const defaultDentition = calculateDefaultDentition(
      patientCheck.rows[0].date_of_birth,
    );

    const teethQuery = `
      SELECT
        id,
        tooth_number,
        dentition,
        condition,
        notes,
        updated_at
      FROM patient_teeth
      WHERE clinic_id = $1
        AND patient_id = $2
      ORDER BY tooth_number ASC;
    `;

    const surfacesQuery = `
      SELECT
        ts.id,
        ts.tooth_record_id,
        pt.tooth_number,
        ts.surface,
        ts.condition,
        ts.material,
        ts.notes,
        ts.updated_at
      FROM tooth_surfaces ts
      JOIN patient_teeth pt
        ON pt.id = ts.tooth_record_id
       AND pt.clinic_id = ts.clinic_id
      WHERE ts.clinic_id = $1
        AND pt.patient_id = $2
      ORDER BY pt.tooth_number ASC, ts.surface ASC;
    `;

    const [teethResult, surfacesResult] = await Promise.all([
      pool.query(teethQuery, [clinicId, patientId]),
      pool.query(surfacesQuery, [clinicId, patientId]),
    ]);

    const surfacesByToothRecord = new Map();
    for (const sRow of surfacesResult.rows) {
      if (!surfacesByToothRecord.has(sRow.tooth_record_id)) {
        surfacesByToothRecord.set(sRow.tooth_record_id, []);
      }
      surfacesByToothRecord.get(sRow.tooth_record_id).push({
        id: sRow.id,
        surface: sRow.surface,
        condition: sRow.condition,
        material: sRow.material,
        notes: sRow.notes,
        updated_at: sRow.updated_at,
      });
    }

    const teeth = teethResult.rows.map((t) => ({
      ...t,
      surfaces: surfacesByToothRecord.get(t.id) || [],
    }));

    return res.status(200).json({
      teeth,
      default_dentition: defaultDentition,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching patient teeth:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب مخطط الأسنان",
    });
  }
};

// ============================================================
// 2. تحديث حالة سن معين + الأسطح الخمسة + تسجيل الحركة في tooth_history
// ============================================================
const updateToothCondition = async (req, res) => {
  let client;
  try {
    const clinicId = req.user.clinic_id;
    const userId = req.user.id;
    const { patientId, toothNumber } = req.params;
    const {
      condition,
      notes,
      procedure_name,
      surface,
      surfaces,
      material,
      clear_surfaces,
    } = req.body || {};

    const isSurfaceOnlyUpdate = req.isSurfaceOnlyUpdate === true;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({
        error: "معرّف المريض غير صالح",
        code: "VALIDATION_ERROR",
      });
    }

    const toothNum = Number(toothNumber);
    const dentition = Number.isInteger(toothNum)
      ? getToothDentition(toothNum)
      : null;

    if (!dentition) {
      return res.status(400).json({
        error:
          "رقم السن غير صحيح طبقاً للترقيم الطبي المعتمد (FDI للأسنان الدائمة 11–48 أو اللبنية 51–85)",
        code: "VALIDATION_ERROR",
      });
    }

    if (
      !condition ||
      !VALID_CONDITIONS.includes(String(condition).toLowerCase())
    ) {
      return res.status(400).json({
        error: `حالة السن غير صالحة. الحالات المسموحة: ${VALID_CONDITIONS.join(", ")}`,
        code: "VALIDATION_ERROR",
      });
    }

    const normalizedCondition = String(condition).toLowerCase();
    const cleanNotes = typeof notes === "string" ? notes.trim() : null;
    const cleanMaterial =
      typeof material === "string" && material.trim()
        ? material.trim().slice(0, 50)
        : null;
    const cleanProcedureName =
      typeof procedure_name === "string" && procedure_name.trim()
        ? procedure_name.trim().slice(0, 255)
        : null;

    // تجهيز قائمة الأسطح المراد تحديثها (سواء مبعوتة كـ surfaces array أو surface string مثل "MOD")
    const normalizedSurfaceUpdates = [];

    if (Array.isArray(surfaces) && surfaces.length > 0) {
      for (const item of surfaces) {
        if (typeof item === "string") {
          const code = item.trim().toUpperCase();
          if (!VALID_SURFACES.has(code)) {
            return res.status(400).json({
              error: `رمز السطح (${item}) غير صالح. الأسطح المسموحة: M, O, D, B, L, I`,
              code: "VALIDATION_ERROR",
            });
          }
          normalizedSurfaceUpdates.push({
            surface: code,
            condition: normalizedCondition,
            material: cleanMaterial,
            notes: cleanNotes,
          });
        } else if (item && typeof item === "object") {
          const code = String(item.surface || "")
            .trim()
            .toUpperCase();
          const surfCond = String(
            item.condition || normalizedCondition,
          ).toLowerCase();
          if (!VALID_SURFACES.has(code)) {
            return res.status(400).json({
              error: `رمز السطح (${item.surface}) غير صالح. الأسطح المسموحة: M, O, D, B, L, I`,
              code: "VALIDATION_ERROR",
            });
          }
          if (!VALID_CONDITIONS.includes(surfCond)) {
            return res.status(400).json({
              error: `حالة السطح (${item.condition}) غير صالحة`,
              code: "VALIDATION_ERROR",
            });
          }
          normalizedSurfaceUpdates.push({
            surface: code,
            condition: surfCond,
            material:
              typeof item.material === "string" && item.material.trim()
                ? item.material.trim().slice(0, 50)
                : cleanMaterial,
            notes:
              typeof item.notes === "string" && item.notes.trim()
                ? item.notes.trim()
                : null,
          });
        }
      }
    } else if (typeof surface === "string" && surface.trim()) {
      const cleanSurfStr = surface.trim().toUpperCase();
      if (!/^[MODBLI]+$/.test(cleanSurfStr)) {
        return res.status(400).json({
          error: "رمز السطح غير صالح. الأسطح المسموحة: M, O, D, B, L, I",
          code: "VALIDATION_ERROR",
        });
      }
      const uniqueCodes = [...new Set(cleanSurfStr.split(""))];
      for (const code of uniqueCodes) {
        normalizedSurfaceUpdates.push({
          surface: code,
          condition: normalizedCondition,
          material: cleanMaterial,
          notes: cleanNotes,
        });
      }
    }

    client = await pool.connect();

    const patientCheck = await client.query(
      `SELECT id
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    await client.query("BEGIN");

    // A) إدخال أو تحديث سجل السن في patient_teeth
    const upsertToothQuery = `
      INSERT INTO patient_teeth (
        clinic_id,
        patient_id,
        tooth_number,
        dentition,
        condition,
        notes,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (clinic_id, patient_id, tooth_number)
      DO UPDATE SET
        dentition = EXCLUDED.dentition,
        condition = CASE
          WHEN $7::boolean THEN patient_teeth.condition
          ELSE EXCLUDED.condition
        END,
        notes = CASE
          WHEN $7::boolean THEN patient_teeth.notes
          WHEN $6::text IS NOT NULL THEN $6::text
          ELSE patient_teeth.notes
        END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const toothRes = await client.query(upsertToothQuery, [
      clinicId,
      patientId,
      toothNum,
      dentition,
      isSurfaceOnlyUpdate ? "sound" : normalizedCondition,
      cleanNotes,
      isSurfaceOnlyUpdate,
    ]);

    let toothRecord = toothRes.rows[0];

    // إذا تم تصفير السن بالكامل إلى سليم أو مخلوع أو زراعة أو طُلب مسح الأسطح
    if (
      clear_surfaces === true ||
      (normalizedSurfaceUpdates.length === 0 &&
        ["sound", "missing", "implant"].includes(normalizedCondition))
    ) {
      await client.query(
        `DELETE FROM tooth_surfaces
         WHERE clinic_id = $1 AND tooth_record_id = $2`,
        [clinicId, toothRecord.id],
      );
    }

    // B) تحديث الأسطح المحددة في tooth_surfaces إن وجدت
    if (normalizedSurfaceUpdates.length > 0) {
      const upsertSurfaceQuery = `
        INSERT INTO tooth_surfaces (
          clinic_id,
          tooth_record_id,
          surface,
          condition,
          material,
          notes,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (tooth_record_id, surface)
        DO UPDATE SET
          condition = EXCLUDED.condition,
          material = EXCLUDED.material,
          notes = COALESCE(EXCLUDED.notes, tooth_surfaces.notes),
          updated_at = CURRENT_TIMESTAMP;
      `;

      for (const sUpdate of normalizedSurfaceUpdates) {
        await client.query(upsertSurfaceQuery, [
          clinicId,
          toothRecord.id,
          sUpdate.surface,
          sUpdate.condition,
          sUpdate.material,
          sUpdate.notes,
        ]);
      }
    }

    // جلب الأسطح الحالية بعد التحديث
    const currentSurfacesRes = await client.query(
      `SELECT id, surface, condition, material, notes, updated_at
       FROM tooth_surfaces
       WHERE clinic_id = $1 AND tooth_record_id = $2
       ORDER BY surface ASC`,
      [clinicId, toothRecord.id],
    );

    // إذا كان التحديث على مستوى الأسطح فقط والسن ليس في حالة شاملة (خلع/زراعة/تاج/عصب)، نضبط حالة السن الأم تلقائياً
    if (
      normalizedSurfaceUpdates.length > 0 &&
      !["missing", "implant", "crown", "rct"].includes(toothRecord.condition)
    ) {
      const derivedCond = deriveToothConditionFromSurfaces(
        currentSurfacesRes.rows,
        normalizedCondition,
      );
      if (derivedCond !== toothRecord.condition) {
        const updatedParent = await client.query(
          `UPDATE patient_teeth
           SET condition = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND clinic_id = $3
           RETURNING *`,
          [derivedCond, toothRecord.id, clinicId],
        );
        if (updatedParent.rows.length > 0) {
          toothRecord = updatedParent.rows[0];
        }
      }
    }

    // C) تسجيل الحركة في tooth_history
    const historySurfaceString =
      normalizedSurfaceUpdates.length > 0
        ? CANONICAL_SURFACE_ORDER.filter((code) =>
            normalizedSurfaceUpdates.some((u) => u.surface === code),
          ).join("")
        : null;

    const historyMaterial =
      cleanMaterial ||
      (normalizedSurfaceUpdates.find((u) => u.material)?.material ?? null);

    await client.query(
      `INSERT INTO tooth_history (
        clinic_id,
        patient_id,
        tooth_number,
        condition,
        procedure_name,
        surface,
        material,
        notes,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clinicId,
        patientId,
        toothNum,
        normalizedSurfaceUpdates.length === 1
          ? normalizedSurfaceUpdates[0].condition
          : toothRecord.condition,
        cleanProcedureName,
        historySurfaceString,
        historyMaterial,
        cleanNotes || null,
        userId,
      ],
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "تم تحديث حالة السن وتسجيل الإجراء في السجل الطبي",
      tooth: {
        ...toothRecord,
        surfaces: currentSurfacesRes.rows,
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError.message);
      }
    }
    captureError(error, req);
    console.error("Error updating tooth condition:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تحديث السن",
    });
  } finally {
    if (client) client.release();
  }
};

// ============================================================
// 3. تحديث سطح واحد محدد للسن (M, O, D, B, L, I) مباشرة
// ============================================================
const updateToothSurface = async (req, res) => {
  const { surface } = req.params;
  const { condition, material, notes, procedure_name } = req.body || {};

  const cleanSurface = String(surface || "")
    .trim()
    .toUpperCase();
  if (!VALID_SURFACES.has(cleanSurface)) {
    return res.status(400).json({
      error: "رمز السطح غير صالح. الأسطح المسموحة: M, O, D, B, L, I",
      code: "VALIDATION_ERROR",
    });
  }

  req.body = {
    condition,
    material,
    notes,
    procedure_name,
    surfaces: [
      {
        surface: cleanSurface,
        condition,
        material,
        notes,
      },
    ],
  };

  req.isSurfaceOnlyUpdate = true;

  return updateToothCondition(req, res);
};

// ============================================================
// 4. جلب الـ Timeline الكامل لتاريخ سن محدد (دائم أو لبني)
// ============================================================
const getToothHistory = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId, toothNumber } = req.params;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({
        error: "معرّف المريض غير صالح",
        code: "VALIDATION_ERROR",
      });
    }

    const toothNum = Number(toothNumber);
    if (!Number.isInteger(toothNum) || !getToothDentition(toothNum)) {
      return res.status(400).json({
        error:
          "رقم السن غير صحيح طبقاً للترقيم الطبي المعتمد (FDI للأسنان الدائمة 11–48 أو اللبنية 51–85)",
        code: "VALIDATION_ERROR",
      });
    }

    const patientCheck = await pool.query(
      `SELECT id
       FROM patients
       WHERE id = $1
         AND clinic_id = $2
         AND is_active = TRUE`,
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    const query = `
      SELECT
        th.id,
        th.tooth_number,
        th.condition,
        th.procedure_name,
        th.surface,
        th.material,
        th.notes,
        th.created_at,
        u.name AS doctor_name
      FROM tooth_history th
      LEFT JOIN users u
        ON th.created_by = u.id
       AND u.clinic_id = th.clinic_id
      WHERE th.clinic_id = $1
        AND th.patient_id = $2
        AND th.tooth_number = $3
      ORDER BY th.created_at DESC;
    `;

    const result = await pool.query(query, [clinicId, patientId, toothNum]);

    return res.status(200).json({
      history: result.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching tooth history:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب تاريخ السن",
    });
  }
};

module.exports = {
  getPatientTeeth,
  updateToothCondition,
  updateToothSurface,
  getToothHistory,
  VALID_CONDITIONS,
  getToothDentition,
};
