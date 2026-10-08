const multer = require("multer");

// تخزين الملف في الذاكرة كـ Buffer للتعامل معه وفحص الـ Magic Bytes مباشرة
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error(
      "نوع الملف غير مدعوم. الأنواع المسموحة هي: JPG, PNG, WEBP فقط."
    );
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 ميجابايت كحد أقصى
  },
});

module.exports = upload;
