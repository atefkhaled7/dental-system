const pool = require("../db");

const getAuditLogs = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;
    const { page, limit, entity_type, user_id } = req.query;

    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بعرض سجل نشاطات العيادة",
      });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT
        l.id,
        l.action,
        l.entity_type,
        l.entity_id,
        l.description,
        l.metadata,
        l.created_at,
        u.name AS user_name,
        u.role AS user_role,
        COUNT(*) OVER() AS full_count
      FROM audit_logs l
      LEFT JOIN users u
        ON l.user_id = u.id
       AND u.clinic_id = l.clinic_id
      WHERE l.clinic_id = $1
    `;

    const params = [clinic_id];
    let paramCounter = 2;

    if (entity_type && entity_type !== "all") {
      query += ` AND l.entity_type = $${paramCounter}`;
      params.push(entity_type);
      paramCounter++;
    }

    if (user_id) {
      query += ` AND l.user_id = $${paramCounter}`;
      params.push(user_id);
      paramCounter++;
    }

    query += `
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${paramCounter}
      OFFSET $${paramCounter + 1};
    `;

    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    const total =
      result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;

    const logs = result.rows.map(({ full_count, ...log }) => log);
    const totalPages = Math.ceil(total / limitNum) || 1;

    return res.status(200).json({
      logs,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب سجل النشاطات",
    });
  }
};

module.exports = { getAuditLogs };
