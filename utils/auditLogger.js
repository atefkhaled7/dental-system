const pool = require("../db");

/**
 * تسجيل العمليات المهمة في سجل العيادة.
 *
 * لو تم تمرير client داخل Transaction:
 * نستخدم SAVEPOINT حتى لا يؤدي فشل الـAudit إلى
 * إفساد الـTransaction الأصلية.
 */
const logActivity = async (
  {
    clinic_id,
    user_id,
    action,
    entity_type,
    entity_id = null,
    description,
    metadata = null,
  },
  client = null
) => {
  try {
    const db = client || pool;

    if (client) {
      await db.query("SAVEPOINT audit_log_savepoint");
    }

    try {
      await db.query(
        `INSERT INTO audit_logs (
          clinic_id,
          user_id,
          action,
          entity_type,
          entity_id,
          description,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          clinic_id,
          user_id || null,
          action,
          entity_type,
          entity_id,
          description,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      if (client) {
        await db.query("RELEASE SAVEPOINT audit_log_savepoint");
      }
    } catch (err) {
      if (client) {
        await db.query("ROLLBACK TO SAVEPOINT audit_log_savepoint");
      }

      console.error("Audit log error:", err.message);
    }
  } catch (err) {
    // حتى لو فشل إنشاء الـSAVEPOINT نفسه،
    // لا نحاول كسر العملية الأصلية عمدًا.
    console.error("Audit log error:", err.message);
  }
};

module.exports = { logActivity };
