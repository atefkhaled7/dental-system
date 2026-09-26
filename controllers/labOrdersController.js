const pool = require("../db");

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
    } = req.body;

    const doctorCheck = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND clinic_id = $2 AND role = 'Doctor'",
      [doctor_id, clinic_id]
    );

    if (doctorCheck.rows.length === 0) {
      return res.status(400).json({
        error: "المستخدم المحدد غير مسجل كطبيب مصرح له في هذه العيادة",
      });
    }

    if (!patient_id || !doctor_id || !lab_name) {
      return res
        .status(400)
        .json({ error: "patient_id, doctor_id, and lab_name are required" });
    }
    const addLabOrderQuery =
      "INSERT INTO lab_orders (clinic_id, patient_id, doctor_id, appointment_id, lab_name, design_software, case_number, expected_at, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *";
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
    ]);
    res.status(201).json({
      message: "تم إرسال طلب المعمل بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "A lab order with the same case number already exists",
      });
    }
    if (error.code === "23514") {
      return res.status(400).json({
        error: "تاريخ الاستلام المتوقع يجب أن يكون بعد تاريخ الإرسال",
      });
    }
    console.error("Error creating lab order:", error);
    res
      .status(500)
      .json({ error: "An error occurred while creating the lab order" });
  }
};

const getLabOrders = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { status } = req.query;

    let query = `
      SELECT 
        lab_orders.*,
        patients.name AS patient_name,
        patients.phone_number AS patient_phone,
        users.name AS doctor_name
      FROM lab_orders
      JOIN patients ON lab_orders.patient_id = patients.id
      JOIN users ON lab_orders.doctor_id = users.id
      WHERE lab_orders.clinic_id = $1
    `;
    const queryParams = [clinic_id];

    if (status) {
      queryParams.push(status);
      query += ` AND lab_orders.status = $${queryParams.length}`;
    }

    query += ` ORDER BY lab_orders.sent_at DESC;`;

    const result = await pool.query(query, queryParams);
    res.status(200).json({ lab_orders: result.rows });
  } catch (error) {
    console.error("Error fetching lab orders:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب طلبات المعمل" });
  }
};

const updateLabOrderStatus = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { id } = req.params;
    const { status } = req.body;

    if (!["ready", "received", "sent_to_lab"].includes(status)) {
      return res.status(400).json({ error: "الحالة غير صالحة" });
    }

    const updateQuery = `
      UPDATE lab_orders 
      SET 
        status = $1,
        ready_at = CASE WHEN $1 = 'ready' AND ready_at IS NULL THEN CURRENT_TIMESTAMP ELSE ready_at END,
        received_at = CASE WHEN $1 = 'received' AND received_at IS NULL THEN CURRENT_TIMESTAMP ELSE received_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND clinic_id = $3
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, [status, id, clinic_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "طلب المعمل غير موجود" });
    }

    res.status(200).json({
      message: "تم تحديث حالة طلب المعمل بنجاح",
      lab_order: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating lab order status:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة طلب المعمل" });
  }
};

module.exports = { createLabOrder, getLabOrders, updateLabOrderStatus };
