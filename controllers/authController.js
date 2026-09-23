const pool = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const registerUser = async (req, res) => {
  try {
    const { user_name, user_password, user_role } = req.body;
    if (!user_name || !user_password) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(user_password, salt);
    const result = await pool.query(
      "INSERT INTO users (user_name, user_password, user_role) VALUES ($1, $2, $3) RETURNING *",
      [user_name, hashedPassword, user_role]
    );
    res
      .status(201)
      .json({
        message: "User registered successfully",
        user: {
          user_id: result.rows[0].user_id,
          user_name: result.rows[0].user_name,
          user_role: result.rows[0].user_role,
        },
      });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const loginUser = async (req, res) => {
  try {
    const { user_name, user_password } = req.body;
    if (!user_name || !user_password) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await pool.query(
      "SELECT * FROM users WHERE user_name = $1",
      [user_name]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(
      user_password,
      user.user_password
    );
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { user_id: user.user_id, user_role: user.user_role },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { registerUser, loginUser };
