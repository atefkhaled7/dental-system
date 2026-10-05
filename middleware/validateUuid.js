const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateUuidParam = (req, res, next, value) => {
  if (!UUID_REGEX.test(value)) {
    return res.status(400).json({ error: "المعرّف المرسل غير صالح" });
  }
  next();
};

// بتسجّل الفحص على أسماء الباراميترز اللي في الـ router
const applyUuidParams = (router, names) => {
  names.forEach((name) => router.param(name, validateUuidParam));
};

module.exports = { applyUuidParams, UUID_REGEX };