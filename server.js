const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "cresca-openclaw-runtime"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// Telegram webhook
app.post("/telegram/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text || "";

    // simple command parser
    let responseText = "Command not recognized";

    if (text.startsWith("/status")) {
      responseText = "Cresca Runtime is live ?";
    }

    if (text.startsWith("/findleads")) {
      responseText = "Generating leads...";

      // call your own runtime internally
      // (simulate for now)
      responseText = `Leads:\n1. Roofing Co A\n2. Roofing Co B\n3. Roofing Co C`;
    }

    // send response back to Telegram
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: responseText
      })
    });

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// existing execute endpoint
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
      const limit = data.limit || 5;

      return res.json({
        success: true,
        type: "lead_generation",
        results: Array.from({ length: limit }).map((_, i) => ({
          name: `${niche} Company ${i + 1}`,
          website: `https://example${i + 1}.com`,
          phone: `555-000-${i + 1}`
        }))
      });
    }

    return res.json({
      success: true,
      message: "Task received",
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
