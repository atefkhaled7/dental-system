const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const createLabOrder = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const {
      patient_id,
      doctor_id,
      appointment_id,
      lab_name,
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
    if (!lab_name || typeof lab_name !== "string" || lab_name.trim() === "") {
      return res.status(400).json({ error: "اسم المعمل مطلوب" });
    }

    const doctorCheck = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor'",
      [doctor_id, clinic_id]
    );
    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({
        error: "المستخدم المحدد غير مسجل كطبيب مصرح له في هذه العيادة",
      });
    }

    const patientCheck = await pool.query(
      "SELECT id FROM patients WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE",
      [patient_id, clinic_id]
    );
    if (patientCheck.rows.length === 0) {
      return res.status(400).json({
        error: "المريض غير موجود في هذه العيادة أو تمت أرشفته",
      });
    }

    if (appointment_id) {
      const apptCheck = await pool.query(
        "SELECT id FROM appointments WHERE id = $1 AND clinic_id = $2 AND patient_id = $3",
        [appointment_id, clinic_id, patient_id]
      );
      if (apptCheck.rows.length === 0) {
        return res.status(400).json({
          error: "الموعد المحدد لا يخص هذا المريض",
        });
      }
    }
    const addLabOrderQuery =
      "INSERT INTO lab_orders (clinic_id, patient_id, doctor_id, appointment_id, lab_name, design_software, case_number, expected_at, notes, lab_notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *";
    const result = await pool.query(addLabOrderQuery, [
      clinic_id,
      patient_id,
      doctor_id,
      appointment_id || null,
      lab_name,
      design_software || null,
      case_number || null,
      expected_at || null,
      notes || null,
      lab_notes || null,
    ]);
    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CREATE_LAB_ORDER",
        entity_type: "lab_order",
        entity_id: result.rows[0].id,
        description: `قام ${
          req.user.name || "الموظف"
        } بإنشاء طلب معمل (${lab_name.trim()}) للمريض #${patient_id.slice(
          0,
          8
        )}`,
        metadata: {
          lab_name: lab_name.trim(),
          case_number: case_number || null,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(201).json({
      message: "تم إرسال طلب المعمل بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "رقم الحالة مسجل بالفعل في هذه العيادة",
      });
    }
    if (error.code === "23514") {
      return res.status(400).json({
        error: "تاريخ الاستلام المتوقع يجب أن يكون بعد تاريخ الإرسال",
      });
    }
    captureError(error, req);
    console.error("Error creating lab order:", error);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء طلب المعمل" });
  }
};

const getLabOrders = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { status, lab_name, search, patient_id, page, limit } = req.query;

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
        lab_orders.lab_name,
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
      query += ` AND lab_orders.expected_at < CURRENT_DATE AND lab_orders.status NOT IN ('received', 'cancelled')`;
    } else if (status) {
      queryParams.push(status);
      query += ` AND lab_orders.status = $${queryParams.length}`;
    }
    if (lab_name) {
      queryParams.push(lab_name);
      query += ` AND lab_orders.lab_name = $${queryParams.length}`;
    }
    if (search && search.trim() !== "") {
      queryParams.push(`%${search.trim()}%`);
      query += ` AND (patients.name ILIKE $${queryParams.length} OR lab_orders.case_number ILIKE $${queryParams.length} OR lab_orders.lab_name ILIKE $${queryParams.length})`;
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

      query += ` LIMIT $${queryParams.length + 1} OFFSET $${
        queryParams.length + 2
      };`;
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

const updateLabOrderStatus = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;
    const { status } = req.body;

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

// تعديل بيانات وتفاصيل وملاحظات الطلب
const updateLabOrder = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;

    const allowedFields = [
      "lab_name",
      "case_number",
      "design_software",
      "expected_at",
      "notes",
      "lab_notes",
    ];

    const updateParts = [];
    const queryParams = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        queryParams.push(req.body[field] === "" ? null : req.body[field]);
        updateParts.push(`${field} = $${queryParams.length}`);
      }
    }

    if (updateParts.length === 0) {
      return res.status(400).json({
        error: "لا توجد بيانات لتعديلها",
      });
    }

    queryParams.push(id);
    const idParam = queryParams.length;

    queryParams.push(clinic_id);
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

    const result = await pool.query(query, queryParams);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "طلب المعمل غير موجود",
      });
    }

    res.status(200).json({
      message: "تم حفظ التعديلات بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "رقم الحالة مسجل بالفعل في هذه العيادة",
      });
    }
    captureError(error, req);
    console.error("Error updating lab order:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء تعديل طلب المعمل",
    });
  }
};

// جلب قائمة المعامل المميزة للعيادة
const getDistinctLabs = async (req, res) => {
  try {
    const { clinic_id } = req.user;
    const result = await pool.query(
      "SELECT DISTINCT lab_name FROM lab_orders WHERE clinic_id = $1 AND lab_name IS NOT NULL AND lab_name <> '' ORDER BY lab_name ASC",
      [clinic_id]
    );
    res.status(200).json({ labs: result.rows.map((r) => r.lab_name) });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching distinct labs:", error.message);
    res.status(500).json({ error: "فشل جلب قائمة المعامل" });
  }
};

// ضيف getDistinctLabs في module.exports:
module.exports = {
  createLabOrder,
  getLabOrders,
  updateLabOrderStatus,
  updateLabOrder,
  getDistinctLabs, // 👈
};
