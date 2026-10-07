const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");

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
    await logActivity({
      clinic_id,
      user_id: req.user.id,
      action: "CREATE_PATIENT",
      entity_type: "patient",
      entity_id: result.rows[0].id,
      description: `تمت إضافة مريض جديد (${result.rows[0].name})`,
    });

    return res.status(201).json({
      message: "تم إضافة المريض بنجاح",
      patient: result.rows[0],
    });
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

// 2. جلب قائمة المرضى مع الـ Pagination والبحث
// 2. جلب قائمة المرضى مع الـ Pagination والبحث
const getPatients = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { search, archived, page, limit } = req.query;

    // 1. حساب الـ Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    // 2. تحديد حالة الأرشفة (الافتراضي: المرضى النشطين فقط)
    const isActive = archived === "true" ? false : true;

    let query = `
      SELECT 
        id, 
        clinic_id, 
        name, 
        phone_number, 
        gender, 
        date_of_birth, 
        medical_alerts, 
        is_active, 
        created_at, 
        updated_at,
        COUNT(*) OVER() AS full_count
      FROM patients
      WHERE clinic_id = $1 AND is_active = $2
    `;

    const params = [clinicId, isActive];
    let paramCounter = 3;

    // 3. فلترة البحث (الاسم أو رقم الهاتف)
    if (search && search.trim() !== "") {
      query += ` AND (name ILIKE $${paramCounter} OR phone_number ILIKE $${paramCounter})`;
      params.push(`%${search.trim()}%`);
      paramCounter++;
    }

    // 4. الترتيب والتقسيم
    query += ` ORDER BY created_at DESC LIMIT $${paramCounter} OFFSET $${
      paramCounter + 1
    };`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    // استخراج العدد الإجمالي من أول صف (إن وُجد)
    const total =
      result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;

    // إزالة full_count من بيانات المرضى لتبقى نظيفة
    const patients = result.rows.map(({ full_count, ...patient }) => patient);
    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      patients,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (err) {
    console.error("Error fetching patients:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب قائمة المرضى" });
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
    const { name, phone_number, gender, medical_alerts, date_of_birth } =
      req.body;

    // نفس التحقق الصارم المطبق في الإضافة
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
      date_of_birth && String(date_of_birth).trim() !== ""
        ? date_of_birth
        : null;

    const query = `
      UPDATE patients 
      SET 
        name = $1,
        phone_number = $2,
        gender = $3,
        medical_alerts = $4,
        date_of_birth = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6 AND clinic_id = $7 AND is_active = TRUE
      RETURNING *;
    `;

    const result = await pool.query(query, [
      name.trim(),
      phone_number.trim(),
      gender || null,
      medical_alerts || null,
      cleanedDob,
      patientId,
      clinicId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود أو تمت أرشفته" });
    }

    await logActivity({
      clinic_id,
      user_id: req.user.id,
      action: "UPDATE_PATIENT",
      entity_type: "patient",
      entity_id: patientId,
      description: `تم تعديل بيانات المريض (${result.rows[0].name})`,
    });

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
    await logActivity({
      clinic_id: clinicId,
      user_id: req.user.id,
      action: "ARCHIVE_PATIENT",
      entity_type: "patient",
      entity_id: patientId,
      description: `تمت ارشفة ملف المريض (${result.rows[0].name})`,
    });
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

    await logActivity({
      clinic_id: clinicId,
      user_id: req.user.id,
      action: "RESTORE_PATIENT",
      entity_type: "patient",
      entity_id: patientId,
      description: `تمت استعادت ملف المريض (${result.rows[0].name}) من الأرشيف`,
    });

    res.status(200).json({
      message: "تمت استعادة المريض بنجاح إلى القائمة النشطة",
      patient: result.rows[0],
    });
  } catch (err) {
    console.error("Error restoring patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء استعادة المريض" });
  }
};

// ==========================================
// 7. تصدير قائمة المرضى لملف Excel / CSV (معالجة التواريخ بدقة)
// ==========================================
const exportPatients = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;

    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بتصدير قاعدة بيانات المرضى",
      });
    }

    const query = `
      SELECT
        name,
        phone_number,
        gender,
        TO_CHAR(date_of_birth, 'DD/MM/YYYY') AS date_of_birth,
        medical_alerts,
        TO_CHAR(
          created_at AT TIME ZONE 'Africa/Cairo',
          'DD/MM/YYYY'
        ) AS created_at
      FROM patients
      WHERE clinic_id = $1
        AND is_active = TRUE
      ORDER BY name ASC;
    `;

    const result = await pool.query(query, [clinic_id]);

    const escapeCsvValue = (value) => {
      const stringValue = String(value ?? "");

      const safeValue = /^[=+\-@]/.test(stringValue)
        ? `'${stringValue}`
        : stringValue;

      return `"${safeValue.replace(/"/g, '""')}"`;
    };

    let csv =
      "\uFEFFاسم المريض,رقم الهاتف,النوع,تاريخ الميلاد,التنبيهات الطبية,تاريخ التسجيل\n";

    result.rows.forEach((p) => {
      const name = escapeCsvValue(p.name);
      const phone = escapeCsvValue(p.phone_number);

      const gender =
        p.gender === "Female" ? "أنثى" : p.gender === "Male" ? "ذكر" : "-";

      const dob = escapeCsvValue(p.date_of_birth || "-");
      const alerts = escapeCsvValue(p.medical_alerts || "-");
      const createdAt = escapeCsvValue(p.created_at || "-");

      csv += `${name},${phone},${gender},${dob},${alerts},${createdAt}\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=patients_${Date.now()}.csv`
    );

    return res.status(200).send(csv);
  } catch (err) {
    console.error("Error exporting patients:", err.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تصدير المرضى",
    });
  }
};

module.exports = {
  addPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
  restorePatient,
  exportPatients,
};
