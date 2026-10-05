const pool = require("../db");
const jwt = require("jsonwebtoken");

const authMiddleware = async (req, res, next) => {
  let token = req.header("Authorization");

  if (!token) {
    return res.status(401).json({
      error: "Access Denied: No Token Provided!",
    });
  }

  if (token.startsWith("Bearer ")) {
    token = token.slice(7).trimStart();
  }

  // ① التحقق من التوكن نفسه
  let verified;

  try {
    verified = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch (error) {
    return res.status(401).json({
      error: "Invalid Token",
    });
  }

  // لازم يكون فيه id للمستخدم داخل التوكن
  if (!verified.id) {
    return res.status(401).json({
      error: "Invalid Token",
    });
  }

  // ② جلب حالة المستخدم الحالية من الداتابيز
  try {
    const userCheck = await pool.query(
      `
      SELECT
        u.id,
        u.clinic_id,
        u.role,
        u.is_active,
        c.is_active AS clinic_active
      FROM users u
      LEFT JOIN clinics c ON u.clinic_id = c.id
      WHERE u.id = $1
      `,
      [verified.id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({
        error: "المستخدم غير موجود",
      });
    }

    const currentUser = userCheck.rows[0];

    // ③ المستخدم متوقف؟
    if (!currentUser.is_active) {
      return res.status(403).json({
        error: "تم إيقاف حسابك من قبل إدارة العيادة.",
      });
    }

    // ④ العيادة متوقفة؟
    if (
      currentUser.role !== "SuperAdmin" &&
      (!currentUser.clinic_id || !currentUser.clinic_active)
    ) {
      return res.status(403).json({
        error: "تم إيقاف اشتراك هذه العيادة مؤقتاً. يرجى مراجعة إدارة المنصة.",
      });
    }

    // ⑤ نستخدم البيانات الحالية من DB بدل القديمة داخل التوكن
    req.user = {
      ...verified,
      id: currentUser.id,
      clinic_id: currentUser.clinic_id,
      role: currentUser.role,
    };

    return next();
  } catch (dbError) {
    console.error("Error in authMiddleware:", dbError.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء التحقق من الحساب",
    });
  }
};

module.exports = authMiddleware;
