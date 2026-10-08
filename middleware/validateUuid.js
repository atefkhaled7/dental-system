const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidUuid = (val) =>
  typeof val === "string" && UUID_REGEX.test(val.trim());

const validateUuidParam = (req, res, next, value) => {
  if (!isValidUuid(value)) {
    return res.status(400).json({ error: "المعرّف المرسل غير صالح" });
  }
  next();
};

// بتسجّل الفحص على أسماء الباراميترز اللي في الـ router
const applyUuidParams = (router, names) => {
  names.forEach((name) => router.param(name, validateUuidParam));
};

module.exports = { applyUuidParams, UUID_REGEX, isValidUuid };
