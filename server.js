// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/quizbuzzer";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

// ====== MONGO CONNECTION ======
mongoose
 .connect(MONGO_URL)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB error:", err));

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URL
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
});


app.use(sessionMiddleware);

// Helper: auth guard
function ensureAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login.html");
  }
  next();
}

// ====== STATIC & PROTECTED ROUTES ======

// Protect admin.html with login
app.get("/admin.html", ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Root: go to login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// serve other static files (team.html, css, js, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ====== AUTH ROUTES ======

// Signup
app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send("Email and password required");
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.send(`
        <script>
          alert("Email already exists. Please login.");
          window.location.href = "/login.html";
        </script>
      `);
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hashed });

    req.session.userId = user._id;
    res.redirect("/admin.html");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).send("Error during signup");
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.send(`
        <script>
          alert("Invalid email or password");
          window.location.href = "/login.html";
        </script>
      `);
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.send(`
        <script>
          alert("Invalid email or password");
          window.location.href = "/login.html";
        </script>
      `);
    }

    req.session.userId = user._id;
    res.redirect("/admin.html");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Error during login");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// ====== BUZZER STATE (GLOBAL FOR NOW) ======
// (Later we can make this per-user)

const teams = {}; // { tid: { id, name, color } }
let ranked = [];  // [{ teamId, teamName, color, position }]
let questionActive = false;

// Helpers
function generateId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

function emitTeamListUpdate() {
  io.emit("teamListUpdate", teams);
}

function emitBuzzerResult() {
  io.emit("buzzerResult", { ranked });
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== SOCKET.IO ======
io.use((socket, next) => {
  // Share express-session with socket if needed later
  sessionMiddleware(socket.request, {}, next);
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.meta = { role: null, teamId: null };

  socket.on("register", (payload = {}) => {
    const role = payload.role || "guest";
    socket.meta.role = role;

    if (role === "team" && payload.tid) {
      socket.meta.teamId = payload.tid;
    }

    console.log(`Socket ${socket.id} registered as ${role}`, payload);

    socket.emit("teamListUpdate", teams);
    socket.emit("buzzerResult", { ranked });
    if (questionActive) socket.emit("questionStarted");
    else socket.emit("questionReset");
  });

  // ADMIN EVENTS
  socket.on("addTeam", (data) => {
    if (!data || !data.name) return;
    const id = generateId();
    teams[id] = { id, name: data.name, color: data.color || "#000" };
    console.log("Team added:", teams[id]);
    emitTeamListUpdate();
  });

  socket.on("clearAllTeams", () => {
    console.log("Clearing all teams (requested by socket):", socket.id);
    for (const k of Object.keys(teams)) delete teams[k];
    ranked = [];
    questionActive = false;
    emitTeamListUpdate();
    io.emit("questionReset");
    emitBuzzerResult();
  });

  socket.on("startQuestion", () => {
    questionActive = true;
    ranked = [];
    console.log("Question started");
    io.emit("questionStarted");
    emitBuzzerResult();
  });

  socket.on("resetQuestion", () => {
    questionActive = false;
    ranked = [];
    console.log("Question reset");
    io.emit("questionReset");
    emitBuzzerResult();
  });

  // TEAM EVENTS
  socket.on("buzzerPress", (data) => {
    if (!data || !data.tid) return;
    const tid = data.tid;
    const team = teams[tid];
    if (!team) {
      console.warn("Unknown team pressed buzzer:", tid);
      return;
    }

    if (!questionActive) {
      console.log("Buzzer pressed while idle (ignored):", team.name);
      return;
    }

    if (ranked.find((r) => r.teamId === tid)) {
      console.log("Duplicate buzzer from", team.name);
      return;
    }

    const position = ranked.length + 1;
    const item = {
      teamId: tid,
      teamName: team.name,
      color: team.color,
      position
    };
    ranked.push(item);

    console.log(`Buzzer: ${team.name} (#${position})`);

    emitBuzzerResult();
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// ====== START SERVER ======
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
