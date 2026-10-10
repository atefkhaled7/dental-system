/**
 * CUROSTA - Centralized Error Monitoring (Sentry Integration)
 */

let Sentry = null;

if (process.env.SENTRY_DSN) {
  try {
    Sentry = require("@sentry/node");

    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    });

    console.log("✅ Sentry Error Monitoring initialized successfully.");
  } catch (err) {
    Sentry = null;
    console.warn("⚠ Sentry initialization failed:", err.message);
  }
}

const captureError = (error, reqOrContext = null) => {
  console.error("🔴 Server Error:", error?.message || error);

  if (!Sentry) return;

  Sentry.withScope((scope) => {
    if (reqOrContext && typeof reqOrContext === "object") {
      const isExpressRequest =
        typeof reqOrContext.method === "string" &&
        (typeof reqOrContext.originalUrl === "string" ||
          typeof reqOrContext.path === "string");

      const context = isExpressRequest
        ? {
            method: reqOrContext.method,
            url: reqOrContext.originalUrl || reqOrContext.path,
            ip: reqOrContext.ip,
            user_id: reqOrContext.user?.id,
            clinic_id: reqOrContext.user?.clinic_id,
            role: reqOrContext.user?.role,
          }
        : reqOrContext;

      if (context.method) {
        scope.setExtra("method", context.method);
      }

      if (context.url) {
        scope.setExtra("url", context.url);
      }

      if (context.ip) {
        scope.setExtra("ip", context.ip);
      }

      if (context.clinic_id) {
        scope.setTag("clinic_id", String(context.clinic_id));
      }

      if (context.role) {
        scope.setExtra("role", context.role);
      }

      if (context.user_id) {
        scope.setUser({ id: String(context.user_id) });
      }
    }

    Sentry.captureException(error);
  });
};

module.exports = { captureError };
