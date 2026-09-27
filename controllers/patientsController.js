const pool = require("../db");

const PHONE_REGEX = /^\+?[0-9]{10,15}$/;

// دالة التحقق الموحدة
const validatePatientInput = ({
  name,
  phone_number,
  gender,
  date_of_birth,
}) => {
  // الاسم
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return "اسم المريض مطلوب ويجب أن يحتوي على حرفين على الأقل";
  }

  // رقم الهاتف
  if (
    !phone_number ||
    typeof phone_number !== "string" ||
    !PHONE_REGEX.test(phone_number.trim())
  ) {
    return "رقم الهاتف غير صحيح (أرقام فقط من 10 إلى 15 رقم مع إمكانية وجود + في البداية)";
  }

  // النوع
  if (
    gender &&
    (typeof gender !== "string" || !["Male", "Female"].includes(gender))
  ) {
    return "النوع يجب أن يكون Male أو Female";
  }

  // تاريخ الميلاد
  if (
    date_of_birth !== undefined &&
    date_of_birth !== null &&
    date_of_birth !== ""
  ) {
    if (typeof date_of_birth !== "string") {
      return "تاريخ الميلاد غير صالح";
    }

    const dob = new Date(date_of_birth);

    if (isNaN(dob.getTime())) {
      return "تاريخ الميلاد غير صالح";
    }

    if (dob > new Date()) {
      return "تاريخ الميلاد لا يمكن أن يكون في المستقبل";
    }
  }

  return null;
};

// 1. إضافة مريض
const addPatient = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { name, phone_number, gender, date_of_birth, medical_alerts } =
      req.body;

    // التحقق من المدخلات
    const validationError = validatePatientInput({
      name,
      phone_number,
      gender,
      date_of_birth,
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const cleanedDob =
      date_of_birth && date_of_birth.trim() !== "" ? date_of_birth : null;

    const query = `
      INSERT INTO patients (clinic_id, name, phone_number, gender, date_of_birth, medical_alerts, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING *;
    `;
    const values = [
      clinic_id,
      name.trim(),
      phone_number.trim(),
      gender || null,
      cleanedDob,
      medical_alerts || null,
    ];

    const result = await pool.query(query, values);
    res
      .status(201)
      .json({ message: "تم إضافة المريض بنجاح", patient: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(400)
        .json({ error: "رقم الهاتف موجود بالفعل لمريض آخر" });
    }
    console.error("Error adding patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 2. جلب قائمة المرضى النشطين
const getPatients = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { search, archived } = req.query;

    // لو باعت archived=true نجيب المؤرشفين (is_active = FALSE)، غير كدة النشطين (is_active = TRUE)
    const isActive = archived === "true" ? false : true;

    if (search) {
      const result = await pool.query(
        "SELECT * FROM patients WHERE clinic_id = $1 AND (name ILIKE $2 OR phone_number ILIKE $2) AND is_active = $3 ORDER BY created_at DESC",
        [clinicId, `%${search}%`, isActive]
      );
      return res.status(200).json({ patients: result.rows });
    }

    const result = await pool.query(
      "SELECT * FROM patients WHERE clinic_id = $1 AND is_active = $2 ORDER BY created_at DESC",
      [clinicId, isActive]
    );
    res.status(200).json({ patients: result.rows });
  } catch (err) {
    console.error("Error fetching patients:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 3. جلب بيانات مريض محدد
const getPatientById = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    const result = await pool.query(
      "SELECT * FROM patients WHERE id = $1 AND clinic_id = $2",
      [patientId, clinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    res.status(200).json({ patient: result.rows[0] });
  } catch (err) {
    console.error("Error fetching patient by ID:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 4. تعديل مريض
const updatePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;
    const { name, phone_number, gender, medical_alerts } = req.body;

    // نفس التحقق الصارم المطبق في الإضافة
    const validationError = validatePatientInput({
      name,
      phone_number,
      gender,
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const query = `
      UPDATE patients 
      SET 
        name = $1,
        phone_number = $2,
        gender = $3,
        medical_alerts = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5 AND clinic_id = $6 AND is_active = TRUE
      RETURNING *;
    `;

    const result = await pool.query(query, [
      name.trim(),
      phone_number.trim(),
      gender || null,
      medical_alerts || null,
      patientId,
      clinicId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود أو تمت أرشفته" });
    }

    res.status(200).json({
      message: "تم تحديث بيانات المريض بنجاح",
      patient: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(400)
        .json({ error: "رقم الهاتف موجود بالفعل لمريض آخر في العيادة" });
    }
    console.error("Error updating patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 5. أرشفة مريض (Soft Delete) مع حماية الصلاحيات
const deletePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;
    const userRole = req.user.role;

    // حماية: منع موظف الاستقبال من الأرشفة
    if (userRole !== "ClinicAdmin") {
      return res
        .status(403)
        .json({ error: "ليس لديك صلاحية أرشفة ملف المريض" });
    }

    const result = await pool.query(
      "UPDATE patients SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE RETURNING id, name",
      [patientId, clinicId]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "المريض غير موجود أو تمت أرشفته بالفعل" });
    }

    res
      .status(200)
      .json({ message: "تم أرشفة المريض بنجاح", patient: result.rows[0] });
  } catch (err) {
    console.error("Error deleting/archiving patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const restorePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    const result = await pool.query(
      "UPDATE patients SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND clinic_id = $2 AND is_active = FALSE RETURNING id, name",
      [patientId, clinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود في الأرشيف" });
    }

    res.status(200).json({
      message: "تمت استعادة المريض بنجاح إلى القائمة النشطة",
      patient: result.rows[0],
    });
  } catch (err) {
    console.error("Error restoring patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء استعادة المريض" });
  }
};

module.exports = {
  addPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
  restorePatient,
};
