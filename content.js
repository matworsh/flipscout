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

function extractTitleRaw() {
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

  return title.substring(0, 120);
}

function extractTitleClean() {
  const raw = extractTitleRaw();
  if (!raw) return null;
  return raw.replace(/\(.*?\)/g, '').trim().substring(0, 80);
}

function fetchSoldData(title) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_SOLD', title }, (response) => {
      resolve(response);
    });
  });
}

function normalizeHref(href) {
  if (!href) return '';
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://www.ebay.com${href}`;
  return href;
}

function extractQuantity(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  let m = t.match(/lot of\s+(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\b(\d+)\s*(?:pack|packs|lot)\b/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\bx\s*(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function extractLanguage(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const langs = ['english', 'chinese', 'japanese', 'korean', 'german', 'french', 'spanish', 'italian'];
  for (const lang of langs) {
    if (t.includes(lang)) return lang;
  }
  if (t.includes('jp ' ) || t.includes(' jp') || t.includes('jpn')) return 'japanese';
  if (t.includes('cn ') || t.includes(' cn') || t.includes('chn')) return 'chinese';
  if (t.includes('en ') || t.includes(' en') || t.includes('eng')) return 'english';
  return null;
}

function tokenizeTitle(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'your', 'from', 'this', 'that'].includes(w));
}

function buildRequiredTokens(queryTitle) {
  if (!queryTitle) return [];
  const keyList = new Set(['jumbo', 'booster', 'box', 'origin', 'origins', 'starter', 'deck', 'display', 'case']);
  const tokens = tokenizeTitle(queryTitle);
  const required = [];

  // Tokens inside parentheses are usually critical (e.g., language)
  const paren = (queryTitle.match(/\(([^)]+)\)/g) || [])
    .join(' ')
    .replace(/[()]/g, ' ');
  const parenTokens = tokenizeTitle(paren);

  tokens.forEach((t) => {
    if (/\d/.test(t) || t.length >= 5 || keyList.has(t)) required.push(t);
  });
  parenTokens.forEach((t) => required.push(t));

  return [...new Set(required)];
}

function isTitleMatch(queryTitle, itemTitle) {
  if (!queryTitle || !itemTitle) return false;
  const qTokens = tokenizeTitle(queryTitle);
  const iTokens = new Set(tokenizeTitle(itemTitle));
  if (qTokens.length < 3) return true;

  const qQty = extractQuantity(queryTitle);
  const iQty = extractQuantity(itemTitle);
  if (qQty && iQty && qQty !== iQty) return false;

  const qLang = extractLanguage(queryTitle);
  const iLang = extractLanguage(itemTitle);
  if (qLang && iLang && qLang !== iLang) return false;
  if (qLang && !iLang) return false;

  const required = buildRequiredTokens(queryTitle);
  if (required.length) {
    let reqHits = 0;
    required.forEach((t) => { if (iTokens.has(t)) reqHits += 1; });
    const reqRatio = reqHits / required.length;
    if (reqRatio < 0.7) return false;
  }

  const qSet = new Set(qTokens);
  let inter = 0;
  qSet.forEach((t) => { if (iTokens.has(t)) inter += 1; });
  const union = new Set([...qSet, ...iTokens]).size;
  const jaccard = union ? inter / union : 0;

  return jaccard >= 0.35;
}

function parseSoldPrices(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = doc.querySelectorAll('.s-item');
  const cardPrices = doc.querySelectorAll('.s-card__price');
  const results = [];
  const dates = [];

  if ((!items || items.length === 0) && (!cardPrices || cardPrices.length === 0)) {
    const regexMatches = Array.from(html.matchAll(/s-item__price[^>]*>([^<]+)</g));
    if (regexMatches.length) {
      regexMatches.forEach((m) => {
        const priceText = m[1] || '';
        const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
        if (matches && matches.length) {
          const num = parseFloat(matches[0].replace(',', ''));
          if (!Number.isNaN(num)) {
            results.push({ price: num, href: '', title: '' });
          }
        }
      });
    }

    if (results.length === 0) {
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
                    results.push({ price: num, href: '', title: '' });
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

    if (results.length === 0) {
      const jsonPriceMatches = Array.from(
        html.matchAll(/\"(?:currentPrice|price|convertedCurrentPrice)\"\\s*:\\s*\\{[^}]*\"value\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)/g)
      );
      jsonPriceMatches.forEach((m) => {
        const num = parseFloat(m[1]);
        if (!Number.isNaN(num)) {
          results.push({ price: num, href: '', title: '' });
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

    const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
    const priceVal = matches && matches.length
      ? parseFloat(matches[0].replace(',', ''))
      : null;

    const dateEl = item.querySelector('.s-item__endedDate') || item.querySelector('.POSITIVE');
    const dateText = dateEl ? dateEl.textContent.trim() : '';
    if (dateText) {
      dates.push(dateText);
    }

    const linkEl = item.querySelector('a.s-item__link') || item.querySelector('a[href]');
    const titleEl = item.querySelector('.s-item__title');
    const href = normalizeHref(linkEl?.getAttribute('href') || '');
    let title = titleEl?.textContent?.trim() || linkEl?.textContent?.trim() || '';
    title = title.replace(/Opens in a new window or tab/gi, '').trim();

    if (priceVal && !Number.isNaN(priceVal)) {
      results.push({ price: priceVal, href, title, dateText });
    }
  });

  if (results.length === 0 && cardPrices && cardPrices.length) {
    cardPrices.forEach((el) => {
      if (el.closest('form') || el.closest('.x-refine__main') || el.closest('.srp-refine__panel')) {
        return;
      }

      const priceText = el.textContent || '';
      if (!priceText.match(/[$€£¥]/)) return;
      if (priceText.toLowerCase().includes('to')) return;
      const matches = priceText.match(/[\d,]+(?:\.\d{2})?/g);
      if (matches && matches.length) {
        const num = parseFloat(matches[0].replace(',', ''));
        if (!Number.isNaN(num) && num > 0) {
          const container = el.closest('.s-card') || el.closest('li') || el.closest('div') || el.parentElement;
          const linkEl = container?.querySelector('a[href]') || el.closest('a[href]');
          const titleEl = container?.querySelector('.s-item__title') || container?.querySelector('[role="heading"]');
          const href = normalizeHref(linkEl?.getAttribute('href') || '');
          let title = titleEl?.textContent?.trim() || linkEl?.textContent?.trim() || '';
          title = title.replace(/Opens in a new window or tab/gi, '').trim();

          results.push({ price: num, href, title });
        }
      }
    });
  }

  return { results, dates };
}

function filterOutliers(items) {
  if (!items || items.length < 5) return items;
  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  const filtered = items.filter((i) => i.price >= low && i.price <= high);
  return filtered.length >= 5 ? filtered : items;
}

function calcStats(items) {
  if (!items || items.length === 0) return null;
  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const min = prices[0];
  const max = prices[prices.length - 1];
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

function renderSparkline(prices, canvas) {
  if (!canvas || !prices || prices.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  ctx.strokeStyle = '#69f0ae';
  ctx.lineWidth = 2;
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = (i / (prices.length - 1)) * (w - 4) + 2;
    const y = h - ((p - min) / range) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function downloadCsv(items) {
  const lines = ['price,title,link'];
  items.forEach((i) => {
    const title = (i.title || '').replace(/\"/g, '\"\"');
    const link = i.href || '';
    lines.push(`${i.price},\"${title}\",\"${link}\"`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flipscout-sales.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

function updateSidebar({ stats, error, limitReached, count, isPaid, flipScore, recentItems, note }) {
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

    ${note ? `<div class="fs-note">${note}</div>` : ''}

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

    ${isPaid ? `
      <div class="fs-pro-block">
        <div class="fs-sales-title">Price history</div>
        <canvas id="fs-price-chart" width="200" height="60"></canvas>
        <button class="fs-export-btn" id="fs-export-btn">Export CSV</button>
      </div>

      <div class="fs-pro-block">
        <div class="fs-sales-title">Profit calculator</div>
        <div class="fs-profit">
          <label>Buy price</label>
          <input type="number" id="fs-buy-price" step="0.01" />
          <label>Fees %</label>
          <input type="number" id="fs-fee-pct" step="0.1" value="13" />
          <label>Shipping</label>
          <input type="number" id="fs-ship" step="0.01" value="0" />
          <button class="fs-export-btn" id="fs-calc-btn">Calculate</button>
          <div class="fs-profit-result" id="fs-profit-result"></div>
        </div>
      </div>
    ` : ''}

    ${recentItems && recentItems.length ? `
      <div class="fs-sales">
        <div class="fs-sales-title">Recent sales</div>
        ${recentItems.map((it) => `
          <a class="fs-sale" href="${it.href}" target="_blank" rel="noopener">
            <span class="fs-sale-price">$${it.price.toFixed(2)}</span>
            <span class="fs-sale-title">${(it.title || 'View item').slice(0, 40)}</span>
          </a>
        `).join('')}
      </div>
    ` : ''}
  `;

  if (document.getElementById('fs-upgrade-btn')) {
    document.getElementById('fs-upgrade-btn').addEventListener('click', () => {
      window.open('https://matworsh.github.io/flipscout/?checkout=true', '_blank');
    });
  }

  if (isPaid) {
    const chart = document.getElementById('fs-price-chart');
    if (chart && recentItems && recentItems.length) {
      renderSparkline(recentItems.map((i) => i.price), chart);
    }

    document.getElementById('fs-export-btn')?.addEventListener('click', () => {
      if (recentItems && recentItems.length) {
        downloadCsv(recentItems);
      }
    });

    const buyInput = document.getElementById('fs-buy-price');
    if (buyInput && stats) {
      buyInput.value = stats.avg.toFixed(2);
    }

    document.getElementById('fs-calc-btn')?.addEventListener('click', () => {
      const buy = parseFloat(document.getElementById('fs-buy-price').value || '0');
      const feePct = parseFloat(document.getElementById('fs-fee-pct').value || '0');
      const ship = parseFloat(document.getElementById('fs-ship').value || '0');
      const resale = stats ? stats.avg : 0;
      const fees = resale * (feePct / 100);
      const profit = resale - buy - fees - ship;
      const el = document.getElementById('fs-profit-result');
      el.textContent = `Est. profit: $${profit.toFixed(2)}`;
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

  const titleClean = extractTitleClean();
  const titleRaw = extractTitleRaw();
  if (!titleClean) return;

  injectSidebar({ loading: true });

  const usage = await checkUsage();
  if (!usage || !usage.allowed) {
    updateSidebar({ limitReached: true });
    return;
  }

  const res = await fetchSoldData(titleClean);
  if (!res || !res.html) {
    updateSidebar({ error: 'Could not load sold data' });
    return;
  }

  const { results } = parseSoldPrices(res.html);
  if (!results.length) {
    updateSidebar({ error: 'No recent sold listings found' });
    return;
  }

  const titleForMatch = titleRaw || titleClean;
  const matchedItems = results.filter((i) => isTitleMatch(titleForMatch, i.title));
  if (matchedItems.length === 0) {
    updateSidebar({ error: 'No closely matching sold listings found' });
    return;
  }

  const filteredItems = filterOutliers(matchedItems);
  const stats = calcStats(filteredItems);
  const currentPrice = getCurrentListingPrice();
  const flipScore = usage.isPaid && currentPrice ? calcFlipScore(currentPrice, stats) : null;
  const recentItems = filteredItems.filter((i) => i.href).slice(0, 6);
  const note = filteredItems.length < 5 ? 'Few comparable sales found' : '';

  updateSidebar({
    stats,
    isPaid: usage.isPaid === true,
    count: usage.count || 0,
    flipScore,
    recentItems,
    note
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
