function detectPageType() {
  const url = window.location.href;

  if (url.includes('/itm/') || document.querySelector('h1.x-item-title__mainTitle')) {
    return 'listing';
  }
  if (url.includes('/sch/i.html')) {
    return 'search';
  }
  return null;
}

function extractTitle() {
  const selectors = [
    'h1.x-item-title__mainTitle span.ux-textspans',
    'h1.x-item-title__mainTitle',
    '#itemTitle',
    '[data-testid="x-item-title"] h1'
  ];

  let title = null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim()) {
      title = el.innerText.trim();
      break;
    }
  }

  if (!title) return null;

  title = title.replace(/\(.*?\)/g, '').trim().substring(0, 80);
  return title;
}

// Step 2 test hook
console.log('FlipScout page type:', detectPageType());

// Step 3 test hook
const pageType = detectPageType();
if (pageType === 'listing') {
  console.log('FlipScout extracted title:', extractTitle());
} else if (pageType === 'search') {
  const params = new URLSearchParams(window.location.search);
  console.log('FlipScout search query:', params.get('_nkw'));
}

function fetchSoldData(title) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_SOLD', title }, (response) => {
      resolve(response);
    });
  });
}

function parseSoldPrices(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = doc.querySelectorAll('.s-item');
  const cardPrices = doc.querySelectorAll('.s-card__price');
  const prices = [];
  const dates = [];

  if ((!items || items.length === 0) && (!cardPrices || cardPrices.length === 0)) {
    // Fallback: regex scrape price spans if DOM nodes are missing
    const regexMatches = Array.from(html.matchAll(/s-item__price[^>]*>([^<]+)</g));
    if (regexMatches.length) {
      regexMatches.forEach((m) => {
        const priceText = m[1] || '';
        const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
        if (matches && matches.length) {
          prices.push(parseFloat(matches[0].replace(',', '')));
        }
      });
    }

    // Fallback: JSON-LD item list (often contains offers/prices)
    if (prices.length === 0) {
      const ldScripts = Array.from(
        doc.querySelectorAll('script[type="application/ld+json"]')
      );
      ldScripts.forEach((s) => {
        const text = s.textContent || '';
        if (!text.trim()) return;
        try {
          const data = JSON.parse(text);
          const list = Array.isArray(data) ? data : [data];
          list.forEach((obj) => {
            if (obj && obj['@type'] === 'ItemList' && Array.isArray(obj.itemListElement)) {
              obj.itemListElement.forEach((el) => {
                const item = el.item || el;
                const offer = item?.offers;
                const price = offer?.price;
                if (price) {
                  const num = typeof price === 'number'
                    ? price
                    : parseFloat(String(price).replace(',', ''));
                  if (!Number.isNaN(num)) {
                    prices.push(num);
                  }
                }
              });
            }
          });
        } catch {
          // ignore bad JSON-LD
        }
      });
    }

    // Fallback: extract prices from embedded JSON blobs
    if (prices.length === 0) {
      const jsonPriceMatches = Array.from(
        html.matchAll(/\"(?:currentPrice|price|convertedCurrentPrice)\"\\s*:\\s*\\{[^}]*\"value\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)/g)
      );
      jsonPriceMatches.forEach((m) => {
        const num = parseFloat(m[1]);
        if (!Number.isNaN(num)) {
          prices.push(num);
        }
      });
    }
  }

  items.forEach((item) => {
    if (item.querySelector('.s-item__title')?.textContent?.includes('Shop on eBay')) {
      return;
    }

    const priceEl = item.querySelector('.s-item__price') || item.querySelector('.BOLD');
    const priceText = priceEl?.textContent || '';

    // Match prices like "$12.99", "$12", "12.99", "1,299.99"
    const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
    if (matches && matches.length) {
      prices.push(parseFloat(matches[0].replace(',', '')));
    }

    const dateEl = item.querySelector('.s-item__endedDate') || item.querySelector('.POSITIVE');
    if (dateEl) {
      dates.push(dateEl.textContent.trim());
    }
  });

  if (prices.length === 0 && cardPrices && cardPrices.length) {
    cardPrices.forEach((el) => {
      // Exclude refine/filter UI areas
      if (el.closest('form') || el.closest('.x-refine__main') || el.closest('.srp-refine__panel')) {
        return;
      }

      const priceText = el.textContent || '';
      if (!priceText.match(/[$€£¥]/)) return;
      if (priceText.toLowerCase().includes('to')) return; // skip price ranges
      const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
      if (matches && matches.length) {
        const num = parseFloat(matches[0].replace(',', ''));
        if (!Number.isNaN(num) && num > 0) {
          prices.push(num);
        }
      }
    });
  }

  return { prices, dates };
}

function calcStats(prices) {
  if (!prices || prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const count = prices.length;
  return { avg, median, min, max, count };
}

function calcFlipScore(currentPrice, stats) {
  if (!stats || !currentPrice) return null;
  const ratio = stats.avg / currentPrice;
  let score = Math.round(((ratio - 0.5) / 1.5) * 100);
  score = Math.max(0, Math.min(100, score));
  return score;
}

function getCurrentListingPrice() {
  const selectors = [
    '.x-price-primary .ux-textspans',
    '#prcIsum',
    '.notranslate[itemprop="price"]',
    '.vi-price .notranslate'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent || '';
    const match = text.match(/[\d,]+(?:\.\d{2})?/);
    if (match) return parseFloat(match[0].replace(',', ''));
  }
  return null;
}

function injectSidebar({ loading = false } = {}) {
  document.getElementById('flipscout-sidebar')?.remove();

  const sidebar = document.createElement('div');
  sidebar.id = 'flipscout-sidebar';
  sidebar.innerHTML = `
    <div class="fs-header">
      <span class="fs-logo">FlipScout</span>
      <button class="fs-close" id="fs-close-btn">x</button>
    </div>
    <div class="fs-body" id="fs-body">
      ${loading ? '<div class="fs-loading">Checking sold prices...</div>' : ''}
    </div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById('fs-close-btn').addEventListener('click', () => {
    sidebar.style.transform = 'translateX(260px)';
  });
}

function updateSidebar({ stats, error, limitReached, count, isPaid, flipScore }) {
  const body = document.getElementById('fs-body');
  if (!body) return;

  if (error) {
    body.innerHTML = `<div class="fs-error">${error}</div>`;
    return;
  }

  if (limitReached) {
    body.innerHTML = `
      <div class="fs-limit">
        <p>Daily limit reached</p>
        <p class="fs-limit-sub">10 free lookups used today</p>
        <button class="fs-upgrade-btn" id="fs-upgrade-btn">Upgrade - $12/mo</button>
        <p class="fs-limit-reset">Resets at midnight</p>
      </div>
    `;
    document.getElementById('fs-upgrade-btn').addEventListener('click', () => {
      window.open('https://matworsh.github.io/flipscout/?checkout=true', '_blank');
    });
    return;
  }

  if (!stats) {
    body.innerHTML = '<div class="fs-error">No stats available</div>';
    return;
  }

  const scoreColor = flipScore >= 80 ? '#00e676'
    : flipScore >= 60 ? '#69f0ae'
    : flipScore >= 31 ? '#ffca28'
    : '#ef5350';

  const scoreLabel = flipScore >= 80 ? 'Hot'
    : flipScore >= 60 ? 'Good'
    : flipScore >= 31 ? 'Fair'
    : 'Low';

  body.innerHTML = `
    ${isPaid && flipScore !== null ? `
      <div class="fs-score" style="color: ${scoreColor}">
        <div class="fs-score-number">${flipScore}</div>
        <div class="fs-score-label">${scoreLabel} Flip</div>
      </div>
    ` : ''}

    <div class="fs-stats">
      <div class="fs-stat-row">
        <span>Avg Sold</span>
        <span class="fs-val">$${stats.avg.toFixed(2)}</span>
      </div>
      <div class="fs-stat-row">
        <span>Median</span>
        <span class="fs-val">$${stats.median.toFixed(2)}</span>
      </div>
      <div class="fs-stat-row">
        <span>Low</span>
        <span class="fs-val">$${stats.min.toFixed(2)}</span>
      </div>
      <div class="fs-stat-row">
        <span>High</span>
        <span class="fs-val">$${stats.max.toFixed(2)}</span>
      </div>
      ${isPaid ? `
      <div class="fs-stat-row">
        <span>Sales (recent)</span>
        <span class="fs-val">${stats.count}</span>
      </div>
      ` : ''}
    </div>

    ${!isPaid ? `
      <div class="fs-upsell">
        <p>${Math.max(0, 10 - (count || 0))} free lookups left today</p>
        <button class="fs-upgrade-btn" id="fs-upgrade-btn">
          Upgrade for Flip Score + more
        </button>
      </div>
    ` : ''}
  `;

  if (document.getElementById('fs-upgrade-btn')) {
    document.getElementById('fs-upgrade-btn').addEventListener('click', () => {
      window.open('https://matworsh.github.io/flipscout/?checkout=true', '_blank');
    });
  }
}

function checkUsage() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CHECK_USAGE' }, (response) => {
      resolve(response);
    });
  });
}

async function init() {
  const pageType = detectPageType();
  if (!pageType) return;
  if (pageType !== 'listing') return;

  const title = extractTitle();
  if (!title) return;

  injectSidebar({ loading: true });

  const usage = await checkUsage();
  if (!usage || !usage.allowed) {
    updateSidebar({ limitReached: true });
    return;
  }

  const res = await fetchSoldData(title);
  if (!res || !res.html) {
    updateSidebar({ error: 'Could not load sold data' });
    return;
  }

  const { prices } = parseSoldPrices(res.html);
  if (!prices.length) {
    updateSidebar({ error: 'No recent sold listings found' });
    return;
  }

  const stats = calcStats(prices);
  const currentPrice = getCurrentListingPrice();
  const flipScore = usage.isPaid && currentPrice ? calcFlipScore(currentPrice, stats) : null;
  updateSidebar({
    stats,
    isPaid: usage.isPaid === true,
    count: usage.count || 0,
    flipScore
  });
}

init();

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(init, 1000);
  }
}).observe(document, { subtree: true, childList: true });
