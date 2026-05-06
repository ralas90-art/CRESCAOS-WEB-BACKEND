const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Airtable Config
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

// Base Routes
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cresca-openclaw-runtime" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

/**
 * AIRTABLE PERSISTENCE LOGIC
 */
async function saveLeadsToAirtable(leads, niche, location) {
  let savedCount = 0;
  let skippedCount = 0;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
    console.warn("⚠️ Airtable credentials missing. Skipping persistence.");
    return { savedCount, skippedCount };
  }

  const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

  for (const lead of leads) {
    try {
      // 1. Check for duplicates
      const formula = `AND({Business Name} = "${lead.name.replace(/"/g, '\\"')}", {Phone} = "${lead.phone.replace(/"/g, '\\"')}")`;
      const checkResponse = await fetch(`${airtableUrl}?filterByFormula=${encodeURIComponent(formula)}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
      });
      
      const checkData = await checkResponse.json();
      if (checkData.records && checkData.records.length > 0) {
        console.log(`⏭️ Duplicate skipped: ${lead.name}`);
        skippedCount++;
        continue;
      }

      // 2. Create new record
      const record = {
        fields: {
          "Business Name": lead.name,
          "Niche": niche,
          "Location": location,
          "Phone": lead.phone,
          "Website": lead.website,
          "Address": lead.address,
          "Rating": typeof lead.rating === 'number' ? lead.rating : 0,
          "Reviews": lead.reviews || 0,
          "AI Score": lead.score !== "N/A" ? parseInt(lead.score) : 0,
          "Insight": lead.insight,
          "Outreach Angle": lead.outreach_angle,
          "Status": "New",
          "Source": "Google Places"
        }
      };

      const createResponse = await fetch(airtableUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${AIRTABLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(record)
      });

      if (createResponse.ok) {
        console.log(`✅ Airtable save success: ${lead.name}`);
        savedCount++;
      } else {
        console.error(`❌ Airtable error for ${lead.name}`);
      }
    } catch (err) {
      console.error(`❌ Failed to process Airtable lead ${lead.name}:`, err);
    }
  }
  return { savedCount, skippedCount };
}

/**
 * TELEGRAM WEBHOOK HANDLER
 */
app.post("/telegram/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text || "";

    if (text.startsWith("/start")) {
      await sendTelegramMessage(chatId, "Cresca Command Bot connected 🚀");
    } else if (text.startsWith("/status")) {
      await sendTelegramMessage(chatId, "Cresca Runtime is live ✅");
    } else if (text.startsWith("/findleads")) {
      const parts = text.split(" ");
      const niche = parts[1] || "businesses";
      const location = parts.slice(2).join(" ") || "USA";

      // Call internal execute
      const runtimeResponse = await fetch(`http://localhost:${port}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: `Find ${niche} leads in ${location}`,
          data: { type: "lead_generation", niche, location, limit: 5 }
        })
      });

      const result = await runtimeResponse.json();

      if (result.success && result.results && result.results.length > 0) {
        const totalFound = result.results.length;
        const savedCount = result.airtable?.savedCount || 0;
        
        // Build Short Summary for Top 3
        let summary = `🔍 *Found:* ${totalFound} leads\n📦 *Saved:* ${savedCount} new to Airtable\n\n`;
        
        result.results.slice(0, 3).forEach((r, i) => {
          summary += `${i+1}. *${r.name}*\n📞 ${r.phone}\n🌐 ${r.website}\n⭐ *Score: ${r.score}/10*\n🎯 ${r.outreach_angle}\n\n`;
        });

        summary += `Saved to Airtable ✅`;
        await sendTelegramMessage(chatId, summary);
      } else {
        await sendTelegramMessage(chatId, result.message || "No leads found.");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.sendStatus(200);
  }
});

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) return;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("❌ Telegram Send Error:", data);
  } else {
    console.log("📤 Telegram Message Sent");
  }
}

/**
 * CORE EXECUTION ENDPOINT
 */
app.post("/execute", async (req, res) => {
  const { task, data } = req.body;
  if (!task) return res.status(400).json({ success: false, error: "Missing task" });

  try {
    if (data?.type === "lead_generation") {
      const niche = data.niche || "businesses";
      const location = data.location || "USA";
      const limit = data.limit || 5;

      if (!GOOGLE_PLACES_API_KEY) return res.status(500).json({ success: false, message: "Missing GOOGLE_PLACES_API_KEY" });

      const query = `${niche} in ${location}`;

      // 1. Fetch from Google Places
      const googleResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount"
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: limit })
      });

      const googleResult = await googleResponse.json();
      if (!googleResponse.ok) return res.status(googleResponse.status).json({ success: false, message: "Google Places API error" });
      if (!googleResult.places || googleResult.places.length === 0) return res.json({ success: false, message: `No results found for: ${query}`, results: [] });

      const rawLeads = googleResult.places.map((place) => ({
        name: place.displayName?.text || "N/A",
        address: place.formattedAddress || "N/A",
        phone: place.nationalPhoneNumber || "N/A",
        website: place.websiteUri || "N/A",
        rating: place.rating || "N/A",
        reviews: place.userRatingCount || 0
      }));

      // 2. Score with OpenAI
      let leads = rawLeads;
      if (OPENAI_API_KEY) {
        try {
          const aiPrompt = `Score these business leads for ${niche} in ${location}.\n\nLeads:\n${JSON.stringify(rawLeads, null, 2)}\n\nReturn JSON: { "leads": [ { "name": "...", "score": 9, "insight": "...", "outreach_angle": "..." } ] }`;
          const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are an elite business analyst. Respond only in JSON." },
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
          console.error("OpenAI error:", aiErr);
          leads = rawLeads.map(l => ({ ...l, score: "N/A", insight: "AI Scoring failed.", outreach_angle: "Review manually." }));
        }
      }

      // 3. Save to Airtable (Await to get counts for summary)
      const airtableResult = await saveLeadsToAirtable(leads, niche, location);

      return res.json({
        success: true,
        type: "lead_generation",
        message: "Leads enriched and synced",
        query,
        results: leads,
        airtable: airtableResult
      });
    }

    return res.json({ success: true, message: "Task received", task, data });
  } catch (error) {
    console.error("Execute error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => console.log(`Cresca Runtime running on port ${port}`));
