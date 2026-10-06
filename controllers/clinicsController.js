const pool = require("../db");
const bcrypt = require("bcrypt");

// ==========================================
// 1. إنشاء عيادة جديدة مع تحديد الخطة (تجريبي / شهري / سنوي)
// ==========================================
const createClinic = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      name,
      phone_number,
      subdomain,
      subscription_plan = "trial", // 'trial', 'monthly', 'yearly'
      admin_name,
      admin_email,
      admin_password,
    } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "اسم العيادة مطلوب" });
    }

    await client.query("BEGIN");

    // حساب فترة الاشتراك حسب الخطة
    let planInterval = "14 days";
    let subStatus = "trial";

    if (subscription_plan === "monthly") {
      planInterval = "1 month";
      subStatus = "active";
    } else if (subscription_plan === "yearly") {
      planInterval = "1 year";
      subStatus = "active";
    }

    // 1. إنشاء العيادة
    const clinicResult = await client.query(
      `INSERT INTO clinics (
         name, 
         phone_number, 
         subdomain, 
         is_active, 
         subscription_plan,
         subscription_status,
         subscription_starts_at, 
         subscription_ends_at
       )
       VALUES (
         $1, 
         $2, 
         $3, 
         TRUE, 
         $4,
         $5,
         CURRENT_TIMESTAMP, 
         (CURRENT_TIMESTAMP + ($6)::interval)
       )
       RETURNING *;`,
      [
        name.trim(),
        phone_number?.trim() || null,
        subdomain?.trim() || null,
        subscription_plan,
        subStatus,
        planInterval,
      ]
    );

    const newClinic = clinicResult.rows[0];
    let createdAdmin = null;

    // 2. إنشاء حساب الـ ClinicAdmin
    if (admin_email && admin_password) {
      const cleanEmail = admin_email.trim().toLowerCase();

      const existingUser = await client.query(
        "SELECT id FROM users WHERE email = $1",
        [cleanEmail]
      );

      if (existingUser.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "البريد الإلكتروني للأدمن مسجل بالفعل لمستخدم آخر",
        });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(admin_password, salt);

      const userResult = await client.query(
        `INSERT INTO users (clinic_id, name, email, password, role, is_active)
         VALUES ($1, $2, $3, $4, 'ClinicAdmin', TRUE)
         RETURNING id, name, email, role;`,
        [
          newClinic.id,
          admin_name?.trim() || "مدير العيادة",
          cleanEmail,
          hashedPassword,
        ]
      );

      createdAdmin = userResult.rows[0];
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "تم إنشاء العيادة وتفعيل الخطة بنجاح",
      clinic: newClinic,
      admin: createdAdmin,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating clinic:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء إنشاء العيادة" });
  } finally {
    client.release();
  }
};

// ==========================================
// 2. جلب العيادات مع بيانات الاشتراك والإحصائيات
// ==========================================
const getClinics = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      const query = `
        SELECT 
          c.id,
          c.name,
          c.phone_number,
          c.subdomain,
          c.is_active,
          c.subscription_plan,
          c.subscription_status,
          COALESCE(c.subscription_starts_at, c.created_at) AS subscription_starts_at,
          COALESCE(c.subscription_ends_at, c.created_at + INTERVAL '14 days') AS subscription_ends_at,
          c.default_appointment_duration,
          c.created_at,
          (SELECT COUNT(*) FROM users u WHERE u.clinic_id = c.id) AS staff_count,
          (SELECT COUNT(*) FROM patients p WHERE p.clinic_id = c.id AND p.is_active = TRUE) AS patients_count,
          (SELECT COUNT(*) FROM appointments a WHERE a.clinic_id = c.id) AS appointments_count,
          (SELECT u.name FROM users u WHERE u.clinic_id = c.id AND u.role = 'ClinicAdmin' LIMIT 1) AS admin_name,
          (SELECT u.email FROM users u WHERE u.clinic_id = c.id AND u.role = 'ClinicAdmin' LIMIT 1) AS admin_email
        FROM clinics c
        ORDER BY c.created_at DESC;
      `;
      const result = await pool.query(query);
      return res.status(200).json({ clinics: result.rows });
    }

    const result = await pool.query("SELECT * FROM clinics WHERE id = $1", [
      req.user.clinic_id,
    ]);
    res.status(200).json({ clinics: result.rows });
  } catch (err) {
    console.error("Error fetching clinics:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب العيادات" });
  }
};


// 3. تجديد أو ترقية الاشتراك (مع تحديث بداية الخطة وحفظ الأيام المتبقية)
const renewSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { plan } = req.body; // 'trial', 'monthly', 'yearly'

    if (req.user.role !== "SuperAdmin") {
      return res.status(403).json({ error: "غير مصرح لك بتعديل اشتراكات العيادات" });
    }

    const validPlans = ["trial", "monthly", "yearly"];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ error: "نوع الخطة غير صالح (trial, monthly, yearly)" });
    }

    let intervalStr = "14 days";
    let statusStr = "trial";

    if (plan === "monthly") {
      intervalStr = "1 month";
      statusStr = "active";
    } else if (plan === "yearly") {
      intervalStr = "1 year";
      statusStr = "active";
    }

    // 1. subscription_starts_at يتحدث لتاريخ اليوم (بداية الخطة الحالية)
    // 2. subscription_ends_at يحتفظ بالأيام المتبقية ويضيف عليها المدة الجديدة
    const result = await pool.query(
      `UPDATE clinics
       SET subscription_plan = $1,
           subscription_status = $2,
           subscription_starts_at = CURRENT_TIMESTAMP,
           subscription_ends_at = GREATEST(COALESCE(subscription_ends_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) + ($3)::interval,
           is_active = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *;`,
      [plan, statusStr, intervalStr, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res.status(200).json({
      message: "تم تفعيل الخطة بنجاح وإضافة الرصيد للعيادة",
      clinic: result.rows[0],
    });
  } catch (error) {
    console.error("Error renewing subscription:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تجديد الاشتراك" });
  }
};

// ==========================================
// 4. تعديل بيانات العيادة أو حالة النشاط
// ==========================================
const updateClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone_number, is_active } = req.body;

    if (req.user.role === "ClinicAdmin" && id !== req.user.clinic_id) {
      return res
        .status(403)
        .json({ error: "غير مصرح لك بتعديل بيانات عيادة أخرى" });
    }

    let activeStatus = undefined;
    if (req.user.role === "SuperAdmin" && typeof is_active === "boolean") {
      activeStatus = is_active;
    }

    const result = await pool.query(
      `UPDATE clinics 
       SET name = COALESCE($1, name), 
           phone_number = COALESCE($2, phone_number), 
           is_active = COALESCE($3, is_active), 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4 
       RETURNING *;`,
      [name?.trim() || null, phone_number?.trim() || null, activeStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res.status(200).json({
      message: "تم تحديث بيانات العيادة بنجاح",
      clinic: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating clinic:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// ==========================================
// 5. تعطيل عيادة
// ==========================================
const deleteClinic = async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== "SuperAdmin") {
      return res
        .status(403)
        .json({ error: "هذه الصلاحية خاصة بالسوبر أدمن فقط" });
    }

    const result = await pool.query(
      "UPDATE clinics SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العيادة غير موجودة" });
    }

    res
      .status(200)
      .json({ message: "تم تعطيل العيادة بنجاح", clinic: result.rows[0] });
  } catch (error) {
    console.error("Error deleting clinic:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

module.exports = {
  createClinic,
  getClinics,
  renewSubscription,
  updateClinic,
  deleteClinic,
};
