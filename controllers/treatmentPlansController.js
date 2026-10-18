const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

// القائمة البيضاء لأرقام الأسنان بنظام FDI (الدائمة 11–48 + اللبنية للأطفال 51–85)
const VALID_FDI_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33,
  34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 51, 52, 53, 54, 55, 61,
  62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85,
]);

const VALID_CONDITIONS = new Set([
  "sound",
  "caries",
  "filled",
  "rct",
  "crown",
  "missing",
  "implant",
  "fracture",
  "sealant",
]);

const CANONICAL_SURFACES = ["M", "O", "D", "B", "L", "I"];

// تطبيع رمز الأسطح ليطابق قيد chk_tpi_surface (^[MODBLI]+$) بدون تكرار
const normalizeSurfaceCode = (surfaceInput) => {
  if (
    surfaceInput === undefined ||
    surfaceInput === null ||
    surfaceInput === ""
  ) {
    return null;
  }
  const raw = Array.isArray(surfaceInput)
    ? surfaceInput.join("").toUpperCase()
    : String(surfaceInput).trim().toUpperCase();

  if (!raw) return null;
  if (!/^[MODBLI]+$/.test(raw)) return "__INVALID__";

  const uniqueOrdered = CANONICAL_SURFACES.filter((s) => raw.includes(s)).join(
    "",
  );
  return uniqueOrdered || "__INVALID__";
};

// استنتاج ذكي للحالة الناتجة إذا لم تكن محددة صراحةً في الكود أو البند
const inferResultingCondition = (procedureName) => {
  const name = String(procedureName || "").toLowerCase();
  if (
    name.includes("خلع") ||
    name.includes("extraction") ||
    name.includes("exo")
  ) {
    return "missing";
  }
  if (
    name.includes("زراع") ||
    name.includes("غرس") ||
    name.includes("implant")
  ) {
    return "implant";
  }
  if (
    name.includes("تاج") ||
    name.includes("طربوش") ||
    name.includes("تركيب") ||
    name.includes("زيركون") ||
    name.includes("بورسلين") ||
    name.includes("إيماكس") ||
    name.includes("crown") ||
    name.includes("zircon") ||
    name.includes("veneer")
  ) {
    return "crown";
  }
  if (
    name.includes("عصب") ||
    name.includes("جذور") ||
    name.includes("rct") ||
    name.includes("endo") ||
    name.includes("pulpotomy") ||
    name.includes("pulpectomy")
  ) {
    return "rct";
  }
  if (name.includes("سيلانت") || name.includes("sealant")) {
    return "sealant";
  }
  if (name.includes("كسر") || name.includes("fracture")) {
    return "fracture";
  }
  return null;
};

// 1. جلب خطط علاج المريض مع التحقق من تبعية المريض للعيادة
const getPatientTreatmentPlans = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2",
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود في هذه العيادة" });
    }

    const plansQuery = `
      SELECT * FROM treatment_plans
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY created_at DESC;
    `;
    const plansRes = await pool.query(plansQuery, [clinicId, patientId]);

    const itemsQuery = `
      SELECT
        tpi.*,
        pc.code AS procedure_code,
        COALESCE(tpi.resulting_condition, pc.resulting_condition) AS effective_resulting_condition
      FROM treatment_plan_items tpi
      JOIN treatment_plans tp
        ON tpi.plan_id = tp.id
       AND tpi.clinic_id = tp.clinic_id
      LEFT JOIN procedure_codes pc
        ON pc.id = tpi.procedure_code_id
       AND pc.clinic_id = tpi.clinic_id
      WHERE tpi.clinic_id = $1 AND tp.patient_id = $2
      ORDER BY tpi.created_at ASC;
    `;
    const itemsRes = await pool.query(itemsQuery, [clinicId, patientId]);

    const plansWithItems = plansRes.rows.map((plan) => ({
      ...plan,
      items: itemsRes.rows.filter((item) => item.plan_id === plan.id),
    }));

    res.status(200).json({ plans: plansWithItems });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching treatment plans:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب خطط العلاج" });
  }
};

// 2. إنشاء خطة علاج جديدة مع التحقق الصارم
const createTreatmentPlan = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;
    const { title, notes } = req.body || {};

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    if (
      !title ||
      typeof title !== "string" ||
      title.trim().length < 2 ||
      title.trim().length > 255
    ) {
      return res.status(400).json({
        error: "عنوان خطة العلاج مطلوب ويجب أن يتراوح بين حرفين و 255 حرفاً",
      });
    }

    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "المريض المحدد غير موجود في هذه العيادة أو تم أرشفته" });
    }

    const query = `
      INSERT INTO treatment_plans (clinic_id, patient_id, title, notes, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING *;
    `;

    const result = await pool.query(query, [
      clinicId,
      patientId,
      title.trim(),
      notes && typeof notes === "string" ? notes.trim() : null,
    ]);

    res.status(201).json({ plan: { ...result.rows[0], items: [] } });
  } catch (error) {
    captureError(error, req);
    console.error("Error creating treatment plan:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء خطة العلاج" });
  }
};

// 3. إضافة بند علاج لخطة مع فحص الـ FDI (الدائم واللبني) والأسطح والكود
const addTreatmentPlanItem = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { planId } = req.params;
    const {
      tooth_number,
      surface,
      surfaces,
      procedure_code_id,
      resulting_condition,
      material,
      diagnosis,
      procedure_name,
      estimated_cost,
    } = req.body || {};

    if (!isValidUuid(planId)) {
      return res.status(400).json({ error: "معرّف خطة العلاج غير صالح" });
    }

    let validatedProcedureCodeId = null;
    let codeRow = null;

    if (
      procedure_code_id !== undefined &&
      procedure_code_id !== null &&
      procedure_code_id !== ""
    ) {
      if (!isValidUuid(procedure_code_id)) {
        return res.status(400).json({ error: "معرّف كود الإجراء غير صالح" });
      }
      const codeCheck = await pool.query(
        `SELECT id, description, default_price, resulting_condition
         FROM procedure_codes
         WHERE id = $1 AND clinic_id = $2`,
        [procedure_code_id, clinicId],
      );
      if (codeCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "كود الإجراء المحدد غير موجود في هذه العيادة" });
      }
      codeRow = codeCheck.rows[0];
      validatedProcedureCodeId = codeRow.id;
    }

    const effectiveProcedureName =
      typeof procedure_name === "string" && procedure_name.trim()
        ? procedure_name.trim()
        : codeRow?.description || "";

    if (
      !effectiveProcedureName ||
      effectiveProcedureName.length < 2 ||
      effectiveProcedureName.length > 255
    ) {
      return res.status(400).json({
        error:
          "اسم الإجراء الطبي مطلوب ويجب ألا يقل عن حرفين ولا يتجاوز 255 حرفاً",
      });
    }

    let validatedTooth = null;
    if (
      tooth_number !== undefined &&
      tooth_number !== null &&
      tooth_number !== ""
    ) {
      const parsedTooth = parseInt(tooth_number, 10);
      if (isNaN(parsedTooth) || !VALID_FDI_TEETH.has(parsedTooth)) {
        return res.status(400).json({
          error:
            "رقم السن غير صالح بنظام FDI (يدعم الأسنان الدائمة 11–48 واللبنية للأطفال 51–85)",
        });
      }
      validatedTooth = parsedTooth;
    }

    const validatedSurface = normalizeSurfaceCode(
      surface !== undefined ? surface : surfaces,
    );
    if (validatedSurface === "__INVALID__") {
      return res.status(400).json({
        error: "رمز السطح غير صالح. الأسطح المسموحة هي M, O, D, B, L, I فقط",
      });
    }

    let validatedResultingCondition = null;
    const rawCondition =
      resulting_condition !== undefined &&
      resulting_condition !== null &&
      resulting_condition !== ""
        ? String(resulting_condition).trim().toLowerCase()
        : codeRow?.resulting_condition || null;

    if (rawCondition) {
      if (!VALID_CONDITIONS.has(rawCondition)) {
        return res.status(400).json({
          error: "الحالة الناتجة للسن غير صالحة",
        });
      }
      validatedResultingCondition = rawCondition;
    }

    const cleanMaterial =
      typeof material === "string" && material.trim()
        ? material.trim().slice(0, 50)
        : null;

    const rawCost =
      estimated_cost !== undefined &&
      estimated_cost !== null &&
      estimated_cost !== ""
        ? estimated_cost
        : codeRow?.default_price;

    const cost = parseFloat(rawCost);
    if (isNaN(cost) || cost < 0 || !isFinite(cost)) {
      return res.status(400).json({
        error: "التكلفة التقديرية يجب أن تكون رقماً صالحاً وغير سالب",
      });
    }

    if (cost > 99999999.99) {
      return res.status(400).json({
        error: "التكلفة التقديرية تتجاوز الحد الأقصى المسموح به",
      });
    }

    const costFixed = (Math.round(cost * 100) / 100).toFixed(2);

    const planCheck = await pool.query(
      `SELECT tp.id, tp.status, p.is_active
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       WHERE tp.id = $1
         AND tp.clinic_id = $2
         AND p.clinic_id = $2`,
      [planId, clinicId],
    );

    if (planCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "خطة العلاج غير موجودة في هذه العيادة" });
    }

    if (planCheck.rows[0].is_active === false) {
      return res.status(400).json({
        error: "لا يمكن تعديل خطة علاج مريض مؤرشف",
      });
    }

    if (
      planCheck.rows[0].status === "completed" ||
      planCheck.rows[0].status === "cancelled"
    ) {
      return res.status(400).json({
        error: `لا يمكن إضافة بنود جديدة لخطة علاج ${
          planCheck.rows[0].status === "completed" ? "مكتملة" : "ملغاة"
        }`,
      });
    }

    const query = `
      INSERT INTO treatment_plan_items (
        clinic_id,
        plan_id,
        procedure_code_id,
        tooth_number,
        surface,
        resulting_condition,
        material,
        diagnosis,
        procedure_name,
        estimated_cost,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'planned')
      RETURNING *;
    `;

    const result = await pool.query(query, [
      clinicId,
      planId,
      validatedProcedureCodeId,
      validatedTooth,
      validatedSurface,
      validatedResultingCondition,
      cleanMaterial,
      diagnosis && typeof diagnosis === "string" ? diagnosis.trim() : null,
      effectiveProcedureName,
      costFixed,
    ]);

    res.status(201).json({ item: result.rows[0] });
  } catch (error) {
    captureError(error, req);
    console.error("Error adding treatment plan item:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إضافة بند العلاج" });
  }
};

// 4. تحديث حالة بند العلاج + التحديث التلقائي للشارت والأسطح داخل نفس الـ Transaction
const updatePlanItemStatus = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const userId = req.user.id;
  const { itemId } = req.params;
  const { status, resulting_condition, material } = req.body || {};

  if (!isValidUuid(itemId)) {
    return res.status(400).json({ error: "معرّف بند العلاج غير صالح" });
  }

  const validStatuses = ["planned", "in_progress", "completed"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error:
        "حالة الإجراء غير صالحة. الحالات المسموحة: planned, in_progress, completed",
    });
  }

  if (
    resulting_condition !== undefined &&
    resulting_condition !== null &&
    resulting_condition !== "" &&
    !VALID_CONDITIONS.has(String(resulting_condition).toLowerCase())
  ) {
    return res.status(400).json({
      error: "الحالة الناتجة للسن غير صالحة",
    });
  }

  let client;
  let broken = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const itemCheck = await client.query(
      `SELECT
         tpi.id,
         tpi.plan_id,
         tpi.tooth_number,
         tpi.surface,
         tpi.procedure_code_id,
         tpi.procedure_name,
         tpi.resulting_condition,
         tpi.material,
         tpi.diagnosis,
         tpi.status,
         tpi.invoice_id,
         tp.patient_id,
         tp.status AS plan_status,
         p.is_active,
         pc.resulting_condition AS code_resulting_condition
       FROM treatment_plan_items tpi
       JOIN treatment_plans tp
         ON tpi.plan_id = tp.id
        AND tp.clinic_id = tpi.clinic_id
       JOIN patients p
         ON p.id = tp.patient_id
        AND p.clinic_id = tpi.clinic_id
       LEFT JOIN procedure_codes pc
         ON pc.id = tpi.procedure_code_id
        AND pc.clinic_id = tpi.clinic_id
       WHERE tpi.id = $1
         AND tpi.clinic_id = $2
       FOR UPDATE OF tpi`,
      [itemId, clinicId],
    );

    if (itemCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "بند العلاج غير موجود في هذه العيادة" });
    }

    const item = itemCheck.rows[0];

    if (item.is_active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن تعديل خطة علاج مريض مؤرشف",
      });
    }

    if (item.invoice_id !== null) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن تعديل حالة هذا البند؛ تمت فوترته رسمياً بالفعل",
      });
    }

    if (item.plan_status === "cancelled" || item.plan_status === "completed") {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لا يمكن تعديل بنود خطة علاج مغلقة أو ملغاة" });
    }
    const isNewCompletion =
      status === "completed" && item.status !== "completed";

    const targetCondition =
      isNewCompletion && item.tooth_number !== null
        ? String(
            resulting_condition ||
              item.resulting_condition ||
              item.code_resulting_condition ||
              inferResultingCondition(item.procedure_name) ||
              "",
          )
            .trim()
            .toLowerCase()
        : null;

    if (
      isNewCompletion &&
      item.tooth_number !== null &&
      !VALID_CONDITIONS.has(targetCondition)
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          "حدد الحالة الناتجة للإجراء من بيانات الخدمة أو بند العلاج قبل إتمامه",
      });
    }

    if (item.status === "completed" && status !== "completed") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          "لا يمكن إرجاع بند مكتمل إلى حالة غير مكتملة بعد تسجيله في الشارت",
      });
    }
    const updateQuery = `
      UPDATE treatment_plan_items
      SET status = $1::varchar(50),
          completed_at = CASE
            WHEN $1::varchar(50) = 'completed'
                 AND status <> 'completed'
              THEN CURRENT_TIMESTAMP
            WHEN $1::varchar(50) = 'completed'
              THEN completed_at
            ELSE NULL
          END
      WHERE id = $2
        AND clinic_id = $3
        AND invoice_id IS NULL
      RETURNING *;
    `;

    const result = await client.query(updateQuery, [status, itemId, clinicId]);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "تعذر تحديث البند؛ ربما تمت فوترته أو لم يعد قابلاً للتعديل",
      });
    }

    const updatedItem = result.rows[0];
    let syncedTooth = null;

    // الربط التلقائي مع مخطط الأسنان والأسطح عند تحويل البند إلى completed
    if (
      status === "completed" &&
      item.status !== "completed" &&
      item.tooth_number !== null
    ) {
      const toothNum = Number(item.tooth_number);
      const dentition = toothNum >= 51 ? "deciduous" : "permanent";

      const targetMaterial =
        typeof material === "string" && material.trim()
          ? material.trim().slice(0, 50)
          : item.material || null;

      const autoNote = `تم إتمام إجراء خطة العلاج: ${item.procedure_name}`;

      // 1) تحديث أو إدخال السن في patient_teeth
      const upsertToothRes = await client.query(
        `INSERT INTO patient_teeth (
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
          condition = EXCLUDED.condition,
          notes = COALESCE(EXCLUDED.notes, patient_teeth.notes),
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;`,
        [
          clinicId,
          item.patient_id,
          toothNum,
          dentition,
          targetCondition,
          autoNote,
        ],
      );

      const toothRecord = upsertToothRes.rows[0];

      // 2) إذا كانت الحالة خلع أو زراعة، نمسح الأسطح القديمة؛ وإذا كان البند يحتوي على أسطح (مثل MOD) نحدث كل سطح
      if (["missing", "implant"].includes(targetCondition)) {
        await client.query(
          `DELETE FROM tooth_surfaces
           WHERE clinic_id = $1 AND tooth_record_id = $2`,
          [clinicId, toothRecord.id],
        );
      } else if (item.surface && /^[MODBLI]+$/.test(item.surface)) {
        const surfaceCodes = [...new Set(item.surface.split(""))];
        for (const sCode of surfaceCodes) {
          await client.query(
            `INSERT INTO tooth_surfaces (
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
              material = COALESCE(EXCLUDED.material, tooth_surfaces.material),
              notes = EXCLUDED.notes,
              updated_at = CURRENT_TIMESTAMP;`,
            [
              clinicId,
              toothRecord.id,
              sCode,
              targetCondition,
              targetMaterial,
              autoNote,
            ],
          );
        }
      }

      // 3) إضافة حركة تلقائية في tooth_history
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          clinicId,
          item.patient_id,
          toothNum,
          targetCondition,
          item.procedure_name,
          item.surface || null,
          targetMaterial,
          autoNote,
          userId,
        ],
      );

      syncedTooth = toothRecord;
    }

    await client.query("COMMIT");

    res.status(200).json({
      item: updatedItem,
      chart_synced: Boolean(syncedTooth),
      tooth: syncedTooth,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error updating plan item status:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تحديث حالة البند" });
  } finally {
    if (client) client.release(broken);
  }
};

// 5. تحويل البنود المكتملة إلى فاتورة (مع حماية الـ Connection والـ Rollback الكامل)
const convertPlanItemsToInvoice = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patientId } = req.params;
  const { itemIds, doctor_id } = req.body || {};

  if (!isValidUuid(patientId)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({
      error: "يرجى تحديد بند علاج مكتمل واحد على الأقل لإصدار الفاتورة",
    });
  }

  const hasInvalidId = itemIds.some((id) => !isValidUuid(id));
  if (hasInvalidId) {
    return res.status(400).json({
      error: "أحد معرّفات بنود العلاج المحددة غير صالح",
    });
  }

  let effectiveDoctorId = null;
  const hasDoctorId =
    doctor_id !== undefined && doctor_id !== null && doctor_id !== "";
  if (hasDoctorId) {
    if (!isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "معرّف الطبيب غير صالح" });
    }
    effectiveDoctorId = doctor_id;
  } else if (req.user.role === "Doctor") {
    effectiveDoctorId = req.user.id;
  }

  let client;
  let broken = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    if (hasDoctorId) {
      const docCheck = await client.query(
        "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor';",
        [effectiveDoctorId, clinicId],
      );
      if (docCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "الطبيب المحدد غير تابع لهذه العيادة" });
      }
    }

    const patientCheck = await client.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patientId, clinicId],
    );

    if (patientCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "المريض غير موجود في هذه العيادة أو تمت أرشفته" });
    }

    const lockQuery = `
      SELECT tpi.id, tpi.tooth_number, tpi.surface, tpi.procedure_name, tpi.estimated_cost, tpi.invoice_id, tpi.status
      FROM treatment_plan_items tpi
      JOIN treatment_plans tp ON tpi.plan_id = tp.id
      WHERE tpi.id = ANY($1::uuid[])
        AND tpi.clinic_id = $2
        AND tp.patient_id = $3
        AND tp.clinic_id = $2
        AND tpi.status = 'completed'
        AND tpi.invoice_id IS NULL
      FOR UPDATE OF tpi;
    `;

    const lockedItemsRes = await client.query(lockQuery, [
      itemIds,
      clinicId,
      patientId,
    ]);
    const itemsToInvoice = lockedItemsRes.rows;

    if (itemsToInvoice.length !== itemIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "تعذر إصدار الفاتورة: بعض البنود لا تخص هذا المريض، أو غير مكتملة، أو تم إصدار فاتورة لها مسبقاً",
      });
    }

    const totalAmountInCents = itemsToInvoice.reduce((sum, it) => {
      const itemCostInCents = Math.round(parseFloat(it.estimated_cost) * 100);
      return sum + itemCostInCents;
    }, 0);

    if (totalAmountInCents <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن إصدار فاتورة بإجمالي صفر.",
      });
    }

    if (totalAmountInCents > 9_999_999_999) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "إجمالي الفاتورة كبير جداً ويتجاوز الحد الأقصى للنظام",
      });
    }

    const finalTotalAmount = (totalAmountInCents / 100).toFixed(2);

    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, doctor_id, total_amount, status)
      VALUES ($1, $2, $3, $4, 'unpaid')
      RETURNING *;
    `;
    const invoiceRes = await client.query(insertInvoiceQuery, [
      clinicId,
      patientId,
      effectiveDoctorId,
      finalTotalAmount,
    ]);
    const newInvoice = invoiceRes.rows[0];

    const insertInvoiceItemQuery = `
      INSERT INTO invoice_items (clinic_id, invoice_id, description, quantity, unit_price, total_price)
      VALUES ($1, $2, $3, 1, $4, $4);
    `;

    for (const item of itemsToInvoice) {
      const surfaceLabel = item.surface ? ` (${item.surface})` : "";
      const toothLabel = item.tooth_number
        ? `سن #${item.tooth_number}${surfaceLabel}: `
        : "";
      const description = `${toothLabel}${item.procedure_name}`.slice(0, 255);
      const itemPrice = (
        Math.round(parseFloat(item.estimated_cost) * 100) / 100
      ).toFixed(2);
      await client.query(insertInvoiceItemQuery, [
        clinicId,
        newInvoice.id,
        description,
        itemPrice,
      ]);
    }

    const updatePlanItemsQuery = `
      UPDATE treatment_plan_items
      SET invoice_id = $1
      WHERE id = ANY($2::uuid[]) AND clinic_id = $3;
    `;
    await client.query(updatePlanItemsQuery, [
      newInvoice.id,
      itemIds,
      clinicId,
    ]);

    await client.query("COMMIT");

    try {
      if (clinicId) {
        await logActivity({
          clinic_id: clinicId,
          user_id: req.user.id,
          action: "CONVERT_PLAN_TO_INVOICE",
          entity_type: "invoice",
          entity_id: newInvoice.id,
          description: `قام ${
            req.user.name || "الموظف"
          } بتحويل ${itemsToInvoice.length} بند من خطة العلاج لفاتورة جديدة بقيمة ${finalTotalAmount} ج.م للمريض #${patientId.slice(0, 8)}`,
          metadata: {
            invoice_id: newInvoice.id,
            doctor_id: effectiveDoctorId,
            items_count: itemsToInvoice.length,
            total_amount: finalTotalAmount,
          },
        });
      }
    } catch (auditErr) {
      console.error(
        "Audit log failed for convertPlanItemsToInvoice:",
        auditErr.message,
      );
    }

    res.status(201).json({
      message: "تم إصدار الفاتورة وتأمين بنود خطة العلاج بنجاح",
      invoice: newInvoice,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = true;
        console.error("Rollback failed:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error converting treatment plan to invoice:", error.message);
    res
      .status(500)
      .json({ error: "خطأ في السيرفر أثناء تحويل خطة العلاج لفاتورة" });
  } finally {
    if (client) client.release(broken);
  }
};

// 6. تحديث حالة خطة العلاج
const updateTreatmentPlanStatus = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { planId } = req.params;
    const { status } = req.body || {};

    if (!isValidUuid(planId)) {
      return res.status(400).json({ error: "معرّف الخطة غير صالح" });
    }

    const validStatuses = ["active", "completed", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error:
          "حالة الخطة غير صالحة. الحالات المسموحة: active, completed, cancelled",
      });
    }

    const query = `
      UPDATE treatment_plans
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND clinic_id = $3
      RETURNING *;
    `;

    const result = await pool.query(query, [status, planId, clinicId]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "خطة العلاج غير موجودة في هذه العيادة" });
    }

    const updatedPlan = result.rows[0];

    try {
      if (clinicId) {
        await logActivity({
          clinic_id: clinicId,
          user_id: req.user.id,
          action: "UPDATE_TREATMENT_PLAN_STATUS",
          entity_type: "treatment_plan",
          entity_id: planId,
          description: `تم تغيير حالة خطة العلاج (${updatedPlan.title}) إلى ${status}`,
          metadata: {
            title: updatedPlan.title,
            new_status: status,
          },
        });
      }
    } catch (auditErr) {
      console.error(
        "Audit log failed for updateTreatmentPlanStatus:",
        auditErr.message,
      );
    }

    res.status(200).json({
      message: "تم تحديث حالة خطة العلاج بنجاح",
      plan: updatedPlan,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating treatment plan status:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تحديث حالة الخطة" });
  }
};

// 7. حذف بند علاجي
const deleteTreatmentPlanItem = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { itemId } = req.params;

    if (!isValidUuid(itemId)) {
      return res.status(400).json({ error: "معرّف البند غير صالح" });
    }

    const checkQuery = `
      SELECT tpi.id, tpi.invoice_id, tpi.procedure_name, tpi.tooth_number, tp.title AS plan_title
      FROM treatment_plan_items tpi
      JOIN treatment_plans tp ON tpi.plan_id = tp.id
      WHERE tpi.id = $1 AND tpi.clinic_id = $2;
    `;
    const checkRes = await pool.query(checkQuery, [itemId, clinicId]);

    if (checkRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "بند العلاج غير موجود في هذه العيادة" });
    }

    const item = checkRes.rows[0];

    if (item.invoice_id !== null) {
      return res.status(400).json({
        error: "لا يمكن حذف هذا البند؛ تم إصدار فاتورة رسمية له بالفعل",
      });
    }

    const delRes = await pool.query(
      `DELETE FROM treatment_plan_items
       WHERE id = $1
         AND clinic_id = $2
         AND invoice_id IS NULL
       RETURNING id;`,
      [itemId, clinicId],
    );

    if (delRes.rows.length === 0) {
      return res.status(409).json({
        error: "لا يمكن حذف هذا البند؛ تمت فوترته رسمياً أو تم حذفه بالفعل",
      });
    }

    const toothDesc = item.tooth_number ? `للسن #${item.tooth_number}` : "";

    try {
      if (clinicId) {
        await logActivity({
          clinic_id: clinicId,
          user_id: req.user.id,
          action: "DELETE_TREATMENT_PLAN_ITEM",
          entity_type: "treatment_plan_item",
          entity_id: itemId,
          description: `تم حذف بند (${item.procedure_name}) ${toothDesc} من خطة (${item.plan_title})`,
          metadata: {
            procedure_name: item.procedure_name,
            tooth_number: item.tooth_number,
          },
        });
      }
    } catch (auditErr) {
      console.error(
        "Audit log failed for deleteTreatmentPlanItem:",
        auditErr.message,
      );
    }

    res.status(200).json({
      message: "تم حذف بند العلاج بنجاح",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting treatment plan item:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء حذف بند العلاج" });
  }
};

module.exports = {
  getPatientTreatmentPlans,
  createTreatmentPlan,
  addTreatmentPlanItem,
  updatePlanItemStatus,
  convertPlanItemsToInvoice,
  updateTreatmentPlanStatus,
  deleteTreatmentPlanItem,
};
