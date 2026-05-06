const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Base Routes
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cresca-openclaw-runtime" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

/**
 * TELEGRAM WEBHOOK HANDLER
 */
app.post("/telegram/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text || "";

    let responseText = "Command not recognized";

    if (text.startsWith("/start")) {
      responseText = "Cresca Command Bot connected 🚀";
    }

    if (text.startsWith("/status")) {
      responseText = "Cresca Runtime is live ✅";
    }

    if (text.startsWith("/findleads")) {
      const parts = text.split(" ");
      const niche = parts[1] || "businesses";
      const location = parts.slice(2).join(" ") || "USA";

      // Call internal /execute endpoint for lead generation + scoring
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
          .map((r) => {
            return `🏢 *${r.name}*\n📍 ${r.address}\n📞 ${r.phone}\n🌐 ${r.website}\n⭐ *Score: ${r.score}/10*\n🧠 *Insight:* ${r.insight}\n🎯 *Outreach:* ${r.outreach_angle}`;
          })
          .join("\n\n---\n\n");
      } else {
        responseText = result.message || "No leads found";
      }
    }

    if (!TELEGRAM_TOKEN) {
      console.error("Missing TELEGRAM_BOT_TOKEN");
      return res.sendStatus(500);
    }

    // Send response back to Telegram
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: responseText,
        parse_mode: "Markdown"
      })
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.sendStatus(200); // Always return 200 to Telegram to prevent retry loops
  }
});

/**
 * CORE EXECUTION ENDPOINT
 */
app.post("/execute", async (req, res) => {
  const { task, data } = req.body;

  if (!task) {
    return res.status(400).json({ success: false, error: "Missing task" });
  }

  try {
    if (data?.type === "lead_generation") {
      const niche = data.niche || "businesses";
      const location = data.location || "USA";
      const limit = data.limit || 5;

      if (!GOOGLE_PLACES_API_KEY) {
        return res.status(500).json({ success: false, message: "Missing GOOGLE_PLACES_API_KEY" });
      }

      const query = `${niche} in ${location}`;

      // 1. Fetch leads from Google Places API (New V1 API)
      const googleResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount"
        },
        body: JSON.stringify({
          textQuery: query,
          maxResultCount: limit
        })
      });

      const googleResult = await googleResponse.json();

      if (!googleResponse.ok) {
        return res.status(googleResponse.status).json({ success: false, message: "Google Places API error", raw: googleResult });
      }

      if (!googleResult.places || googleResult.places.length === 0) {
        return res.json({ success: false, message: `No results found for: ${query}`, results: [] });
      }

      const rawLeads = googleResult.places.map((place) => ({
        name: place.displayName?.text || "N/A",
        address: place.formattedAddress || "N/A",
        phone: place.nationalPhoneNumber || "N/A",
        website: place.websiteUri || "N/A",
        rating: place.rating || "N/A",
        reviews: place.userRatingCount || 0
      }));

      // 2. Enrich and Score Leads using OpenAI
      let leads = rawLeads;
      if (OPENAI_API_KEY) {
        try {
          const aiPrompt = `
            You are an elite business analyst for Cresca OS.
            Score these business leads for a marketing outreach campaign.
            Industry: ${niche}
            Location: ${location}

            Leads:
            ${JSON.stringify(rawLeads, null, 2)}

            For each lead, provide:
            1. A score from 1-10 based on business opportunity.
            2. A short insight (e.g., weak online presence, strong reviews but no automation).
            3. A concise outreach angle.

            Return the output as a valid JSON object with a "leads" array.
            Format: { "leads": [ { "name": "...", "score": 9, "insight": "...", "outreach_angle": "..." } ] }
          `;

          const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are a direct-response marketing expert. Respond only in JSON." },
                { role: "user", content: aiPrompt }
              ],
              response_format: { type: "json_object" }
            })
          });

          const aiResult = await aiResponse.json();
          if (aiResponse.ok) {
            const content = JSON.parse(aiResult.choices[0].message.content);
            const scoredData = content.leads || [];
            
            leads = rawLeads.map(lead => {
              const aiData = scoredData.find(s => s.name === lead.name) || {};
              return {
                ...lead,
                score: aiData.score || "N/A",
                insight: aiData.insight || "Manual review recommended.",
                outreach_angle: aiData.outreach_angle || "Standard Cresca offer."
              };
            });
          }
        } catch (aiErr) {
          console.error("OpenAI scoring error:", aiErr);
          // Fallback to raw leads if AI processing fails
          leads = rawLeads.map(l => ({ ...l, score: "N/A", insight: "AI Scoring failed.", outreach_angle: "Review manually." }));
        }
      }

      return res.json({
        success: true,
        type: "lead_generation",
        message: "Real leads enriched with OpenAI scoring",
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
    return res.status(500).json({ success: false, error: error.message });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Cresca Runtime running on port ${port}`);
});
