const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cresca-openclaw-runtime" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

app.post("/telegram/webhook", async (req, res) => {
  try {
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
      const parts = text.split(" ");
      const niche = parts[1] || "businesses";
      const location = parts.slice(2).join(" ") || "USA";

      const runtimeResponse = await fetch(`http://localhost:${port}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task: `Find ${niche} leads in ${location}`,
          data: {
            type: "lead_generation",
            niche,
            location,
            limit: 5
          }
        })
      });

      const result = await runtimeResponse.json();

      if (result.results && result.results.length > 0) {
        responseText = result.results
          .map((r, i) => `${i + 1}. ${r.name}\n?? ${r.address || "N/A"}\n?? ${r.phone || "N/A"}\n?? ${r.website || "N/A"}`)
          .join("\n\n");
      } else {
        responseText = result.message || "No leads found";
      }
    }

    if (!TELEGRAM_TOKEN) {
      console.error("Missing TELEGRAM_BOT_TOKEN");
      return res.sendStatus(500);
    }

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
    console.error("Telegram webhook error:", err);
    res.sendStatus(500);
  }
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

      if (!GOOGLE_PLACES_API_KEY) {
        return res.status(500).json({
          success: false,
          message: "Missing GOOGLE_PLACES_API_KEY"
        });
      }

      const query = `${niche} in ${location}`;

      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri"
        },
        body: JSON.stringify({
          textQuery: query,
          maxResultCount: limit
        })
      });

      const result = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          message: "Google Places API error",
          raw: result
        });
      }

      if (!result.places || result.places.length === 0) {
        return res.json({
          success: false,
          message: `No results found for: ${query}`,
          results: []
        });
      }

      const leads = result.places.map((place) => ({
        name: place.displayName?.text || "N/A",
        address: place.formattedAddress || "N/A",
        phone: place.nationalPhoneNumber || "N/A",
        website: place.websiteUri || "N/A",
        rating: place.rating || "N/A",
        reviews: place.userRatingCount || 0,
        mapsUrl: place.googleMapsUri || "N/A"
      }));

      return res.json({
        success: true,
        type: "lead_generation",
        message: "Real leads from Google Places",
        query,
        results: leads
      });
    }

    return res.json({
      success: true,
      message: "Task received but no handler implemented",
      task,
      data
    });

  } catch (error) {
    console.error("Execute error:", error);
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
