const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");
const crypto = require("crypto");

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
// 3. حذف الصورة من Cloudinary أو التخزين المحلي
const deleteFile = async (publicId) => {
  if (typeof publicId !== "string" || !publicId) return;

  if (isCloudinaryConfigured()) {
    let cloudinaryType = null;

    if (publicId.startsWith("curosta_patient_images/")) {
      cloudinaryType = "authenticated";
    } else if (publicId.startsWith("curosta_public_site/")) {
      cloudinaryType = "upload";
    }

    if (cloudinaryType) {
      try {
        const result = await cloudinary.uploader.destroy(publicId, {
          resource_type: "image",
          type: cloudinaryType,
        });

        if (result.result !== "ok" && result.result !== "not found") {
          console.warn("Cloudinary delete result:", result.result);
        }
      } catch (err) {
        console.error("Cloudinary delete error:", err.message);
      }

      return;
    }
  }

  // التخزين المحلي الحالي لصور المرضى فقط
  if (
    !isProduction &&
    !publicId.includes("/") &&
    !publicId.includes("\\") &&
    path.basename(publicId) === publicId
  ) {
    const filePath = path.join(localUploadDir, publicId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
};

// فحص الـ Magic Bytes الحقيقية للصورة (JPG / PNG / WEBP) لمنع الملفات التنفيذية المتنكرة
const verifyImageMagicBytes = (buffer) => {
  if (!buffer || buffer.length < 12) return false;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return false;
};

// 4. رفع صور موقع العيادة العام (شعار، غلاف، معرض صور) برابط مباشر
// رفع صور الموقع العام للعيادة بروابط Cloudinary عامة
const uploadPublicSiteImage = async ({ buffer, clinicId }) => {
  if (!Buffer.isBuffer(buffer)) {
    const err = new Error("ملف الصورة غير صالح");
    err.status = 400;
    throw err;
  }

  const realMime = verifyImageMagicBytes(buffer);

  if (!realMime) {
    const err = new Error("ملف الصورة غير صالح أو لا يطابق نوع الصورة المعلن");
    err.status = 400;
    throw err;
  }

  if (!clinicId || typeof clinicId !== "string") {
    const err = new Error("معرّف العيادة مطلوب لرفع الصورة");
    err.status = 400;
    throw err;
  }

  // لا نحفظ صور الموقع كـ Base64 داخل قاعدة البيانات
  if (!isCloudinaryConfigured()) {
    const err = new Error(
      "رفع صور الموقع يتطلب إعداد Cloudinary. راجع إعدادات التخزين.",
    );
    err.status = 503;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `curosta_public_site/${clinicId}`,
        public_id: crypto.randomUUID(),
        resource_type: "image",
        type: "upload",
        overwrite: false,
        allowed_formats: ["jpg", "jpeg", "png", "webp"],
      },
      (error, result) => {
        if (error) return reject(error);

        resolve({
          url: result.secure_url,
          key: result.public_id,
          storage: "cloudinary",
          mimeType: realMime,
        });
      },
    );

    uploadStream.end(buffer);
  });
};

module.exports = {
  uploadFile,
  getFileStream,
  deleteFile,
  isCloudinaryConfigured,
  uploadPublicSiteImage,
  verifyImageMagicBytes,
};
