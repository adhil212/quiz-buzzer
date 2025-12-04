// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from ./public
app.use(express.static(path.join(__dirname, "public")));

// In-memory store (replace with DB if you want persistence)
const teams = {};        // { tid: { id, name, color } }
let ranked = [];         // [{ teamId, teamName, color, position }]
let questionActive = false;

// Helpers
function generateId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function emitTeamListUpdate() {
  io.emit("teamListUpdate", teams);
}

function emitBuzzerResult() {
  // send ranked array with details that admin UI expects
  io.emit("buzzerResult", { ranked });
}

// REST helper (optional): return a simple health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Start socket handling
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // store some metadata for socket
  socket.meta = { role: null, teamId: null };

  socket.on("register", (payload = {}) => {
    const role = payload.role || "guest";
    socket.meta.role = role;

    if (role === "team" && payload.tid) {
      // team client registers with tid query param (optional)
      socket.meta.teamId = payload.tid;
    }

    console.log(`Socket ${socket.id} registered as ${role}`, payload);
    // send current state to new socket
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
    // allow admin to start question
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
  // Expect team clients to emit: socket.emit("buzzerPress", { tid })
  socket.on("buzzerPress", (data) => {
    if (!data || !data.tid) return;
    const tid = data.tid;
    const team = teams[tid];
    if (!team) {
      console.warn("Unknown team pressed buzzer:", tid);
      return;
    }

    // If question not active, ignore or optionally still register
    if (!questionActive) {
      console.log("Buzzer pressed while idle (ignored):", team.name);
      return;
    }

    // If team already in ranked list, ignore repeat presses
    if (ranked.find(r => r.teamId === tid)) {
      console.log("Duplicate buzzer from", team.name);
      return;
    }

    // push team into ranked list
    const position = ranked.length + 1;
    const item = {
      teamId: tid,
      teamName: team.name,
      color: team.color,
      position
    };
    ranked.push(item);

    console.log(`Buzzer: ${team.name} (#${position})`);

    // Broadcast updated results
    emitBuzzerResult();

    // If you want to notify admin only:
    // io.to(adminSocketId).emit("buzzerResult", { ranked });
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/ in your browser (or your admin HTML)`);
});
