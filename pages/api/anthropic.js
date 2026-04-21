// Server-side proxy to Anthropic's Messages API.
// The ANTHROPIC_API_KEY env var lives on the server only and is NEVER sent to the browser.
// The browser calls POST /api/anthropic with the same body it would send to
// https://api.anthropic.com/v1/messages — we forward it and return the response.

export const config = {
  api: {
    bodyParser: { sizeLimit: "25mb" }, // allow big PDF uploads base64-encoded
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { type: "method_not_allowed", message: "POST only" } });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: {
        type: "config_error",
        message: "ANTHROPIC_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables.",
      },
    });
    return;
  }
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({
      error: { type: "proxy_error", message: e?.message || "upstream fetch failed" },
    });
  }
}
