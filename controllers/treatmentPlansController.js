const pool = require("../db");

// 🦷 القائمة البيضاء لأرقام الأسنان الـ 32 بنظام FDI الدولي
const VALID_FDI_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33,
  34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
]);

// 1. جلب خطط علاج المريض مع التحقق من تبعية المريض للعيادة
const getPatientTreatmentPlans = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;

    // التحقق من أن المريض مسجل ونشط في هذه العيادة
    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2",
      [patientId, clinicId]
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
      SELECT tpi.* 
      FROM treatment_plan_items tpi
      JOIN treatment_plans tp ON tpi.plan_id = tp.id
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
    console.error("Error fetching treatment plans:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب خطط العلاج" });
  }
};

// 2. إنشاء خطة علاج جديدة مع التحقق الصارم
const createTreatmentPlan = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;
    const { title, notes } = req.body;

    // التحقق من عنوان الخطة
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

    // 🔒 التحقق الصارم من أن المريض موجود ونشط ويخص عيادة المستخدم
    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patientId, clinicId]
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
    console.error("Error creating treatment plan:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء خطة العلاج" });
  }
};

// 3. إضافة بند علاج لخطة مع منع التعديل على الخطط المقفولة وفحص الـ FDI
const addTreatmentPlanItem = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { planId } = req.params;
    const { tooth_number, diagnosis, procedure_name, estimated_cost } =
      req.body;

    // 1. التحقق من اسم الإجراء
    if (
      !procedure_name ||
      typeof procedure_name !== "string" ||
      procedure_name.trim().length < 2 ||
      procedure_name.trim().length > 255
    ) {
      return res
        .status(400)
        .json({ error: "اسم الإجراء الطبي مطلوب ويجب ألا يقل عن حرفين" });
    }

    // 2. التحقق من رقم السن (FDI Validation)
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
            "رقم السن غير صالح بنظام FDI (يجب أن يكون من أرقام الأسنان الـ 32 الصحيحة)",
        });
      }
      validatedTooth = parsedTooth;
    }

    // 3. التحقق المالي من التكلفة (بدون أرقام سالبة أو كسور غير منطقية)
    const cost = parseFloat(estimated_cost);
    if (isNaN(cost) || cost < 0 || !isFinite(cost)) {
      return res.status(400).json({
        error: "التكلفة التقديرية يجب أن تكون رقماً صالحاً وغير سالب",
      });
    }
    const costFixed = (Math.round(cost * 100) / 100).toFixed(2);

    // 4. 🔒 فحص الخطة: التأكد من تبعيتها للعيادة + منع التعديل على خطة مقفولة
    const planCheck = await pool.query(
      `SELECT tp.id, tp.status, p.is_active
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       WHERE tp.id = $1
         AND tp.clinic_id = $2
         AND p.clinic_id = $2`,
      [planId, clinicId]
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
      INSERT INTO treatment_plan_items (clinic_id, plan_id, tooth_number, diagnosis, procedure_name, estimated_cost, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'planned')
      RETURNING *;
    `;

    const result = await pool.query(query, [
      clinicId,
      planId,
      validatedTooth,
      diagnosis && typeof diagnosis === "string" ? diagnosis.trim() : null,
      procedure_name.trim(),
      costFixed,
    ]);

    res.status(201).json({ item: result.rows[0] });
  } catch (error) {
    console.error("Error adding treatment plan item:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إضافة بند العلاج" });
  }
};

// 4. تحديث حالة بند العلاج مع منع تعديل البنود المفوترة وفحص حالة الخطة
const updatePlanItemStatus = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { itemId } = req.params;
    const { status } = req.body;

    const validStatuses = ["planned", "in_progress", "completed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error:
          "حالة الإجراء غير صالحة. الحالات المسموحة: planned, in_progress, completed",
      });
    }

    // 🔒 فحص البند وحالته الحالية والخطة التابع لها
    const itemCheck = await pool.query(
      `SELECT
         tpi.id,
         tpi.status,
         tpi.invoice_id,
         tp.status AS plan_status,
         p.is_active
       FROM treatment_plan_items tpi
       JOIN treatment_plans tp ON tpi.plan_id = tp.id
       JOIN patients p ON p.id = tp.patient_id
       WHERE tpi.id = $1
         AND tpi.clinic_id = $2
         AND p.clinic_id = $2`,
      [itemId, clinicId]
    );

    if (itemCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "بند العلاج غير موجود في هذه العيادة" });
    }

    const item = itemCheck.rows[0];
    if (item.is_active === false) {
      return res.status(400).json({
        error: "لا يمكن تعديل خطة علاج مريض مؤرشف",
      });
    }

    // 1. منع تعديل أي بند تم إصدار فاتورة له
    if (item.invoice_id !== null) {
      return res.status(400).json({
        error: "لا يمكن تعديل حالة هذا البند؛ تمت فوترته رسمياً بالفعل",
      });
    }

    // 2. منع تعديل بنود خطة ملغاة أو مكتملة
    if (item.plan_status === "cancelled" || item.plan_status === "completed") {
      return res
        .status(400)
        .json({ error: "لا يمكن تعديل بنود خطة علاج مغلقة أو ملغاة" });
    }

    const query = `
      UPDATE treatment_plan_items 
      SET status = $1::varchar(50), 
          completed_at = CASE WHEN $1::varchar(50) = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = $2 AND clinic_id = $3
      RETURNING *;
    `;

    const result = await pool.query(query, [status, itemId, clinicId]);
    res.status(200).json({ item: result.rows[0] });
  } catch (error) {
    console.error("Error updating plan item status:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تحديث حالة البند" });
  }
};

// 🌟 5. تحويل البنود المكتملة إلى فاتورة (حسابات بالقروش + قفل السجلات + منع الفواتير الصفرية)
const convertPlanItemsToInvoice = async (req, res) => {
  const client = await pool.connect();
  try {
    const clinicId = req.user.clinic_id;
    const { patientId } = req.params;
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        error: "يرجى تحديد بند علاج مكتمل واحد على الأقل لإصدار الفاتورة",
      });
    }

    await client.query("BEGIN");

    // 1. التحقق من أن المريض موجود ونشط ويخص هذه العيادة
    const patientCheck = await client.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patientId, clinicId]
    );

    if (patientCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "المريض غير موجود في هذه العيادة أو تمت أرشفته" });
    }

    // 2. 🔒 قفل البنود مع التحقق الصارم بأنها تخص هذا المريض المحدد، ومكتملة، ولم تفوتر من قبل
    const lockQuery = `
      SELECT tpi.id, tpi.tooth_number, tpi.procedure_name, tpi.estimated_cost, tpi.invoice_id, tpi.status 
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

    // لو عدد البنود المقفولة لا يطابق المطلوب (معناه في بنود مش لنفس المريض أو غير مكتملة أو اتفوترت بالفعل)
    if (itemsToInvoice.length !== itemIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "تعذر إصدار الفاتورة: بعض البنود لا تخص هذا المريض، أو غير مكتملة، أو تم إصدار فاتورة لها مسبقاً",
      });
    }

    // 3. 💰 الحساب المالي بدون فواصل عائمة (Integer Cents Arithmetic)
    const totalAmountInCents = itemsToInvoice.reduce((sum, it) => {
      const itemCostInCents = Math.round(parseFloat(it.estimated_cost) * 100);
      return sum + itemCostInCents;
    }, 0);

    // 4. 🚫 منع الفواتير الصفرية (Zero Invoice Prevention)
    if (totalAmountInCents <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "لا يمكن إصدار فاتورة بإجمالي صفر. يجب أن تحتوي البنود على مبالغ صالحة أكبر من الصفر",
      });
    }

    const finalTotalAmount = (totalAmountInCents / 100).toFixed(2);

    // 5. إنشاء الفاتورة
    const insertInvoiceQuery = `
      INSERT INTO invoices (clinic_id, patient_id, total_amount, status)
      VALUES ($1, $2, $3, 'unpaid')
      RETURNING *;
    `;
    const invoiceRes = await client.query(insertInvoiceQuery, [
      clinicId,
      patientId,
      finalTotalAmount,
    ]);
    const newInvoice = invoiceRes.rows[0];

    // 6. إدخال البنود في جدول invoice_items
    const insertInvoiceItemQuery = `
      INSERT INTO invoice_items (clinic_id, invoice_id, description, quantity, unit_price, total_price)
      VALUES ($1, $2, $3, 1, $4, $4);
    `;

    for (const item of itemsToInvoice) {
      const toothLabel = item.tooth_number ? `سن #${item.tooth_number}: ` : "";
      const description = `${toothLabel}${item.procedure_name}`;
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

    // 7. قفل بنود خطة العلاج برقم الفاتورة الجديدة
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

    res.status(201).json({
      message: "تم إصدار الفاتورة وتأمين بنود خطة العلاج بنجاح",
      invoice: newInvoice,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error converting treatment plan to invoice:", error.message);
    res
      .status(500)
      .json({ error: "خطأ في السيرفر أثناء تحويل خطة العلاج لفاتورة" });
  } finally {
    client.release();
  }
};

module.exports = {
  getPatientTreatmentPlans,
  createTreatmentPlan,
  addTreatmentPlanItem,
  updatePlanItemStatus,
  convertPlanItemsToInvoice,
};
