import crypto from "crypto";

function hmac(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

export async function handler(event) {
  try {
    const { name } = JSON.parse(event.body || "{}");
    const safeName = String(name || "anon").replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 16) || "anon";

    const sessionId = crypto.randomBytes(16).toString("hex");
    const seed = crypto.randomBytes(4).readUInt32LE(0); // 32-bit
    const secret = process.env.SESSION_HMAC_SECRET;

    if (!secret) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing SESSION_HMAC_SECRET" }) };
    }

    // Sign the session so submit can’t invent session ids.
    const sig = hmac(secret, `${sessionId}:${seed}:${safeName}`);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ sessionId, seed, sig }),
    };
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request" }) };
  }
}
