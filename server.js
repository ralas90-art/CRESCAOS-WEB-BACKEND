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

  try {
    if (data?.type === "lead_generation") {
      const niche = data.niche || "businesses";
      const location = data.location || "USA";
      const limit = data.limit || 5;

      return res.json({
        success: true,
        type: "lead_generation",
        message: "Lead generation simulated",
        results: Array.from({ length: limit }).map((_, i) => ({
          name: `${niche} Company ${i + 1}`,
          website: `https://example${i + 1}.com`,
          phone: `555-000-${i + 1}`
        }))
      });
    }

    return res.json({
      success: true,
      message: "Task received but no handler implemented",
      task,
      data
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Cresca Runtime running on port ${port}`);
});
