/**
 * Stripe Charge Proxy — Sunset Shores
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates a payment intent and confirms a charge using a Stripe PaymentMethod
 * created in the browser. The Stripe SECRET key lives only here, as a Netlify
 * environment variable — never in any HTML/JS file.
 *
 * In Netlify Dashboard go to:
 * Site Settings → Environment Variables → Add variable:
 *   STRIPE_SECRET_KEY = sk_test_... (get this from your Stripe dashboard,
 *                                    Developers → API keys)
 *
 * For local testing, add the same line to your .env file:
 *   STRIPE_SECRET_KEY=sk_test_...
 *
 * PLATFORM SWITCHING GUIDE:
 *   Netlify:           keep at netlify/functions/charge.js   (current)
 *   Vercel:            move to api/charge.js
 *   Cloudflare Worker: paste core logic into Worker
 *   Node/Express:      wrap in app.post('/api/charge', ...)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function stripePost(path, params) {
  return new Promise((resolve, reject) => {
    if (!STRIPE_SECRET_KEY) {
      return reject(new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.'));
    }

    const postData = new URLSearchParams(params).toString();

    const options = {
      hostname: 'api.stripe.com',
      path: path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error('Invalid response from Stripe'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Stripe request timed out')); });
    req.write(postData);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid request body' }) };
  }

  const { paymentMethodId, amount, currency, receiptEmail, description } = body;

  if (!paymentMethodId || !amount || amount <= 0) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, message: 'Missing payment details.' })
    };
  }

  try {
    // Create and confirm a PaymentIntent in one step
    const result = await stripePost('/v1/payment_intents', {
      amount: String(Math.round(amount)),
      currency: currency || 'usd',
      payment_method: paymentMethodId,
      confirm: 'true',
      receipt_email: receiptEmail || '',
      description: description || 'Sunset Shores reservation deposit'
    });

    if (result.status >= 200 && result.status < 300 && result.body.status === 'succeeded') {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          success: true,
          chargeId: result.body.id,
          amountCharged: result.body.amount,
          status: result.body.status
        })
      };
    } else if (result.body.error) {
      return {
        statusCode: 402,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: result.body.error.message || 'Card was declined.' })
      };
    } else {
      return {
        statusCode: 402,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Payment could not be completed. Status: ' + result.body.status })
      };
    }

  } catch (err) {
    console.error('Stripe charge error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, message: err.message })
    };
  }
};
