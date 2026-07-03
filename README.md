# Home Valuation Widget

A lead-capture widget that gives visitors an instant home value estimate (via RentCast)
and logs every submission to Plunk — whether or not an estimate was available — so your
email nurture sequence starts immediately.

## What's in this project

```
home-valuation-widget/
├── index.html                        ← standalone demo page (widget already embedded)
├── netlify.toml                      ← Netlify config
├── netlify/functions/valuation.js    ← serverless function: RentCast lookup + Plunk logging
└── widget/valuation-widget.html      ← the embeddable widget on its own, to copy into other pages
```

## 1. Get a RentCast API key

1. Sign up free at [rentcast.io/api](https://www.rentcast.io/api) — no card required.
2. Grab your key from the [API dashboard](https://app.rentcast.io/app/api).
3. Free plan = 50 lookups/month. Once you exceed that, RentCast returns an error and the
   widget **automatically falls back** to "we'll email your report" — no crash, no dead end.
   Upgrade your RentCast plan any time as volume grows.

## 2. Set your environment variables in Netlify

In your Netlify site: **Site settings → Environment variables**, add:

| Key | Value |
|---|---|
| `RENTCAST_API_KEY` | your RentCast key |
| `PLUNK_PUBLIC_KEY` | your Plunk `pk_...` public key |

You already have your Plunk key. The public key (not the secret key) is what the
`/v1/track` endpoint uses, so it's safe to use server-side here even though it's the
"public" one.

## 3. Deploy

- Drop this whole folder into your site's repo (or deploy it standalone to test first).
- Netlify will auto-detect `netlify.toml` and deploy the function at
  `/.netlify/functions/valuation`.
- Open the deployed `index.html` to see the widget live.

## 4. Add it to your real pages

Everything the widget needs — HTML, scoped CSS, and JS — lives in one block inside
`widget/valuation-widget.html`. Copy that entire file's contents into wherever you want
the widget to appear on your existing site (a landing page, your homepage, a dedicated
"What's my home worth" page, etc). It's self-contained and won't clash with your site's
existing styles.

If your existing site isn't in the same Netlify project as this function, you have two options:
- **Recommended:** move this `netlify/functions` folder into your main site's repo so the
  widget and function deploy together.
- **Alternative:** deploy this function on its own Netlify site, then update `FUNCTION_URL`
  near the bottom of `valuation-widget.html` to point to that site's full function URL
  (e.g. `https://your-function-site.netlify.app/.netlify/functions/valuation`).

## 5. Set up the Plunk workflow

Every submission fires a `home_valuation_requested` event in Plunk with this data:

```json
{
  "name": "Jane Smith",
  "address": "123 Main St, Jacksonville, FL 32202",
  "city": "Jacksonville",
  "state": "FL",
  "zip": "32202",
  "estimate": 412000,
  "estimateLow": 389000,
  "estimateHigh": 435000,
  "source": "home-valuation-widget"
}
```

In your Plunk dashboard, create a **Workflow** triggered by the `home_valuation_requested`
event to kick off your nurture sequence. If `estimate` is `null`, that lead didn't get an
instant number — you may want a branch that reminds your team to send a manual report.

## Notes

- The 50/month RentCast free-tier cap isn't tracked in code (that would need a database).
  Instead, the function just lets RentCast's own error response trigger the graceful
  fallback — simplest possible approach for launch. Revisit this once you're ready to add
  a quota tracker or upgrade your RentCast plan.
- Every lead is captured in Plunk regardless of whether the instant estimate worked, so
  you never lose a lead to a failed lookup.
