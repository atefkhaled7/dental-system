// services/payments/paymentFactory.js
const PaymobProvider = require("./PaymobProvider");

const getPaymentProvider = (providerName = "paymob") => {
  switch (String(providerName).toLowerCase()) {
    case "paymob":
      return new PaymobProvider();
    // مستقبلاً:
    // case "fawry":
    //   return new FawryProvider();
    default:
      throw new Error(`مزود الدفع ${providerName} غير مدعوم`);
  }
};

module.exports = { getPaymentProvider };
