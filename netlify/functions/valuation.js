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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { address, city, state, zip, name, email } = payload;

  if (!address || !city || !state || !zip || !email) {
    return jsonResponse(400, { error: "address, city, state, zip, and email are required" });
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
    await logLeadToPlunk({ email, name, address: fullAddress, city, state, zip, estimate });
  } catch (err) {
    // Don't fail the whole request just because Plunk logging had a hiccup —
    // the person still gets a response either way.
    console.error("Plunk logging failed:", err.message);
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

async function logLeadToPlunk({ email, name, address, city, state, zip, estimate }) {
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
