async function init() {
  const data = await chrome.storage.local.get([
    'usageCount', 'usageDate', 'licenseValid'
  ]);

  const today = new Date().toDateString();
  const count = data.usageDate === today ? (data.usageCount || 0) : 0;
  const isPro = data.licenseValid === true;

  if (isPro) {
    document.getElementById('status-free').style.display = 'none';
    document.getElementById('status-pro').style.display = 'block';
  } else {
    document.getElementById('usage-text').textContent =
      `${count} / 10 lookups used today`;
    document.getElementById('progress-fill').style.width =
      `${(count / 10) * 100}%`;
  }

  document.getElementById('upgrade-btn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://yourlandingpage.com/?checkout=true' });
  });

  document.getElementById('options-link').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

init();
