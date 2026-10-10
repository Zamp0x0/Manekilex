// 每次打开设置页随机选一句；同一次页面会话内保持不变。
(function () {
  const DEFAULT = {
    text: "Give me six hours to chop down a tree and I will spend the first four sharpening the axe.",
    author: "Abraham Lincoln",
  };

  let cache = null;
  let sessionQuote = null;

  function quotesUrl() {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL("poem/quotes.json");
    }
    return "poem/quotes.json";
  }

  async function loadQuotes() {
    if (cache) return cache;
    const res = await fetch(quotesUrl());
    if (!res.ok) throw new Error("无法加载 quotes.json");
    const data = await res.json();
    cache = Array.isArray(data) ? data.filter((q) => q && q.text) : [];
    return cache;
  }

  function pickSessionQuote(quotes) {
    if (sessionQuote) return sessionQuote;
    if (!quotes?.length) {
      sessionQuote = DEFAULT;
      return sessionQuote;
    }
    sessionQuote = quotes[Math.floor(Math.random() * quotes.length)];
    return sessionQuote;
  }

  function formatAuthor(author) {
    const name = (author || "").trim();
    return name ? `— ${name}` : "";
  }

  async function renderDailyQuote(enEl, authorEl) {
    if (!enEl || !authorEl) return;
    try {
      const quotes = await loadQuotes();
      const q = pickSessionQuote(quotes);
      enEl.textContent = q.text || DEFAULT.text;
      authorEl.textContent = formatAuthor(q.author || DEFAULT.author);
    } catch {
      enEl.textContent = DEFAULT.text;
      authorEl.textContent = formatAuthor(DEFAULT.author);
    }
  }

  window.MK_DailyQuotes = {
    DEFAULT,
    loadQuotes,
    pickSessionQuote,
    renderDailyQuote,
  };
})();
