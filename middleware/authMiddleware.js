const jwt = require("jsonwebtoken");

const authMiddleware = async (req, res, next) => {
  try {
    let token = req.header("Authorization");
    if (!token) {
      return res.status(403).json({ error: "Access Denied: No Token Provided!" });
    }
    if (token.startsWith("Bearer ")) {
      token = token.slice(7, token.length).trimLeft();
    }
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    console.error(error.message);
    res.status(401).json({ error: "Invalid Token" });
  }
};

module.exports = authMiddleware;