const pool = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const registerUser = async (req, res) => {
  try {
    const { clinic_id , name, password, role, email } = req.body;
    if (!clinic_id || !name || !email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const result = await pool.query(
      "INSERT INTO users (clinic_id, name, email, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role",
      [clinic_id ,name, email, hashedPassword, role]
    );
    res
      .status(201)
      .json({
        message: "User registered successfully",
        user: {
          user_id: result.rows[0].id,
          user_name: result.rows[0].name,
          user_role: result.rows[0].role,
        },
      });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(
      password,
      user.password
    );
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, clinic_id: user.clinic_id },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Server Error" });
  }
};

const registerClinic = async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const { clinic_name, phone_number, admin_name, email, password} = req.body;
    await client.query("BEGIN");
    const clinicResult = await client.query(
      "INSERT INTO clinics (name, phone_number) VALUES ($1, $2) RETURNING id, name, phone_number",
      [clinic_name, phone_number]
    );
    const newClinic = clinicResult.rows[0];

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      "INSERT INTO users (clinic_id, name, email, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, role",
      [newClinic.id, admin_name, email, hashedPassword, 'ClinicAdmin']
    );
    await client.query("COMMIT");

    res.status(201).json({
      message: "Clinic and admin user registered successfully",
      clinic: newClinic,
      admin: userResult.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Transaction error:", error.message);
    res.status(500).json({ error: "فشل التسجيل" });
  } finally {
    client.release();
  }
};

module.exports = { registerUser, loginUser, registerClinic };
