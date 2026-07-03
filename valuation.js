// netlify/functions/valuation.js
//
// Handles a home-valuation lead submission:
//   1. Tries to get an instant AVM estimate from RentCast.
//   2. Always logs the lead to Plunk (contact + "home_valuation_requested" event),
//      whether or not the estimate succeeded, so the nurture sequence fires either way.
//   3. Returns the estimate to the widget, or a "fallback" flag if none was available
//      (missing address match, RentCast quota hit, RentCast error, etc).
//
// Required environment variables (set in Netlify dashboard -> Site settings -> Environment variables):
//   RENTCAST_API_KEY   - from https://app.rentcast.io/app/api
//   PLUNK_PUBLIC_KEY    - pk_... from your Plunk project settings (safe for server-side track calls)

const RENTCAST_URL = "https://api.rentcast.io/v1/avm/value";
const PLUNK_TRACK_URL = "https://api.useplunk.com/v1/track";
const PLUNK_SEND_URL = "https://api.useplunk.com/v1/send";

exports.handler = async (event) => {
  // Browsers send a preflight OPTIONS request before a cross-site POST.
  // Respond to it directly so the real POST is allowed through.
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { address, city, state, zip, name, email, phone } = payload;

  if (!address || !city || !state || !zip || !email || !phone) {
    return jsonResponse(400, { error: "address, city, state, zip, email, and phone are required" });
  }

  const fullAddress = `${address}, ${city}, ${state} ${zip}`;

  // 1. Try RentCast for an instant estimate. Any failure (missing key, no match,
  //    monthly quota exceeded, network error) just falls through to the fallback state.
  let estimate = null;
  try {
    estimate = await getRentcastEstimate(fullAddress);
  } catch (err) {
    console.error("RentCast lookup failed:", err.message);
  }

  // 2. Log the lead to Plunk regardless of whether the estimate succeeded.
  //    This creates/updates the contact and fires an event your Plunk workflow
  //    can use to kick off the follow-up email sequence.
  try {
    await logLeadToPlunk({ email, name, phone, address: fullAddress, city, state, zip, estimate });
  } catch (err) {
    // Don't fail the whole request just because Plunk logging had a hiccup —
    // the person still gets a response either way.
    console.error("Plunk logging failed:", err.message);
  }

  // 2b. Email Nadiah directly so she sees every lead immediately, separate
  //     from whatever nurture sequence Plunk's workflow sends the lead itself.
  try {
    await notifyAgent({ email, name, phone, address: fullAddress, city, state, zip, estimate });
  } catch (err) {
    console.error("Agent notification email failed:", err.message);
  }

  // 3. Respond to the widget.
  if (estimate) {
    return jsonResponse(200, {
      fallback: false,
      estimate: estimate.price,
      low: estimate.priceRangeLow,
      high: estimate.priceRangeHigh,
    });
  }

  return jsonResponse(200, { fallback: true });
};

async function getRentcastEstimate(fullAddress) {
  const apiKey = process.env.RENTCAST_API_KEY;
  if (!apiKey) throw new Error("RENTCAST_API_KEY is not set");

  const url = `${RENTCAST_URL}?address=${encodeURIComponent(fullAddress)}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
  });

  if (!res.ok) {
    // Covers quota-exceeded (429), no match (404), bad address (400), etc.
    throw new Error(`RentCast responded ${res.status}`);
  }

  const data = await res.json();
  if (!data || typeof data.price !== "number") {
    throw new Error("RentCast returned no usable estimate");
  }

  return data;
}

async function logLeadToPlunk({ email, name, phone, address, city, state, zip, estimate }) {
  const publicKey = process.env.PLUNK_PUBLIC_KEY;
  if (!publicKey) throw new Error("PLUNK_PUBLIC_KEY is not set");

  const res = await fetch(PLUNK_TRACK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publicKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event: "home_valuation_requested",
      email,
      subscribed: true,
      data: {
        name: name || "",
        phone: phone || "",
        address,
        city,
        state,
        zip,
        estimate: estimate ? estimate.price : null,
        estimateLow: estimate ? estimate.priceRangeLow : null,
        estimateHigh: estimate ? estimate.priceRangeHigh : null,
        source: "home-valuation-widget",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plunk responded ${res.status}: ${text}`);
  }
}

async function notifyAgent({ email, name, phone, address, city, state, zip, estimate }) {
  const secretKey = process.env.PLUNK_SECRET_KEY;
  const notifyTo = process.env.NOTIFY_EMAIL || "nadiahjawadrealtor@gmail.com";
  if (!secretKey) throw new Error("PLUNK_SECRET_KEY is not set");

  const estimateLine = estimate
    ? `Estimated value: $${Math.round(estimate.price ?? estimate).toLocaleString("en-US")}`
    : "No instant estimate was available for this address.";

  const body = `
    <p>New home valuation request from your website:</p>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(name || "(not provided)")}</li>
      <li><strong>Email:</strong> ${escapeHtml(email)}</li>
      <li><strong>Phone:</strong> ${escapeHtml(phone || "(not provided)")}</li>
      <li><strong>Address:</strong> ${escapeHtml(address)}</li>
      <li>${escapeHtml(estimateLine)}</li>
    </ul>
  `;

  const res = await fetch(PLUNK_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: notifyTo,
      subject: `New home valuation lead: ${name || email}`,
      body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plunk send responded ${res.status}: ${text}`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

function corsHeaders() {
  // Allows the widget to be called from any site it's embedded on
  // (your main site, this project's own demo page, etc).
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
