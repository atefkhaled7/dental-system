const authorizeRole = (...allowedRoles) => {
  return (req, res, next) => {
    // بنتأكد إن اليوزر موجود وإن وظيفته جوه قائمة الوظائف المسموح بيها
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: "Access Denied: You don't have permission to perform this action" 
      });
    }
    next(); // لو وظيفته مسموحة، افتحله الباب
  };
};

module.exports = authorizeRole;