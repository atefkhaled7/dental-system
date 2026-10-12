// utils/dates.js
const isRealDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const hasTimezoneOffset = (s) => {
  return typeof s === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());
};

module.exports = { isRealDate, hasTimezoneOffset };