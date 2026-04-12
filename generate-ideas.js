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
const MODEL_ID = 'gemini-2.5-flash'; // 改用閃電版模型，避開 Pro 的全球塞車，且對企劃發想來說絕對夠聰明
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function fetchTopHeadline(feed) {
  try {
    const res = await fetch(`${PROXY}${encodeURIComponent(feed.url)}`);
    const json = await res.json();
    if (json.items && json.items.length > 0) {
      return json.items.slice(0, 2).map(item => ({ category: feed.label, title: item.title.replace(/\s{2,}/g, ' ').trim() }));
    }
  } catch (err) {
    console.warn(`Warning: failed to fetch ${feed.label}`, err);
  }
  return [];
}

async function callGemini(apiKey, prompt, retries = 3) {
  const url = `${API_BASE}/${MODEL_ID}:generateContent?key=${apiKey}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
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
    });
    
    if (!res.ok) {
      const errText = await res.text();
      // 若遇到 503 伺服器忙碌 或 429 請求過載，進行倒數重試
      if (res.status === 503 || res.status === 429) {
        console.warn(`[嘗試 ${attempt}/${retries}] Gemini 伺服器忙碌 (${res.status})。等待 15 秒後重試...`);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 15000));
          continue; // 跑下一圈迴圈重試
        }
      }
      throw new Error(`Gemini API Error: ${errText}`);
    }
    
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty content');
    
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
    return JSON.parse(jsonStr.trim());
  }
}

function buildPrompt(headlines) {
  const headlineList = headlines.map((h, i) => `${i + 1}. 【${h.category}】${h.title}`).join('\n');
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
      "theme": "心理測驗主題（吸睛、具話題性的好標題）",
      "resultCount": 6, // 建議的結果數量 (範圍在 4~10 之間，最適合這個主題的數字)
      "style": "推薦視覺風格（必須從以下選擇：極簡質感 / 復古像素 / 霓虹賽博 / 奇幻魔法 / 千禧Y2K / 清爽動漫 / 驚悚懸疑 / 溫馨水彩 / 懷舊報刊 / 科幻冷冽 / 唯美浪漫 / 搞怪幽默 / 美式波普 / 底片膠卷 / 國風墨韻 / 廢墟美學 / 立體拼接 / 夢幻蒸汽波 / 自然原始 / 奢華宮廷）",
      "description": "分析說明為何這個話題適合這個測驗主題，以及能給使用者帶來什麼趣味"
    }
  ]
}`;
}

async function main() {
  console.log("Starting daily idea generation...");
  try {
    const results = await Promise.all(RSS_FEEDS.map(fetchTopHeadline));
    const headlines = results.flat().filter(Boolean);
    console.log(`Fetched ${headlines.length} headlines.`);
    
    if (headlines.length === 0) {
      console.error("No headlines fetched. Aborting.");
      process.exit(1);
    }
    
    const prompt = buildPrompt(headlines);
    console.log("Calling Gemini API...");
    const json = await callGemini(GEMINI_API_KEY, prompt);
    
    if (!json.ideas || json.ideas.length === 0) {
      throw new Error("No ideas generated in JSON.");
    }
    
    const ideasWithPrompt = json.ideas.map((idea, idx) => ({
      ...idea,
      id: `idea-${idx + 1}`,
      aiPrompt: `請幫我製作一個心理測驗小遊戲，並提供 @[.agent/skills/psychological-test.md] 執行前確認的必要資訊如下：\n\n1. 主題：【${idea.theme}】\n2. 結果數量：${idea.resultCount}，並請自行根據主題設定 ${idea.resultCount} 種細微不同的人格分析結果。\n3. 風格：【${idea.style}】\n4. 廣告預設開啟\n\n請以最高標準嚴格遵循 @[.agent/skills/psychological-test.md] 的【絕對守則】與【程式碼生成藍圖】，切勿遺漏與捏造任何公版細節（包含跨屏 max-width 置中、嚴格一屏高度佈局、純文字貼齊分享列、以及重測廣告蓋板邏輯等），並立即開始設計與撰寫全套程式碼。`
    }));
    
    const outData = {
      generatedAt: new Date().toISOString(),
      ideas: ideasWithPrompt
    };
    
    fs.writeFileSync('daily-ideas.json', JSON.stringify(outData, null, 2));
    console.log("Successfully wrote daily-ideas.json");
    
  } catch (error) {
    console.error("Execution failed:", error);
    process.exit(1);
  }
}

main();
