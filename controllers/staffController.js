const pool = require("../db");
const bcrypt = require("bcrypt");
const { logActivity } = require("../utils/auditLogger");

// 1. جلب طاقم العيادة الحالية
const getClinicStaff = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;

    const result = await pool.query(
      `
      SELECT id, name, email, role, is_active, created_at
      FROM users
      WHERE clinic_id = $1
      ORDER BY created_at ASC
      `,
      [clinicId]
    );

    return res.status(200).json({
      staff: result.rows,
    });
  } catch (error) {
    console.error("Error fetching staff:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب الطاقم",
    });
  }
};

// 2. إضافة موظف جديد بالعيادة
const addStaffMember = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        error: "جميع الحقول مطلوبة",
      });
    }

    if (!["Doctor", "Receptionist"].includes(role)) {
      return res.status(400).json({
        error: "الدور يجب أن يكون Doctor أو Receptionist",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن لا تقل عن 8 أحرف",
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanName || !cleanEmail) {
      return res.status(400).json({
        error: "الاسم والبريد الإلكتروني مطلوبان",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO users (
        clinic_id,
        name,
        email,
        password,
        role,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, name, email, role, is_active, created_at;
    `;

    const result = await pool.query(query, [
      clinicId,
      cleanName,
      cleanEmail,
      hashedPassword,
      role,
    ]);

    return res.status(201).json({
      message: "تمت إضافة الموظف بنجاح",
      member: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "البريد الإلكتروني مسجل بالفعل لمستخدم آخر",
      });
    }

    console.error("Error adding staff member:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء إضافة الموظف",
    });
  }
};

// 3. تعطيل أو تفعيل حساب موظف
const toggleStaffStatus = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;

    // منع الأدمن من تعطيل نفسه
    if (targetUserId === req.user.id) {
      return res.status(400).json({
        error: "لا يمكنك تعطيل حسابك الشخصي",
      });
    }

    const query = `
      UPDATE users
      SET is_active = NOT is_active,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND clinic_id = $2
        AND role IN ('Doctor', 'Receptionist')
      RETURNING id, name, role, is_active;
    `;

    const result = await pool.query(query, [targetUserId, clinicId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "الموظف غير موجود في هذه العيادة",
      });
    }

    const updated = result.rows[0];

    await logActivity({
      clinic_id: clinicId,
      user_id: req.user.id,
      action: updated.is_active ? "ENABLE_STAFF" : "DISABLE_STAFF",
      entity_type: "user",
      entity_id: targetUserId,
      description: `قام ${req.user.name || "المدير"} بـ ${
        updated.is_active ? "تفعيل" : "إيقاف"
      } حساب الموظف (${updated.name}) دور: ${updated.role}`,
    });

    return res.status(200).json({
      message: updated.is_active
        ? "تم تفعيل الحساب بنجاح"
        : "تم إيقاف الحساب بنجاح",
      member: updated,
    });
  } catch (error) {
    console.error("Error toggling staff status:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تعديل حالة الحساب",
    });
  }
};

// 4. إعادة تعيين باسورد موظف
const resetStaffPassword = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف",
      });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    const query = `
 UPDATE users SET password = $1, token_version = COALESCE(token_version, 1) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND clinic_id = $3
        AND role IN ('Doctor', 'Receptionist')
      RETURNING id, name;
    `;

    const result = await pool.query(query, [
      hashedPassword,
      targetUserId,
      clinicId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "الموظف غير موجود في هذه العيادة",
      });
    }

    await logActivity({
      clinic_id: clinicId,
      user_id: req.user.id,
      action: "RESET_STAFF_PASSWORD",
      entity_type: "user",
      entity_id: targetUserId,
      description: `قام ${
        req.user.name || "المدير"
      } بإعادة تعيين كلمة مرور الموظف (${result.rows[0].name})`,
    });

    return res.status(200).json({
      message: "تمت إعادة تعيين كلمة المرور بنجاح",
    });
  } catch (error) {
    console.error("Error resetting staff password:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تعيين كلمة المرور",
    });
  }
};

// 5. تعديل اسم موظف بواسطة الأدمن
const updateStaffName = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;
    const { name } = req.body;

    if (!name || name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "الاسم مطلوب ويجب أن لا يقل عن حرفين" });
    }

    const result = await pool.query(
      `UPDATE users 
       SET name = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND clinic_id = $3 AND role IN ('Doctor', 'Receptionist')
       RETURNING id, name, role;`,
      [name.trim(), targetUserId, clinicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الموظف غير موجود" });
    }

    res
      .status(200)
      .json({ message: "تم تعديل اسم الموظف بنجاح", member: result.rows[0] });
  } catch (error) {
    console.error("Error updating staff name:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 6. تعديل الاسم الشخصي للمستخدم الحالي (متاح للجميع)
const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "الاسم مطلوب ويجب أن لا يقل عن حرفين" });
    }

    const result = await pool.query(
      `UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, email, role;`,
      [name.trim(), userId]
    );

    res
      .status(200)
      .json({ message: "تم تحديث اسمك بنجاح", user: result.rows[0] });
  } catch (error) {
    console.error("Error updating profile:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 7. تغيير كلمة المرور الشخصية للمستخدم الحالي (يتطلب الباسورد الحالي)
const changeMyPassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res
        .status(400)
        .json({ error: "يرجى إدخال كلمة المرور الحالية والجديدة" });
    }

    if (new_password.length < 8) {
      return res
        .status(400)
        .json({ error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف" });
    }

    // جلب الباسورد المشفر الحالي
    const userRes = await pool.query(
      `SELECT password FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const isMatch = await bcrypt.compare(
      current_password,
      userRes.rows[0].password
    );
    if (!isMatch) {
      return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

    await pool.query(
      `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [hashedPassword, userId]
    );

    res.status(200).json({ message: "تم تغيير كلمة المرور بنجاح" });
  } catch (error) {
    console.error("Error changing password:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

module.exports = {
  getClinicStaff,
  addStaffMember,
  toggleStaffStatus,
  resetStaffPassword,
  updateStaffName,
  updateMyProfile,
  changeMyPassword,
};
