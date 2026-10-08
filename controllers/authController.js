const pool = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { logActivity } = require("../utils/auditLogger");

const registerUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    }

    let targetClinicId = req.user.clinic_id;

    if (req.user.role === "SuperAdmin") {
      targetClinicId = req.body.clinic_id || null;
    } else if (req.user.role === "ClinicAdmin") {
      if (!["Doctor", "Receptionist"].includes(role)) {
        return res.status(403).json({
          error:
            "غير مصرح لك بمنح هذا الدور. الأدوار المتاحة: Doctor أو Receptionist فقط",
        });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (clinic_id, name, email, password, role) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, name, email, role, clinic_id;`,
      [targetClinicId, name, email.trim().toLowerCase(), hashedPassword, role]
    );

    res.status(201).json({
      message: "تم تسجيل المستخدم بنجاح",
      user: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل" });
    }
    console.error("Error registering user:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    // جلب بيانات المستخدم والعيادة والاشتراك في استعلام واحد لتسريع الـ Login
    const result = await pool.query(
      `
      SELECT
        users.*,
        clinics.is_active AS clinic_is_active,
        clinics.subscription_ends_at
      FROM users
      LEFT JOIN clinics ON users.clinic_id = clinics.id
      WHERE users.email = $1
      `,
      [normalizedEmail]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "بيانات الدخول غير صحيحة",
      });
    }
    const user = result.rows[0];

    // التأكد من كلمة المرور أولاً
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({
        error: "بيانات الدخول غير صحيحة",
      });
    }

    // فحص هل المستخدم معطل
    if (!user.is_active) {
      return res.status(403).json({
        error: "تم إيقاف حسابك من قبل إدارة العيادة. يرجى مراجعة المدير.",
      });
    }

    // التأكد من أن العيادة نشطة وتاريخ اشتراكها سارٍ (باستثناء السوبر أدمن)
    if (user.role !== "SuperAdmin") {
      if (!user.clinic_id || user.clinic_is_active === false) {
        return res.status(403).json({
          error: "تم تجميد حساب هذه العيادة. يرجى التواصل مع إدارة CUROSTA.",
        });
      }
      if (
        user.subscription_ends_at &&
        new Date(user.subscription_ends_at) < new Date()
      ) {
        return res.status(403).json({
          error:
            "انتهت فترة اشتراك العيادة. يرجى التواصل مع إدارة CUROSTA لتجديد الاشتراك.",
        });
      }
    }

    // تضمين token_version في التوكن لدعم الـ Token Invalidation
    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        clinic_id: user.clinic_id,
        token_version: user.token_version || 1,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "12h",
      }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        clinic_id: user.clinic_id,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      error: "Server Error",
    });
  }
};

const registerClinic = async (req, res) => {
  let client;

  try {
    const { clinic_name, phone_number, admin_name, email, password } = req.body;

    if (!clinic_name || !clinic_name.trim()) {
      return res.status(400).json({
        error: "اسم العيادة مطلوب",
      });
    }

    if (!admin_name || !admin_name.trim()) {
      return res.status(400).json({
        error: "اسم مدير العيادة مطلوب",
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        error: "البريد الإلكتروني مطلوب",
      });
    }

    if (!password || !password.trim()) {
      return res.status(400).json({
        error: "كلمة المرور مطلوبة",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        error: "البريد الإلكتروني غير صالح",
      });
    }

    client = await pool.connect();

    await client.query("BEGIN");

    const clinicResult = await client.query(
      `
      INSERT INTO clinics (name, phone_number)
      VALUES ($1, $2)
      RETURNING id, name, phone_number
      `,
      [clinic_name.trim(), phone_number?.trim() || null]
    );

    const newClinic = clinicResult.rows[0];

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      `
      INSERT INTO users (
        clinic_id,
        name,
        email,
        password,
        role
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, role, clinic_id
      `,
      [
        newClinic.id,
        admin_name.trim(),
        email.trim().toLowerCase(),
        hashedPassword,
        "ClinicAdmin",
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Clinic and admin user registered successfully",
      clinic: newClinic,
      admin: userResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError.message);
      }
    }

    if (error.code === "23505") {
      return res.status(400).json({
        error: "البريد الإلكتروني مسجل بالفعل",
      });
    }

    console.error("Transaction error:", error.message);

    return res.status(500).json({
      error: "فشل التسجيل",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};

const getDoctors = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name
      FROM users
      WHERE clinic_id = $1
        AND role = 'Doctor'
        AND is_active = TRUE
      ORDER BY name ASC
      `,
      [req.user.clinic_id]
    );

    return res.status(200).json({
      doctors: result.rows,
    });
  } catch (error) {
    console.error("Error fetching doctors:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر",
    });
  }
};

// 5. تعديل الاسم الشخصي للمستخدم الحالي (متاح لجميع الأدوار)
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "الاسم مطلوب ويجب أن يحتوي على حرفين على الأقل" });
    }

    const result = await pool.query(
      `UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, email, role;`,
      [name.trim(), userId]
    );

    res.status(200).json({
      message: "تم تحديث اسمك بنجاح",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating profile:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تعديل الاسم" });
  }
};

// 6. تغيير كلمة المرور للمستخدم الحالي (متاح لجميع الأدوار)
const changePassword = async (req, res) => {
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

    // جلب الباسورد الحالي من الداتابيز للتحقق منه
    const userRes = await pool.query(
      "SELECT password FROM users WHERE id = $1",
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

    // تحديث كلمة المرور مع زيادة token_version لإبطال جميع الجلسات والتوكنات القديمة
    await pool.query(
      `UPDATE users 
       SET password = $1, 
           token_version = COALESCE(token_version, 1) + 1, 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [hashedPassword, userId]
    );

    try {
      await logActivity({
        clinic_id: req.user.clinic_id,
        user_id: userId,
        action: "CHANGE_PASSWORD",
        entity_type: "user",
        entity_id: userId,
        description: `قام ${
          req.user.name || "المستخدم"
        } بتغيير كلمة المرور الخاصة به وإبطال الجلسات السابقة`,
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({
      message: "تم تغيير كلمة المرور بنجاح، تم إنهاء الجلسات السابقة",
    });
  } catch (error) {
    console.error("Error changing password:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء تغيير كلمة المرور" });
  }
};

module.exports = {
  registerUser,
  loginUser,
  registerClinic,
  getDoctors,
  updateProfile,
  changePassword,
};
