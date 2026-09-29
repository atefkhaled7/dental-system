const pool = require("../db");
const jwt = require("jsonwebtoken");

const authMiddleware = async (req, res, next) => {
  let token = req.header("Authorization");
  if (!token) {
    return res.status(401).json({ error: "Access Denied: No Token Provided!" });
  }
  if (token.startsWith("Bearer ")) {
    token = token.slice(7, token.length).trimLeft();
  }

  // ① فحص التوكن نفسه — لو غلط، فعلاً 401
  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: "Invalid Token" });
  }

  req.user = verified;

  // ② سؤال الداتابيز عن حالة العيادة — لو فشل، الغلط في السيرفر مش في التوكن
  if (req.user.role !== "SuperAdmin" && req.user.clinic_id) {
    try {
      const clinicCheck = await pool.query(
        "SELECT is_active FROM clinics WHERE id = $1",
        [req.user.clinic_id]
      );

      if (clinicCheck.rows.length === 0 || !clinicCheck.rows[0].is_active) {
        return res.status(403).json({
          error:
            "تم إيقاف اشتراك هذه العيادة مؤقتاً. يرجى مراجعة إدارة المنصة.",
        });
      }
    } catch (dbError) {
      console.error("Error checking clinic status:", dbError.message);
      return res
        .status(500)
        .json({ error: "خطأ في السيرفر، برجاء المحاولة لاحقاً" });
    }
  }

  next();
};

module.exports = authMiddleware;
