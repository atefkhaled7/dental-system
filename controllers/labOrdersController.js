const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const VALID_EXPENSE_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "vodafone_cash",
  "instapay",
  "cheque",
  "other",
];

const normalizePaymentMethod = (raw) => {
  let m = String(raw || "cash")
    .toLowerCase()
    .trim();
  if (m === "transfer") m = "bank_transfer";
  if (m === "vodafonecash") m = "vodafone_cash";
  if (m === "insta_pay" || m === "insta-pay") m = "instapay";
  if (m === "check") m = "cheque";
  return m;
};

// حساب حالة سداد المعمل بما يتوافق مع chk_lab_orders_financials
const computeLabPaymentStatus = (costCents, paidCents) => {
  if (costCents <= 0 || paidCents <= 0) return "unpaid";
  if (paidCents >= costCents) return "paid";
  return "partially_paid";
};

// ==========================================
// 1. إنشاء طلب معمل جديد (مع التكلفة والمدفوع وربط المصروفات)
// ==========================================
const createLabOrder = async (req, res) => {
  let client;
  try {
    const clinic_id = req.user.clinic_id;
    const {
      patient_id,
      doctor_id,
      appointment_id,
      lab_id,
      lab_name,
      work_type,
      tooth_numbers,
      shade,
      cost,
      paid_amount,
      payment_method,
      design_software,
      case_number,
      expected_at,
      notes,
      lab_notes,
    } = req.body;

    if (!patient_id || !isValidUuid(patient_id)) {
      return res.status(400).json({ error: "معرّف المريض مطلوب وغير صالح" });
    }
    if (!doctor_id || !isValidUuid(doctor_id)) {
      return res.status(400).json({ error: "معرّف الطبيب مطلوب وغير صالح" });
    }
    if (appointment_id && !isValidUuid(appointment_id)) {
      return res.status(400).json({ error: "معرّف الموعد غير صالح" });
    }
    if (lab_id && !isValidUuid(lab_id)) {
      return res.status(400).json({ error: "معرّف المعمل غير صالح" });
    }

    // التحقق من التكلفة والمبلغ المدفوع بالقروش
    let costCents = 0;
    if (cost !== undefined && cost !== null && cost !== "") {
      const parsedCost = Number(cost);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        return res
          .status(400)
          .json({ error: "تكلفة المعمل يجب أن تكون رقماً غير سالب" });
      }
      costCents = Math.round(parsedCost * 100);
    }

    let paidCents = 0;
    if (
      paid_amount !== undefined &&
      paid_amount !== null &&
      paid_amount !== ""
    ) {
      const parsedPaid = Number(paid_amount);
      if (!Number.isFinite(parsedPaid) || parsedPaid < 0) {
        return res
          .status(400)
          .json({ error: "المبلغ المدفوع للمعمل يجب أن يكون رقماً غير سالب" });
      }
      paidCents = Math.round(parsedPaid * 100);
    }

    if (paidCents > costCents) {
      return res.status(400).json({
        error: "المبلغ المدفوع للمعمل لا يمكن أن يتجاوز إجمالي تكلفة الطلب",
      });
    }

    const cleanPaymentStatus = computeLabPaymentStatus(costCents, paidCents);
    const cleanMethod = normalizePaymentMethod(payment_method);

    if (paidCents > 0 && !VALID_EXPENSE_METHODS.includes(cleanMethod)) {
      return res.status(400).json({ error: "طريقة دفع المعمل غير صالحة" });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const doctorCheck = await client.query(
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor'",
      [doctor_id, clinic_id],
    );
    if (doctorCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "المستخدم المحدد غير مسجل كطبيب مصرح له في هذه العيادة",
      });
    }

    const patientCheck = await client.query(
      "SELECT id, name FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patient_id, clinic_id],
    );
    if (patientCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    if (appointment_id) {
      const apptCheck = await client.query(
        "SELECT id FROM appointments WHERE id = $1 AND clinic_id = $2 AND patient_id = $3",
        [appointment_id, clinic_id, patient_id],
      );
      if (apptCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "الموعد المحدد لا يخص هذا المريض",
        });
      }
    }

    // تحديد اسم ومعرف المعمل (يدعم الاختيار من دليل المعامل أو كتابة اسم جديد)
    let resolvedLabId = null;
    let resolvedLabName =
      typeof lab_name === "string" && lab_name.trim() !== ""
        ? lab_name.trim()
        : null;

    if (lab_id) {
      const labRes = await client.query(
        "SELECT id, name FROM labs WHERE id = $1 AND clinic_id = $2",
        [lab_id, clinic_id],
      );
      if (labRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "المعمل المحدد غير موجود" });
      }
      resolvedLabId = labRes.rows[0].id;
      resolvedLabName = labRes.rows[0].name;
    } else if (resolvedLabName) {
      // حفظ المعمل تلقائياً في دليل المعامل (labs) لو لم يكن مسجلاً من قبل
      const upsertLabRes = await client.query(
        `INSERT INTO labs (clinic_id, name)
         VALUES ($1, $2)
                  ON CONFLICT (clinic_id, name)
         DO UPDATE SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
         RETURNING id, name`,
        [clinic_id, resolvedLabName],
      );
      resolvedLabId = upsertLabRes.rows[0].id;
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "اسم المعمل مطلوب" });
    }

    const cleanCaseNumber =
      typeof case_number === "string" && case_number.trim() !== ""
        ? case_number.trim()
        : null;

    const addLabOrderQuery = `
      INSERT INTO lab_orders (
        clinic_id, patient_id, doctor_id, appointment_id,
        lab_id, lab_name, work_type, tooth_numbers, shade,
        cost, paid_amount, payment_status,
        design_software, case_number, expected_at, notes, lab_notes
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16, $17
      )
      RETURNING *
    `;

    const result = await client.query(addLabOrderQuery, [
      clinic_id,
      patient_id,
      doctor_id,
      appointment_id || null,
      resolvedLabId,
      resolvedLabName,
      typeof work_type === "string" && work_type.trim()
        ? work_type.trim()
        : null,
      typeof tooth_numbers === "string" && tooth_numbers.trim()
        ? tooth_numbers.trim()
        : null,
      typeof shade === "string" && shade.trim() ? shade.trim() : null,
      costCents / 100,
      paidCents / 100,
      cleanPaymentStatus,
      design_software || null,
      cleanCaseNumber,
      expected_at || null,
      notes || null,
      lab_notes || null,
    ]);

    const newLabOrder = result.rows[0];

    // لو تم دفع دفعة مقدمة للمعمل عند الإنشاء، نسجلها تلقائياً في مصروفات العيادة
    if (paidCents > 0) {
      await client.query(
        `INSERT INTO expenses (
           clinic_id, category, title, amount, payment_method,
           vendor_name, lab_order_id, notes, created_by
         )
         VALUES ($1, 'مدفوعات معامل الأسنان', $2, $3, $4, $5, $6, $7, $8)`,
        [
          clinic_id,
          `دفعة معمل (${resolvedLabName}) - مريض: ${patientCheck.rows[0].name}`,
          paidCents / 100,
          cleanMethod,
          resolvedLabName,
          newLabOrder.id,
          cleanCaseNumber ? `رقم الحالة: ${cleanCaseNumber}` : null,
          req.user.clinic_id ? req.user.id : null,
        ],
      );
    }

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CREATE_LAB_ORDER",
        entity_type: "lab_order",
        entity_id: newLabOrder.id,
        description: `قام ${
          req.user.name || "الموظف"
        } بإنشاء طلب معمل (${resolvedLabName}) بتكلفة ${costCents / 100} ج.م للمريض #${patient_id.slice(0, 8)}`,
        metadata: {
          lab_name: resolvedLabName,
          case_number: cleanCaseNumber,
          cost: costCents / 100,
          paid_amount: paidCents / 100,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(201).json({
      message: "تم إرسال طلب المعمل بنجاح",
      lab_order: newLabOrder,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});

    if (error.code === "23505") {
      return res.status(400).json({
        error: "رقم الحالة مسجل بالفعل في هذه العيادة",
      });
    }
    if (error.code === "23514") {
      return res.status(400).json({
        error: "تاريخ الاستلام المتوقع أو البيانات المالية غير صالحة",
      });
    }
    if (error.code === "22007" || error.code === "22008") {
      return res.status(400).json({
        error: "صيغة التاريخ غير صالحة",
      });
    }
    if (error.code === "22001") {
      return res.status(400).json({
        error: "أحد الحقول يتجاوز الحد الأقصى المسموح به من الحروف",
      });
    }

    captureError(error, req);
    console.error("Error creating lab order:", error);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء طلب المعمل" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 2. جلب طلبات المعمل مع التكاليف والمتبقي
// ==========================================
const getLabOrders = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const {
      status,
      payment_status,
      lab_name,
      search,
      patient_id,
      page,
      limit,
    } = req.query;

    if (patient_id && !isValidUuid(patient_id)) {
      return res.status(400).json({ error: "معرّف المريض في الفلتر غير صالح" });
    }

    let query = `
      SELECT 
        lab_orders.id AS id,
        lab_orders.clinic_id,
        lab_orders.patient_id,
        lab_orders.doctor_id,
        lab_orders.appointment_id,
        lab_orders.lab_id,
        lab_orders.lab_name,
        lab_orders.work_type,
        lab_orders.tooth_numbers,
        lab_orders.shade,
        lab_orders.cost,
        lab_orders.paid_amount,
        ROUND(GREATEST(0, lab_orders.cost - lab_orders.paid_amount), 2) AS remaining_amount,
        lab_orders.payment_status,
        lab_orders.design_software,
        lab_orders.case_number,
        lab_orders.status,
        lab_orders.sent_at,
        lab_orders.expected_at,
        lab_orders.ready_at,
        lab_orders.received_at,
        lab_orders.notes,
        lab_orders.lab_notes,
        patients.name AS patient_name,
        patients.phone_number AS patient_phone,
        users.name AS doctor_name,
        COUNT(*) OVER() AS full_count
      FROM lab_orders
      JOIN patients ON lab_orders.patient_id = patients.id AND patients.clinic_id = lab_orders.clinic_id
      JOIN users ON lab_orders.doctor_id = users.id AND users.clinic_id = lab_orders.clinic_id
      WHERE lab_orders.clinic_id = $1
    `;
    const queryParams = [clinic_id];

    if (status === "late") {
      query += ` AND lab_orders.expected_at < (NOW() AT TIME ZONE 'Africa/Cairo')::date AND lab_orders.status NOT IN ('received', 'cancelled')`;
    } else if (status) {
      queryParams.push(status);
      query += ` AND lab_orders.status = $${queryParams.length}`;
    }

    if (payment_status) {
      queryParams.push(payment_status);
      query += ` AND lab_orders.payment_status = $${queryParams.length}`;
    }

    if (lab_name) {
      queryParams.push(lab_name);
      query += ` AND lab_orders.lab_name = $${queryParams.length}`;
    }

    if (search && search.trim() !== "") {
      queryParams.push(`%${search.trim()}%`);
      query += ` AND (patients.name ILIKE $${queryParams.length} OR lab_orders.case_number ILIKE $${queryParams.length} OR lab_orders.lab_name ILIKE $${queryParams.length} OR lab_orders.work_type ILIKE $${queryParams.length})`;
    }

    if (patient_id) {
      queryParams.push(patient_id);
      query += ` AND lab_orders.patient_id = $${queryParams.length}`;
    }

    query += ` ORDER BY lab_orders.sent_at DESC`;

    const isPaginated = page !== undefined || limit !== undefined;
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      query += ` LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2};`;
      queryParams.push(limitNum, offset);

      const result = await pool.query(query, queryParams);
      const total =
        result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
      const lab_orders = result.rows.map(({ full_count, ...order }) => order);
      const totalPages = Math.ceil(total / limitNum) || 1;

      return res.status(200).json({
        lab_orders,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
        },
      });
    }

    const result = await pool.query(query + ";", queryParams);
    const lab_orders = result.rows.map(({ full_count, ...order }) => order);
    res.status(200).json({ lab_orders });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching lab orders:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب طلبات المعمل" });
  }
};

// ==========================================
// 3. تحديث حالة استلام طلب المعمل
// ==========================================
const updateLabOrderStatus = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف طلب المعمل غير صالح" });
    }

    if (!["ready", "received", "sent_to_lab", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "الحالة غير صالحة" });
    }

    const updateQuery = `
      UPDATE lab_orders 
      SET 
        status = $1::varchar,
        ready_at = CASE WHEN $1::varchar = 'ready' AND ready_at IS NULL THEN CURRENT_TIMESTAMP ELSE ready_at END,
        received_at = CASE WHEN $1::varchar = 'received' AND received_at IS NULL THEN CURRENT_TIMESTAMP ELSE received_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND clinic_id = $3
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, [status, id, clinic_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "طلب المعمل غير موجود" });
    }

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "UPDATE_LAB_ORDER_STATUS",
        entity_type: "lab_order",
        entity_id: id,
        description: `قام ${
          req.user.name || "الموظف"
        } بتحديث حالة طلب المعمل #${id.slice(0, 8)} إلى "${status}"`,
        metadata: {
          new_status: status,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({
      message: "تم تحديث حالة طلب المعمل بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating lab order status:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة طلب المعمل" });
  }
};

// ==========================================
// 4. تعديل بيانات وتكلفة طلب المعمل
// ==========================================
const updateLabOrder = async (req, res) => {
  let client;
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف طلب المعمل غير صالح" });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const existingRes = await client.query(
      "SELECT * FROM lab_orders WHERE id = $1 AND clinic_id = $2 FOR UPDATE",
      [id, clinic_id],
    );
    if (existingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "طلب المعمل غير موجود" });
    }
    const existingOrder = existingRes.rows[0];

    const allowedTextFields = [
      "work_type",
      "tooth_numbers",
      "shade",
      "case_number",
      "design_software",
      "expected_at",
      "notes",
      "lab_notes",
    ];

    const updateParts = [];
    const queryParams = [];
    let costChange = null;

    for (const field of allowedTextFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let val = req.body[field];

        if (typeof val === "string") {
          val = val.trim() === "" ? null : val.trim();
        }

        queryParams.push(val);
        updateParts.push(`${field} = $${queryParams.length}`);
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, "lab_id") ||
      Object.prototype.hasOwnProperty.call(req.body, "lab_name")
    ) {
      const { lab_id: newLabIdRaw, lab_name: newLabNameRaw } = req.body;
      let newLabId = null;
      let newLabName = null;

      if (newLabIdRaw) {
        if (!isValidUuid(newLabIdRaw)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "معرّف المعمل غير صالح" });
        }
        const labRes = await client.query(
          "SELECT id, name FROM labs WHERE id = $1 AND clinic_id = $2",
          [newLabIdRaw, clinic_id],
        );
        if (labRes.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "المعمل المحدد غير موجود" });
        }
        newLabId = labRes.rows[0].id;
        newLabName = labRes.rows[0].name;
      } else if (
        typeof newLabNameRaw === "string" &&
        newLabNameRaw.trim() !== ""
      ) {
        const upsertLabRes = await client.query(
          `INSERT INTO labs (clinic_id, name)
           VALUES ($1, $2)
           ON CONFLICT (clinic_id, name)
           DO UPDATE SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
           RETURNING id, name`,
          [clinic_id, newLabNameRaw.trim()],
        );
        newLabId = upsertLabRes.rows[0].id;
        newLabName = upsertLabRes.rows[0].name;
      } else {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "اسم المعمل لا يمكن أن يكون فارغاً" });
      }

      queryParams.push(newLabId);
      updateParts.push(`lab_id = $${queryParams.length}`);
      queryParams.push(newLabName);
      updateParts.push(`lab_name = $${queryParams.length}`);
    }

    // null / "" معناها "لم يتم إرسال التكلفة" بدل تصفيرها بالخطأ
    if (
      req.body.cost !== undefined &&
      req.body.cost !== null &&
      req.body.cost !== ""
    ) {
      const parsedCost = Number(req.body.cost);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "تكلفة المعمل يجب أن تكون رقماً غير سالب" });
      }
      const newCostCents = Math.round(parsedCost * 100);
      const currentPaidCents = Math.round(
        Number(existingOrder.paid_amount) * 100,
      );

      if (newCostCents < currentPaidCents) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `لا يمكن تقليل التكلفة عن المبلغ المدفوع فعلياً للمعمل (${currentPaidCents / 100} ج.م)`,
        });
      }

      const nextPayStatus = computeLabPaymentStatus(
        newCostCents,
        currentPaidCents,
      );

      costChange = {
        old_cost: Number(existingOrder.cost),
        new_cost: newCostCents / 100,
      };

      queryParams.push(newCostCents / 100);
      updateParts.push(`cost = $${queryParams.length}`);

      queryParams.push(nextPayStatus);
      updateParts.push(`payment_status = $${queryParams.length}`);
    }

    if (updateParts.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا توجد بيانات لتعديلها",
      });
    }

    queryParams.push(id, clinic_id);
    const idParam = queryParams.length - 1;
    const clinicParam = queryParams.length;

    const query = `
      UPDATE lab_orders
      SET
        ${updateParts.join(", ")},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $${idParam}
        AND clinic_id = $${clinicParam}
      RETURNING *;
    `;

    const result = await client.query(query, queryParams);
    await client.query("COMMIT");

    if (costChange) {
      try {
        await logActivity({
          clinic_id,
          user_id: req.user.id,
          action: "UPDATE_LAB_ORDER_COST",
          entity_type: "lab_order",
          entity_id: id,
          description: `قام ${
            req.user.name || "الموظف"
          } بتعديل تكلفة طلب المعمل #${id.slice(0, 8)} من ${costChange.old_cost} إلى ${costChange.new_cost} ج.م`,
          metadata: costChange,
        });
      } catch (auditError) {
        console.error("Audit log failed:", auditError);
      }
    }

    res.status(200).json({
      message: "تم حفظ التعديلات بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return res.status(400).json({
        error: "رقم الحالة مسجل بالفعل في هذه العيادة",
      });
    }
    if (error.code === "23514") {
      return res.status(400).json({
        error: "تاريخ الاستلام المتوقع أو البيانات المالية غير صالحة",
      });
    }
    if (error.code === "22007" || error.code === "22008") {
      return res.status(400).json({
        error: "صيغة التاريخ غير صالحة",
      });
    }
    if (error.code === "22001") {
      return res.status(400).json({
        error: "أحد الحقول يتجاوز الحد الأقصى المسموح به من الحروف",
      });
    }

    captureError(error, req);
    console.error("Error updating lab order:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء تعديل طلب المعمل",
    });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 5. تسجيل دفعة مالية لمعمل أسنان (مع قيدها في المصروفات)
// ==========================================
const recordLabOrderPayment = async (req, res) => {
  let client;
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;
    const { amount, payment_method, notes } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "معرّف طلب المعمل غير صالح" });
    }

    const payAmount = Number(amount);
    if (!Number.isFinite(payAmount) || payAmount < 0.01) {
      return res
        .status(400)
        .json({ error: "مبلغ الدفعة يجب أن يكون رقماً أكبر من الصفر" });
    }

    const cleanMethod = normalizePaymentMethod(payment_method);
    if (!VALID_EXPENSE_METHODS.includes(cleanMethod)) {
      return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
    }

    const payCents = Math.round(payAmount * 100);

    client = await pool.connect();
    await client.query("BEGIN");

    const orderRes = await client.query(
      "SELECT * FROM lab_orders WHERE id = $1 AND clinic_id = $2 FOR UPDATE",
      [id, clinic_id],
    );

    if (orderRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "طلب المعمل غير موجود" });
    }

    const order = orderRes.rows[0];
    const costCents = Math.round(Number(order.cost) * 100);
    const alreadyPaidCents = Math.round(Number(order.paid_amount) * 100);
    const remainingCents = Math.max(0, costCents - alreadyPaidCents);

    if (order.status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "لا يمكن تسجيل دفعة لطلب معمل ملغي",
      });
    }

    if (costCents <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "يرجى تحديد تكلفة طلب المعمل أولاً قبل تسجيل دفعة له",
      });
    }

    if (remainingCents <= 0 || order.payment_status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "طلب المعمل مسدد بالكامل بالفعل",
      });
    }

    if (payCents > remainingCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `المبلغ المدفوع يتجاوز المتبقي للمعمل (${remainingCents / 100} ج.م)`,
      });
    }

    const nextPaidCents = alreadyPaidCents + payCents;
    const nextStatus = computeLabPaymentStatus(costCents, nextPaidCents);

    const updatedOrderRes = await client.query(
      `UPDATE lab_orders
       SET paid_amount = $1,
           payment_status = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND clinic_id = $4
       RETURNING *`,
      [nextPaidCents / 100, nextStatus, id, clinic_id],
    );

    // تسجيل الدفعة تلقائياً في جدول مصروفات العيادة (expenses)
    const expenseRes = await client.query(
      `INSERT INTO expenses (
         clinic_id, category, title, amount, payment_method,
         vendor_name, lab_order_id, notes, created_by
       )
       VALUES ($1, 'مدفوعات معامل الأسنان', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        clinic_id,
        `سداد معمل (${order.lab_name || "معمل أسنان"})${order.case_number ? ` - حالة #${order.case_number}` : ""}`,
        payCents / 100,
        cleanMethod,
        order.lab_name || null,
        order.id,
        typeof notes === "string" && notes.trim() ? notes.trim() : null,
        req.user.clinic_id ? req.user.id : null,
      ],
    );

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "RECORD_LAB_PAYMENT",
        entity_type: "lab_order",
        entity_id: id,
        description: `قام ${
          req.user.name || "الموظف"
        } بتسجيل دفعة ${payCents / 100} ج.م لطلب المعمل #${id.slice(0, 8)}`,
        metadata: {
          amount: payCents / 100,
          payment_method: cleanMethod,
          total_paid: nextPaidCents / 100,
          payment_status: nextStatus,
          expense_id: expenseRes.rows[0].id,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({
      message: "تم تسجيل دفعة المعمل وإضافتها للمصروفات بنجاح",
      lab_order: updatedOrderRes.rows[0],
      expense: expenseRes.rows[0],
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    captureError(error, req);
    console.error("Error recording lab payment:", error.message);
    res.status(500).json({ error: "فشل تسجيل دفعة المعمل" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 6. جلب وإدارة دليل المعامل للعيادة
// ==========================================
const getDistinctLabs = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const [directoryRes, distinctNamesRes] = await Promise.all([
      pool.query(
        "SELECT id, name, phone, contact_person, specialties, is_active FROM labs WHERE clinic_id = $1 AND is_active = TRUE ORDER BY name ASC",
        [clinic_id],
      ),
      pool.query(
        "SELECT DISTINCT lab_name FROM lab_orders WHERE clinic_id = $1 AND lab_name IS NOT NULL AND lab_name <> '' ORDER BY lab_name ASC",
        [clinic_id],
      ),
    ]);

    const nameSet = new Set(directoryRes.rows.map((l) => l.name));
    distinctNamesRes.rows.forEach((r) => nameSet.add(r.lab_name));

    res.status(200).json({
      labs: Array.from(nameSet).sort((a, b) => a.localeCompare(b, "ar")),
      labs_directory: directoryRes.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching distinct labs:", error.message);
    res.status(500).json({ error: "فشل جلب قائمة المعامل" });
  }
};

const saveLabToDirectory = async (req, res) => {
  let client;
  try {
    const { clinic_id } = req.user;
    const { id, name, phone, contact_person, specialties } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "اسم المعمل مطلوب" });
    }

    const cleanName = name.trim();
    const cleanPhone = phone?.trim() || null;
    const cleanContact = contact_person?.trim() || null;
    const cleanSpecialties = specialties?.trim() || null;

    const caseInsensitiveConflict = await pool.query(
      `SELECT id
   FROM labs
   WHERE clinic_id = $1
     AND LOWER(name) = LOWER($2)
     AND name <> $2
   LIMIT 1`,
      [clinic_id, cleanName],
    );

    if (caseInsensitiveConflict.rows.length > 0) {
      return res.status(400).json({
        error:
          "يوجد معمل مسجل بهذا الاسم بالفعل، حتى لو اختلفت طريقة كتابة الحروف",
      });
    }

    // مسار تعديل معمل موجود عند إرسال id
    if (id !== undefined && id !== null && id !== "") {
      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "معرّف المعمل غير صالح" });
      }

      client = await pool.connect();
      await client.query("BEGIN");

      // 1. التحقق من وجود المعمل وتبعيته لعيادة المستخدم الحالي
      const labCheck = await client.query(
        "SELECT id, name FROM labs WHERE id = $1 AND clinic_id = $2 FOR UPDATE",
        [id, clinic_id],
      );

      if (labCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "المعمل غير موجود أو لا تملك صلاحية تعديله" });
      }

      const oldLab = labCheck.rows[0];

      // 2. منع تغيير الاسم إلى اسم مسجل بالفعل لمعمل آخر في العيادة نفسها
      if (cleanName !== oldLab.name) {
        const conflictCheck = await client.query(
          "SELECT id FROM labs WHERE clinic_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3",
          [clinic_id, cleanName, id],
        );
        if (conflictCheck.rows.length > 0) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "يوجد معمل آخر مسجل بهذا الاسم بالفعل في العيادة" });
        }
      }

      // 3. تحديث بيانات المعمل
      const updateLabRes = await client.query(
        `UPDATE labs
         SET name = $1,
             phone = $2,
             contact_person = $3,
             specialties = $4,
             is_active = TRUE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND clinic_id = $6
         RETURNING *`,
        [cleanName, cleanPhone, cleanContact, cleanSpecialties, id, clinic_id],
      );

      // 4. إذا تغير اسم المعمل، نحدّث أسماء الطلبات التابعة للعيادة نفسها لضمان الاتساق
      if (cleanName !== oldLab.name) {
        await client.query(
          `UPDATE lab_orders
           SET lab_name = $1, lab_id = $2
           WHERE clinic_id = $3
             AND (lab_id = $2 OR (lab_id IS NULL AND lab_name = $4))`,
          [cleanName, id, clinic_id, oldLab.name],
        );
      }

      await client.query("COMMIT");

      return res.status(200).json({
        message: "تم تحديث بيانات المعمل بنجاح",
        lab: updateLabRes.rows[0],
      });
    }

    // مسار الإضافة الجديد (أو التحديث التلقائي بالاسم عند عدم إرسال id)
    const result = await pool.query(
      `INSERT INTO labs (clinic_id, name, phone, contact_person, specialties)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (clinic_id, name)
       DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, labs.phone),
         contact_person = COALESCE(EXCLUDED.contact_person, labs.contact_person),
         specialties = COALESCE(EXCLUDED.specialties, labs.specialties),
         is_active = TRUE,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [clinic_id, cleanName, cleanPhone, cleanContact, cleanSpecialties],
    );

    res.status(201).json({
      message: "تم حفظ بيانات المعمل في الدليل بنجاح",
      lab: result.rows[0],
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ error: "يوجد معمل آخر مسجل بهذا الاسم بالفعل في العيادة" });
    }
    captureError(error, req);
    console.error("Error saving lab to directory:", error.message);
    res.status(500).json({ error: "فشل حفظ بيانات المعمل" });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  createLabOrder,
  getLabOrders,
  updateLabOrderStatus,
  updateLabOrder,
  recordLabOrderPayment,
  getDistinctLabs,
  saveLabToDirectory,
};
