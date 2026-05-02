const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "cresca-openclaw-runtime"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy"
  });
});

app.post("/execute", async (req, res) => {
  const { task, data } = req.body;

  if (!task) {
    return res.status(400).json({
      success: false,
      error: "Missing task"
    });
  }

  return res.json({
    success: true,
    message: "Task received successfully",
    task,
    data: data || null
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Cresca Runtime running on port ${port}`);
});
