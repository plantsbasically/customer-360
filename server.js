const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN || 'plantsbasically.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const LOOP_TOKEN = process.env.LOOP_API_KEY;
const JUDGEME_TOKEN = process.env.JUDGEME_API_TOKEN;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function computeMetrics(orders, allSubs, customerInfo = {}) {
  const now = new Date();

  // Use Shopify's authoritative totals when available — fetched orders may be a subset
  const lifetimeValue = parseFloat(customerInfo.total_spent) || orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const orderCount = parseInt(customerInfo.orders_count) || orders.length;
  const averageOrderValue = orderCount > 0 ? lifetimeValue / orderCount : 0;

  // Last order date from fetched orders (most recent will always be in the batch)
  const sorted = [...orders].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const newest = sorted[sorted.length - 1];
  const daysSinceLastOrder = newest ? Math.floor((now - new Date(newest.created_at)) / 86400000) : null;

  // Use customer account creation date — more reliable than oldest fetched order
  const memberSince = customerInfo.created_at ? new Date(customerInfo.created_at) : null;
  const daysSinceMemberJoined = memberSince ? Math.floor((now - memberSince) / 86400000) : null;

  const refundedOrders = orders.filter(o => o.financial_status === 'refunded');
  const refundCount = refundedOrders.length;
  const totalRefunded = parseFloat(
    refundedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0).toFixed(2)
  );
  const refundRate = orders.length > 0 ? parseFloat((refundCount / orders.length).toFixed(4)) : 0;
  const refundRisk = refundRate > 0.5 || refundCount >= 3;

  const isSubscriber = allSubs.some(s => s.status === 'ACTIVE');
  const wasSubscriber = !isSubscriber && allSubs.some(s => ['CANCELLED', 'EXPIRED'].includes(s.status));
  const activeSubCount = allSubs.filter(s => s.status === 'ACTIVE').length;
  const pausedSubCount = allSubs.filter(s => s.status === 'PAUSED').length;

  let loyaltyScore = 0;
  loyaltyScore += Math.min(orderCount * 5, 30);
  loyaltyScore += Math.min(lifetimeValue / 50, 25);
  if (isSubscriber) loyaltyScore += 20;
  if (daysSinceLastOrder !== null && daysSinceLastOrder <= 30) loyaltyScore += 15;
  if (orderCount > 2) loyaltyScore += 10;
  loyaltyScore = Math.round(Math.min(loyaltyScore, 100));

  // Segment priority: Legend > Loyal > At Risk > Churned > Regular > New
  let segment;
  if (orderCount >= 6) segment = 'Legend';
  else if (orderCount >= 3) segment = 'Loyal';
  else if (orderCount >= 2 && daysSinceLastOrder !== null && daysSinceLastOrder >= 90) segment = 'At Risk';
  else if (wasSubscriber) segment = 'Churned';
  else if (orderCount >= 2) segment = 'Regular';
  else if (daysSinceMemberJoined !== null && daysSinceMemberJoined < 60) segment = 'New';
  else segment = 'Regular';

  const tags = [];
  if (segment === 'Legend') tags.push('🏆 Legend');
  else if (segment === 'Loyal') tags.push('💚 Loyal');
  if (isSubscriber) tags.push('🔄 Active Subscriber');
  else if (pausedSubCount > 0) tags.push('⏸ Paused Subscriber');
  if (daysSinceLastOrder !== null && daysSinceLastOrder >= 60) tags.push('💤 Dormant');
  if (daysSinceMemberJoined !== null && daysSinceMemberJoined < 60) tags.push('🆕 New Customer');
  if (refundCount > 0) tags.push('🚩 Refund History');
  if (orderCount >= 10) tags.push('📦 Heavy Buyer');

  return {
    lifetimeValue: parseFloat(lifetimeValue.toFixed(2)),
    orderCount,
    averageOrderValue: parseFloat(averageOrderValue.toFixed(2)),
    daysSinceMemberJoined,
    daysSinceLastOrder,
    refundCount,
    totalRefunded,
    refundRate,
    refundRisk,
    isSubscriber,
    wasSubscriber,
    activeSubCount,
    pausedSubCount,
    loyaltyScore,
    segment,
    tags
  };
}

app.post('/api/lookup', async (req, res) => {
  const { email, phone } = req.body;
  if (!email && !phone) return res.status(400).json({ error: 'email or phone required' });

  const result = { email, phone, shopify: null, loop: [], judgeme: [], metrics: null, errors: [] };

  try {
    const query = email ? encodeURIComponent(`email:${email}`) : encodeURIComponent(`phone:${phone}`);
    const custRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/search.json?query=${query}`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    if (custRes.ok) {
      const custData = await custRes.json();
      const customer = custData.customers?.[0];
      if (customer) {
        const ordersRes = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/${customer.id}/orders.json?status=any&limit=15`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
        );
        const ordersData = ordersRes.ok ? await ordersRes.json() : {};
        const orders = (ordersData.orders || []).map(o => ({
          id: o.id, name: o.name, fulfillment_status: o.fulfillment_status,
          financial_status: o.financial_status, total_price: o.total_price,
          created_at: o.created_at, source_name: o.source_name,
          line_items: (o.line_items || []).map(li => ({
            title: li.title, quantity: li.quantity, variant_title: li.variant_title
          }))
        }));

        const refunds = orders
          .filter(o => o.financial_status === 'refunded')
          .map(o => ({ order_id: o.id, order_name: o.name, total_price: o.total_price, created_at: o.created_at }));

        result.shopify = {
          customer: {
            id: customer.id, first_name: customer.first_name, last_name: customer.last_name,
            email: customer.email, phone: customer.phone, tags: customer.tags,
            orders_count: customer.orders_count, total_spent: customer.total_spent,
            created_at: customer.created_at
          },
          orders,
          refunds
        };

        let allSubs = [];
        if (LOOP_TOKEN) {
          try {
            const loopRes = await fetch(
              `https://api.loopsubscriptions.com/admin/2023-10/subscription?customerShopifyId=${customer.id}`,
              { headers: { 'X-Loop-Token': LOOP_TOKEN } }
            );
            if (loopRes.ok) {
              const loopData = await loopRes.json();
              if (loopData.success && loopData.data) {
                const custEmail = (customer.email || '').toLowerCase();
                allSubs = loopData.data
                  .filter(s =>
                    String(s.customer?.shopifyId) === String(customer.id) ||
                    (s.customer?.email && s.customer.email.toLowerCase() === custEmail)
                  )
                  .map(s => {
                    const line = s.lines?.[0] || {};
                    return {
                      id: s.id,
                      shopifyId: s.shopifyId,
                      status: (s.status || '').toUpperCase(),
                      product_title: line.productTitle || line.name?.split(' - ')[0] || 'Unknown Product',
                      variant_title: line.variantTitle || '',
                      billingInterval: s.billingPolicy?.interval || s.billingInterval,
                      billingIntervalCount: s.billingPolicy?.intervalCount || s.billingIntervalCount || 1,
                      cancellationReason: s.cancellationReason || null,
                      shipping_address: s.shippingAddress
                    };
                  });
                const STATUS_ORDER = { ACTIVE: 0, PAUSED: 1, CANCELLED: 2, EXPIRED: 3 };
                allSubs.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
                // Expose all non-expired subs to frontend; keep all for metric computation
                result.loop = allSubs.filter(s => s.status !== 'EXPIRED');
              }
            }
          } catch (e) { result.errors.push(`Loop: ${e.message}`); }
        }

        // Judge.me — two-step: find reviewer by email, then fetch their reviews
        if (JUDGEME_TOKEN) {
          try {
            const reviewEmail = email || customer.email;
            const base = `https://api.judge.me/api/v1`;
            const qs = `api_token=${JUDGEME_TOKEN}&shop_domain=${SHOPIFY_STORE}`;

            const reviewerRes = await fetch(
              `${base}/reviewers/-1?${qs}&email=${encodeURIComponent(reviewEmail)}`
            );
            if (reviewerRes.ok) {
              const reviewerData = await reviewerRes.json();
              const reviewerId = reviewerData.reviewer?.id;
              if (reviewerId) {
                const reviewsRes = await fetch(
                  `${base}/reviews?${qs}&reviewer_id=${reviewerId}&per_page=20`
                );
                if (reviewsRes.ok) {
                  const reviewsData = await reviewsRes.json();
                  result.judgeme = (reviewsData.reviews || [])
                    .filter(r => !r.hidden)
                    .map(r => ({
                      id: r.id,
                      rating: r.rating,
                      title: r.title,
                      body: r.body,
                      product_title: r.product_title,
                      verified: r.verified === 'buyer',
                      created_at: r.created_at,
                      has_pictures: r.has_published_pictures
                    }));
                }
              }
            }
          } catch (e) { result.errors.push(`Judge.me: ${e.message}`); }
        }

        result.metrics = computeMetrics(orders, allSubs, {
          orders_count: customer.orders_count,
          total_spent: customer.total_spent,
          created_at: customer.created_at
        });

        // Augment metrics with review data
        const reviews = result.judgeme;
        result.metrics.reviewCount = reviews.length;
        result.metrics.avgRating = reviews.length
          ? parseFloat((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1))
          : null;
        if (reviews.length > 0) result.metrics.tags.push('⭐ Has Reviews');
      } else {
        result.errors.push('No Shopify customer found');
      }
    } else {
      result.errors.push(`Shopify API error: ${custRes.status}`);
    }
  } catch (e) { result.errors.push(`Shopify: ${e.message}`); }

  res.json(result);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => { console.log(`Customer 360 running on port ${PORT}`); });
