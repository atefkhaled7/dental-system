const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream"); // 👈 ضيف دي هنا

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

const localUploadDir = process.env.VERCEL
  ? path.join(os.tmpdir(), "patient-images")
  : path.join(__dirname, "../uploads/patient-images");

try {
  if (!fs.existsSync(localUploadDir)) {
    fs.mkdirSync(localUploadDir, { recursive: true });
  }
} catch (e) {}

// 1. رفع الصورة
const uploadFile = async ({ buffer, filename, mimeType }) => {
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
            key: result.public_id, // بيحفظ: curosta_patient_images/clinic_...
            storage: "cloudinary",
            format: result.format,
          });
        }
      );
      uploadStream.end(buffer);
    });
  } else {
    const filePath = path.join(localUploadDir, filename);
    fs.writeFileSync(filePath, buffer);
    return { key: filename, storage: "local" };
  }
};

// 2. قراءة الصورة كـ Stream محمي
const getFileStream = async (fileUrl) => {
  if (isCloudinaryConfigured()) {
    try {
      const signedUrl = cloudinary.url(fileUrl, {
        secure: true,
        resource_type: "image",
        type: "authenticated",
        sign_url: true,
      });

      const response = await fetch(signedUrl);
      if (!response.ok) {
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

  const filePath = path.join(localUploadDir, fileUrl);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return {
    stream: fs.createReadStream(filePath),
    filePath,
  };
};

// 3. حذف الصورة
const deleteFile = async (publicId) => {
  if (isCloudinaryConfigured()) {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: "image",
        type: "authenticated",
      });
    } catch (err) {
      console.error("Cloudinary delete error:", err.message);
    }
  } else {
    const filePath = path.join(localUploadDir, publicId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
};

module.exports = {
  uploadFile,
  getFileStream,
  deleteFile,
};
