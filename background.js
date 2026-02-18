chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'CHECK_USAGE') {
    checkUsage().then((result) => sendResponse(result));
    return true;
  }
  if (message && message.type === 'FETCH_SOLD' && message.title) {
    const title = message.title;
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}&LH_Sold=1&LH_Complete=1`;

    fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })
      .then((res) => res.text())
      .then((html) => {
        sendResponse({ html });
      })
      .catch((err) => {
        console.error('FlipScout fetch error:', err);
        sendResponse({ error: 'fetch_failed' });
      });

    return true; // keep message channel open for async response
  }
});

async function checkUsage() {
  const data = await chrome.storage.local.get([
    'usageCount', 'usageDate', 'licenseKey', 'licenseValid', 'licenseCheckedAt'
  ]);

  const today = new Date().toDateString();
  if (data.usageDate !== today) {
    await chrome.storage.local.set({ usageCount: 0, usageDate: today });
    data.usageCount = 0;
  }

  const isPaid = await isLicenseValid(data);
  if (isPaid) {
    return { allowed: true, count: data.usageCount || 0, isPaid: true };
  }

  const count = data.usageCount || 0;
  if (count >= 10) {
    return { allowed: false, count };
  }

  await chrome.storage.local.set({ usageCount: count + 1 });
  return { allowed: true, count: count + 1, isPaid: false };
}

async function isLicenseValid(data) {
  const { licenseKey, licenseValid, licenseCheckedAt } = data;
  if (!licenseKey) return false;

  const oneDayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (licenseCheckedAt && now - licenseCheckedAt < oneDayMs) {
    return licenseValid === true;
  }

  try {
    const res = await fetch('https://your-backend.railway.app/validate-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey })
    });
    const { valid } = await res.json();
    await chrome.storage.local.set({ licenseValid: valid, licenseCheckedAt: now });
    return valid;
  } catch {
    return licenseValid === true;
  }
}
