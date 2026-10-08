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
    console.warn(
      "⚠ Sentry is enabled but @sentry/node is not installed:",
      err.message
    );
  }
}

const captureError = (err, context = {}) => {
  if (Sentry && process.env.SENTRY_DSN) {
    Sentry.captureException(err, {
      extra: context,
    });
  }
};

module.exports = { captureError };
