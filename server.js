const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cresca-openclaw-runtime" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    console.log("Telegram webhook received:", JSON.stringify(req.body));

    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text || "";

    let responseText = "Command not recognized";

    if (text.startsWith("/start")) {
      responseText = "Cresca Command Bot connected ?";
    }

    if (text.startsWith("/status")) {
      responseText = "Cresca Runtime is live ?";
    }

    if (text.startsWith("/findleads")) {
      responseText = "Leads:\n1. Roofing Co A\n2. Roofing Co B\n3. Roofing Co C";
    }

    if (!TELEGRAM_TOKEN) {
      console.error("Missing TELEGRAM_BOT_TOKEN");
      return res.sendStatus(500);
    }

    const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: responseText })
    });

    const telegramData = await telegramResponse.json();
    console.log("Telegram API response:", telegramData);

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.sendStatus(500);
  }
});

app.post("/execute", async (req, res) => {
  const { task, data } = req.body;

  if (!task) {
    return res.status(400).json({ success: false, error: "Missing task" });
  }

  try {
    if (data?.type === "lead_generation") {
      const niche = data.niche || "businesses";
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
      message: "Task received",
      task,
      data
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Cresca Runtime running on port ${port}`);
});
