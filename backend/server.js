import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(cors());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

const licenseCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

app.post('/stripe-webhook', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (
    event.type === 'customer.subscription.deleted' ||
    event.type === 'customer.subscription.updated'
  ) {
    const subId = event.data?.object?.id;
    if (subId) licenseCache.delete(subId);
  }

  res.sendStatus(200);
});

app.use(express.json());

app.post('/validate-license', async (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey || !licenseKey.startsWith('sub_')) {
    return res.json({ valid: false });
  }

  const cached = licenseCache.get(licenseKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ valid: cached.valid });
  }

  try {
    const sub = await stripe.subscriptions.retrieve(licenseKey);
    const valid = ['active', 'trialing'].includes(sub?.status);
    licenseCache.set(licenseKey, { valid, ts: Date.now() });
    res.json({ valid });
  } catch (err) {
    console.error('Stripe API error:', err);
    res.json({ valid: false });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('FlipScout backend running');
});
