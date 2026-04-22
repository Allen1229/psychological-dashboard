const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const RSS_FEEDS = [
  { label: '國內', url: 'https://news.google.com/rss/headlines/section/topic/NATION?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label: '娛樂', url: 'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label: '財經', url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label: '科技', url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label: '體育', url: 'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
];

const PROXY = 'https://api.rss2json.com/v1/api.json?rss_url=';

// 主模型 + 備援模型：若主模型持續過載，自動切換
const MODELS = [
  'gemini-2.5-flash',   // 主力模型
  'gemini-2.0-flash',   // 備援模型
];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// RSS 抓取超時時間 (ms)
const RSS_TIMEOUT_MS = 15000;

/**
 * 帶 timeout 的 fetch 包裝
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTopHeadline(feed) {
  try {
    const res = await fetchWithTimeout(
      `${PROXY}${encodeURIComponent(feed.url)}`,
      {},
      RSS_TIMEOUT_MS
    );
    const json = await res.json();
    if (json.items && json.items.length > 0) {
      return json.items.slice(0, 2).map(item => ({ 
        category: feed.label, 
        title: item.title.replace(/\s{2,}/g, ' ').trim(),
        link: item.link
      }));
    }
  } catch (err) {
    console.warn(`Warning: failed to fetch ${feed.label}`, err.message || err);
  }
  return [];
}

/**
 * 指數退避等待：每次重試等待更長時間，避免短時間密集請求
 * 第1次等 30s、第2次等 60s、第3次等 120s、第4次等 180s、第5次等 240s
 */
function getBackoffDelay(attempt) {
  const delays = [30, 60, 120, 180, 240]; // 秒
  return (delays[attempt - 1] || 240) * 1000;
}

/**
 * 呼叫 Gemini API，具備：
 * - 指數退避重試（避開短時間密集嘗試）
 * - 多模型 fallback（主模型不行就換備援）
 */
async function callGemini(apiKey, prompt) {
  const maxRetries = 5;

  for (const modelId of MODELS) {
    console.log(`\n🔄 嘗試使用模型: ${modelId}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = `${API_BASE}/${modelId}:generateContent?key=${apiKey}`;
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 65536,
              responseMimeType: 'application/json'
            }
          })
        }, 120000); // API 呼叫給 120 秒超時

        if (!res.ok) {
          const errText = await res.text();

          // 429 (速率限制) 或 503 (伺服器過載) → 指數退避重試
          if (res.status === 429 || res.status === 503) {
            const delayMs = getBackoffDelay(attempt);
            const delaySec = delayMs / 1000;
            console.warn(
              `⏳ [${modelId}] 嘗試 ${attempt}/${maxRetries} — 伺服器忙碌 (${res.status})，等待 ${delaySec} 秒後重試...`
            );
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
              continue;
            }
            // 最後一次重試也失敗 → 換下一個模型
            console.warn(`❌ [${modelId}] ${maxRetries} 次重試均失敗，嘗試備援模型...`);
            break;
          }

          // 400 (Bad Request) 等非暫時性錯誤 → 直接換模型，不浪費重試次數
          if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
            console.error(`🚫 [${modelId}] 非暫時性錯誤 (${res.status}): ${errText.substring(0, 200)}`);
            break;
          }

          // 其他未知錯誤 → 退避後重試
          const delayMs = getBackoffDelay(attempt);
          console.warn(
            `⚠️ [${modelId}] 嘗試 ${attempt}/${maxRetries} — 未預期錯誤 (${res.status})，等待 ${delayMs / 1000} 秒...`
          );
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }
          break;
        }

        // 成功回應 → 解析 JSON
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          console.warn(`⚠️ [${modelId}] 嘗試 ${attempt} — Gemini 回傳空內容，重試...`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, getBackoffDelay(attempt)));
            continue;
          }
          break;
        }

        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;

        try {
          const result = JSON.parse(jsonStr.trim());
          console.log(`✅ [${modelId}] 成功！嘗試 ${attempt} 次`);
          return result;
        } catch (parseErr) {
          console.warn(`⚠️ [${modelId}] 嘗試 ${attempt} — JSON 解析失敗: ${parseErr.message}`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, getBackoffDelay(attempt)));
            continue;
          }
          break;
        }

      } catch (err) {
        // fetch 本身失敗（timeout, 網路問題等）
        console.warn(`⚠️ [${modelId}] 嘗試 ${attempt}/${maxRetries} — 網路錯誤: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, getBackoffDelay(attempt)));
          continue;
        }
        break;
      }
    }
  }

  // 所有模型、所有重試都失敗
  throw new Error(`所有 Gemini 模型 (${MODELS.join(', ')}) 均呼叫失敗，放棄本次執行。`);
}

function buildPrompt(headlines) {
  const headlineList = headlines.map((h, i) => `${i + 1}. 【${h.category}】${h.title}\n新聞連結：${h.link}`).join('\n\n');
  return `你是一位趨勢分析與行銷創意總監。請抓取以下 ${headlines.length} 則熱門新聞話題，分析該話題可以延伸成什麼樣的心理測驗，並提供企劃構想，最終輸出 JSON 格式。

### 熱門話題 TOP10：
${headlineList}

---

### 【輸出格式】（純 JSON，不要有任何說明文字或 markdown 標記）
{
  "ideas": [
    {
      "sourceCategory": "類別名稱",
      "sourceTitle": "原始新聞標題",
      "sourceLink": "該新聞的完整連結URL",
      "theme": "心理測驗主題（吸睛、具話題性的好標題）",
      "resultCount": 6, // 建議的結果數量 (範圍在 4~10 之間，最適合這個主題的數字)
      "style": "推薦視覺風格（必須從以下選擇：極簡質感 / 復古像素 / 霓虹賽博 / 奇幻魔法 / 千禧Y2K / 清爽動漫 / 驚悚懸疑 / 溫馨水彩 / 懷舊報刊 / 科幻冷冽 / 唯美浪漫 / 搞怪幽默 / 美式波普 / 底片膠卷 / 國風墨韻 / 廢墟美學 / 立體拼接 / 夢幻蒸汽波 / 自然原始 / 奢華宮廷）",
      "description": "分析說明為何這個話題適合這個測驗主題，以及能給使用者帶來什麼趣味"
    }
  ]
}`;
}

async function main() {
  console.log("🚀 Starting daily idea generation...\n");
  const startTime = Date.now();

  try {
    // ── 第一階段：抓取 RSS 新聞 ──
    console.log("📰 正在抓取 RSS 新聞...");
    const results = await Promise.allSettled(RSS_FEEDS.map(fetchTopHeadline));
    const headlines = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(Boolean);
    console.log(`📰 成功抓取 ${headlines.length} 則新聞標題\n`);
    
    if (headlines.length === 0) {
      console.error("❌ 無法抓取任何新聞標題，放棄本次執行。");
      process.exit(1);
    }
    
    // ── 第二階段：呼叫 Gemini API ──
    const prompt = buildPrompt(headlines);
    console.log("🤖 正在呼叫 Gemini API（含指數退避與備援模型）...");
    const json = await callGemini(GEMINI_API_KEY, prompt);
    
    if (!json.ideas || json.ideas.length === 0) {
      throw new Error("Gemini 回傳的 JSON 不含任何 ideas。");
    }
    
    // ── 第三階段：組裝與寫入 ──
    const ideasWithPrompt = json.ideas.map((idea, idx) => ({
      ...idea,
      id: `idea-${idx + 1}`,
      aiPrompt: `請根據以下資訊製作一個心理測驗小遊戲：\n\n1. 主題：【${idea.theme}】\n2. 結果數量：${idea.resultCount}，並請自行根據主題設定 ${idea.resultCount} 種細微不同的人格分析結果。\n3. 風格：【${idea.style}】`
    }));
    
    const nowISO = new Date().toISOString();
    const dateId = nowISO.split('T')[0];
    const newEntry = {
      id: dateId,
      generatedAt: nowISO,
      ideas: ideasWithPrompt
    };

    let history = [];
    try {
      if (fs.existsSync('daily-ideas.json')) {
        const raw = fs.readFileSync('daily-ideas.json', 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          history = parsed;
        } else if (parsed && parsed.ideas) {
          // 轉換舊版單一物件格式為陣列
          history = [{
            id: (parsed.generatedAt || '').split('T')[0] || 'legacy',
            generatedAt: parsed.generatedAt,
            ideas: parsed.ideas
          }];
        }
      }
    } catch (e) {
      console.warn("⚠️ Could not read previous daily-ideas.json, starting fresh.");
    }

    const existingIndex = history.findIndex(h => h.id === dateId);
    if (existingIndex >= 0) {
      history[existingIndex] = newEntry;
    } else {
      history.unshift(newEntry);
    }

    // 最多保留 8 天的歷史紀錄
    history = history.slice(0, 8);

    fs.writeFileSync('daily-ideas.json', JSON.stringify(history, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ 成功寫入 daily-ideas.json（共 ${history.length} 天資料，產生 ${ideasWithPrompt.length} 個點子）`);
    console.log(`⏱️ 總耗時 ${elapsed} 秒`);
    
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 執行失敗（耗時 ${elapsed} 秒）:`, error.message || error);
    process.exit(1);
  }
}

main();
