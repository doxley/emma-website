# Holistic Solutions with Emma — website

The website for holisticsolutionswithemma.co.uk, with online booking and payment through Square.

- **Treatments, prices and free times** come live from Emma's Square Appointments, so changes made in Square appear on the site within 5 minutes.
- **Payments** use Square's secure card form. The card is authorised first and only charged once the appointment is confirmed in Square. If anything fails, the hold is released and nothing is taken.
- **Confirmations and reminders** are sent by Square Appointments.

## Files

| Path | What it does |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | Booking steps, Square card form, opening-hours status |
| `api/config.js` | Treatments and prices from Square |
| `api/availability.js` | Free times for the next 3 weeks (same-day is phone only) |
| `api/book.js` | Takes payment and creates the booking |
| `api/connect.js`, `api/callback.js` | One-time link that connects Emma's Square account |
| `manage.html`, `manage.js` | "Manage booking" page: cancel or move an appointment |
| `api/manage.js`, `api/find-booking.js`, `api/_manage.js` | Cancel / move / look up bookings, refund rules |
| `api/square-webhook.js` | Applies the refund rules when a booking is cancelled in Square itself |
| `test/*.test.js` | Checks nobody is charged without a booking and the refund rules (`npm test`) |

## Settings (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `SQUARE_ENV` | `sandbox` for testing, `production` when live |
| `SQUARE_APP_ID` | Application ID from developer.squareup.com (sandbox IDs start `sandbox-`) |
| `SQUARE_APP_SECRET` | OAuth application secret (Developer Dashboard → OAuth) |
| `SQUARE_REFRESH_TOKEN` | Produced by the one-time connect link below |
| `SETUP_KEY` | Any long random phrase; protects the connect link |
| `SQUARE_LOCATION_ID` | Optional; defaults to the first active location |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | From Developer Console → Webhooks → the subscription → Signature key |
| `SQUARE_ACCESS_TOKEN` | Optional, sandbox testing only: use instead of the refresh token |

Never put these values in the code or share them in chat or email.

### Why the connect link?
Square's free Appointments plan lets a website book appointments on a client's behalf ("buyer-level" bookings). Connecting through `/api/connect` grants only those permissions, so no paid plan is needed. A personal access token grants everything, which Square treats as seller-level and can require Appointments Plus.

## Going live, step by step
1. developer.squareup.com → create an application → OAuth → set the redirect URL to `https://<your-site>/api/callback`.
2. Add the settings above in Vercel with sandbox values, deploy, and book with test card `4111 1111 1111 1111` (CVV 111, any future date, postcode SW1A 1AA).
3. Switch the settings to the production values, open `https://<your-site>/api/connect?key=<SETUP_KEY>` while signed in to Emma's Square account, approve, and save the refresh token it shows as `SQUARE_REFRESH_TOKEN`. Redeploy.
4. Make one real £40 booking, then refund it from the Square Dashboard.
5. Point the domain: Vercel → Domains → add `holisticsolutionswithemma.co.uk` and `www`; then in GoDaddy DNS set the records Vercel shows. Cancel the GoDaddy WordPress hosting (not the domain) once the new site is showing.

## In Square Appointments (Dashboard → Appointments)
- Services: Reiki, Reflexology, Tarot reading — 60 min, £40; Online tarot reading — 60 min, £30. All "bookable online", Emma assigned.
- Availability: Tue 12–8 (online tarot only), Wed 12–6, Thu & Fri 12–8.
- The website enforces which days each service can be booked: any service with "online" in its name is Tuesdays only, everything else Wednesday–Friday (see `api/availability.js`).
- Online booking: ON, auto-accept, 60-minute intervals, 12 hours minimum notice, customers locked to UK time (Appointments → Online booking → Settings).
- Reminders are included on the Free plan; instant confirmation texts/emails need Appointments Plus.

## Cancellations, changes and refunds
| Situation | What happens |
|---|---|
| Client cancels more than 24 hours before (website or Square reminder link) | Booking cancelled, **full refund** automatically |
| Client cancels within 24 hours | Booking cancelled, **no refund** (Emma can still refund by hand in Square) |
| Client doesn't turn up (Emma marks it "No show" in Square) | **No refund** |
| Client moves the appointment more than 24 hours before | Moved to the new time on the website; no money changes |
| Client wants to move within 24 hours | Asked to call |
| **Emma cancels** an appointment in Square | Client gets a **full refund** automatically |

Clients reach "Manage booking" from the link on their confirmation screen, or at `/manage` by entering the email **and** mobile number they booked with.

Webhook setup (once): Developer Console → Emma website → Production → Webhooks → Subscriptions → Add subscription. URL `https://holisticsolutionswithemma.vercel.app/api/square-webhook`, event `booking.updated`. Copy its Signature key into Vercel as `SQUARE_WEBHOOK_SIGNATURE_KEY` and redeploy.
