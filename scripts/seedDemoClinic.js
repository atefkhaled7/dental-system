require("dotenv").config();
const { seedOrResetDemoClinicCli } = require("../services/demoClinicService");

const run = async () => {
  try {
    console.log("⏳ جاري تنظيف وبناء الحساب التجريبي المحدث (CUROSTA Demo)...");
    await seedOrResetDemoClinicCli();
    console.log("✅ تم تجهيز الحساب التجريبي بنجاح تام وبدون أي تعارضات!");
    console.log(
      "-------------------------------------------------------------",
    );
    console.log("👤 مدير العيادة (ClinicAdmin): demo@curosta.com");
    console.log("👩‍⚕️ الطبيبة المعالجة (Doctor):  doctor.demo@curosta.com");
    console.log("🔑 كلمة المرور للحسابين:      Demo@123456");
    console.log("🌐 رابط الحجز العام:           /c/curosta-demo");
    console.log(
      "-------------------------------------------------------------",
    );
  } catch (err) {
    console.error("❌ فشل تجهيز حساب الديمو:", err.message);
    process.exitCode = 1;
  }
};

run();