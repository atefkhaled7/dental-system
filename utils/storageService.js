const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");

// فحص بيئة التشغيل
const isProduction = !!(
  process.env.VERCEL || process.env.NODE_ENV === "production"
);

// إعداد Cloudinary لو البيانات موجودة
const isCloudinaryConfigured = () => {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
};

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// مجلد التخزين المحلي (يُستخدم فقط في بيئة التطوير المحلي)
const localUploadDir = path.join(__dirname, "../uploads/patient-images");

if (!isProduction) {
  try {
    if (!fs.existsSync(localUploadDir)) {
      fs.mkdirSync(localUploadDir, { recursive: true });
    }
  } catch (e) {
    console.error("Failed to create local upload directory:", e.message);
  }
}

// 1. رفع الصورة
const uploadFile = async ({ buffer, filename, mimeType }) => {
  // أ) لو كلاوديناري مهيأ، ارفع عليه فوراً
  if (isCloudinaryConfigured()) {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: "curosta_patient_images",
          public_id: path.parse(filename).name,
          resource_type: "image",
          type: "authenticated",
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            key: result.public_id, // يحفظ: curosta_patient_images/clinic_...
            storage: "cloudinary",
            format: result.format,
          });
        },
      );
      uploadStream.end(buffer);
    });
  }

  // ب) 🚨 حماية الإنتاج: ممنوع نهائياً التخزين المحلي في os.tmpdir() على Vercel أو Production!
  if (isProduction) {
    const errorMsg =
      "CRITICAL: خدمة التخزين السحابي (Cloudinary) غير مُهيأة على السيرفر. تم رفض رفع الصورة لمنع فقدان بيانات الأشعة الطبية للمريض على بيئة Serverless.";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // ج) في بيئة التطوير المحلي فقط (Local Dev)
  const filePath = path.join(localUploadDir, filename);
  fs.writeFileSync(filePath, buffer);
  return { key: filename, storage: "local" };
};

// 2. قراءة الصورة كـ Stream محمي
const getFileStream = async (fileUrl) => {
  // إذا كان المفتاح خاص بكلاوديناري أو كلاوديناري مهيأ
  if (
    isCloudinaryConfigured() &&
    (fileUrl.startsWith("curosta_patient_images") || isProduction)
  ) {
    try {
      const signedUrl = cloudinary.url(fileUrl, {
        secure: true,
        resource_type: "image",
        type: "authenticated",
        sign_url: true,
      });

      const response = await fetch(signedUrl);
      if (!response.ok) {
        console.warn(
          `Cloudinary returned status ${response.status} for image: ${fileUrl}`,
        );
        return null;
      }

      return {
        // تحويل الـ Web Stream إلى Node Stream ليقبله res.pipe
        stream: Readable.fromWeb(response.body),
        contentType: response.headers.get("content-type"),
        contentLength: response.headers.get("content-length"),
      };
    } catch (err) {
      console.error("Cloudinary fetch error:", err.message);
      return null;
    }
  }

  // للتطوير المحلي فقط
  if (!isProduction) {
    const filePath = path.join(localUploadDir, fileUrl);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return {
      stream: fs.createReadStream(filePath),
      filePath,
    };
  }

  return null;
};

// 3. حذف الصورة
const deleteFile = async (publicId) => {
  if (
    isCloudinaryConfigured() &&
    publicId.startsWith("curosta_patient_images")
  ) {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: "image",
        type: "authenticated",
      });
    } catch (err) {
      console.error("Cloudinary delete error:", err.message);
    }
    return;
  }

  // للتطوير المحلي
  if (!isProduction) {
    const filePath = path.join(localUploadDir, publicId);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error("Local file delete error:", err.message);
      }
    }
  }
};

module.exports = {
  uploadFile,
  getFileStream,
  deleteFile,
  isCloudinaryConfigured,
};
