/**
 * SmartNewsReader
 * A generic, AI-powered reader framework for structured news views.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const apiKey = await env.GEMINI_API_KEY.get();
    
    // 1. Image Proxy (/image/{domain}/{path})
    if (path.startsWith('/image/')) {
      return await this.handleImageProxy(path, request);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.origin + path, { method: "GET" });
    
    // Bypass cache for Portal to allow instant code/list updates
    if (path !== "/" && path !== "") {
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;
    }

    try {
      if (path === "/" || path === "") {
        return this.renderPortal();
      } 
      else if (path.startsWith('/visit/')) {
        return await this.handleNewsFeed(path, request, apiKey, cache, cacheKey, ctx);
      } 
      else if (path.startsWith('/article/')) {
        return await this.handleArticle(path, request, apiKey, cache, cacheKey, ctx);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(`System Error: ${err.message}`, { status: 500 });
    }
  },

  // --- IMAGE PROXY: Selective caching & Stealth ---
  async handleImageProxy(path, request) {
    const targetUrlRaw = path.replace('/image/', '');
    const targetUrl = "https://" + targetUrlRaw;
    const domain = targetUrlRaw.split('/')[0];

    const headers = this.getStealthHeaders(request, domain);
    const imgRes = await fetch(targetUrl, { headers });
    
    const newHeaders = new Headers(imgRes.headers);
    if (imgRes.status === 200) {
      // 1 Year Cache for successful images
      newHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      newHeaders.set("Cache-Control", "no-store");
    }
    
    newHeaders.delete("Set-Cookie");
    return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
  },

  // --- NEWS FEED: /visit/{domain}/{path} (10min cache) ---
  async handleNewsFeed(path, request, apiKey, cache, cacheKey, ctx) {
    const fullTarget = path.replace('/visit/', '');
    const targetDomain = fullTarget.split('/')[0];
    const targetUrl = `https://${fullTarget}`;
    const urlMap = new Map();
    let linkCounter = 1, imgCounter = 1;

    const rfiRes = await fetch(targetUrl, { headers: this.getStealthHeaders(request, targetDomain) });
    let output = [];
    let depth = 0;
    
    const rewriter = new HTMLRewriter()
      .on("div, section, article, li, nav", {
        element(el) { depth++; el.onEndTag(() => { depth--; }); }
      })
      .on("a[href]", {
        element(el) {
          let href = el.getAttribute("href");
          if (href) {
            try {
              const fullUrl = new URL(href, targetUrl);
              const id = `L${linkCounter++}`;
              urlMap.set(id, `/article/${fullUrl.hostname}${fullUrl.pathname}${fullUrl.search}`);
              output.push(`${"  ".repeat(depth)}[LINK]: ${id}`);
            } catch(e) {}
          }
        }
      })
      .on("img", {
        element(el) {
          const src = el.getAttribute("src") || el.getAttribute("data-src");
          if (src) {
            const id = `I${imgCounter++}`;
            const fullImgUrl = new URL(src, targetUrl).href.replace('https://', '');
            urlMap.set(id, `/image/${fullImgUrl}`);
            output.push(`${"  ".repeat(depth)}[IMG]: ${id}`);
          }
        }
      })
      .on("h1, h2, h3, h4, p", {
        text(t) {
          const txt = t.text.trim();
          if (txt.length > 5) output.push(`${"  ".repeat(depth)}[TEXT]: ${txt}`);
        }
      });

    await rewriter.transform(rfiRes).arrayBuffer();

    const promptData = output.join("\n").substring(0, 65000);
    const prompt = `Task: Convert news list to JSON. 
    Schema: {"nav": [{"label": "str", "url": "ID"}], "news": [{"title": "str", "link": "ID", "image": "ID"}]}
    Data: ${promptData}`;

    let aiResText = "";
    try {
      aiResText = await this.callAI(prompt, apiKey);
      const data = JSON.parse(this.cleanJson(aiResText));
      const html = this.renderHome(this.mapBack(data, urlMap));
      const res = new Response(html, { 
        headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=600, public" } 
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return this.renderDebugPage("News Feed AI Failure", err, prompt, aiResText);
    }
  },

  // --- ARTICLE READER: /article/{domain}/{path} (60min cache) ---
  async handleArticle(path, request, apiKey, cache, cacheKey, ctx) {
    const fullPath = path.replace('/article/', '');
    const targetDomain = fullPath.split('/')[0];
    const targetUrl = `https://${fullPath}`;
    const urlMap = new Map();
    let imgCounter = 1;

    const res = await fetch(targetUrl, { headers: this.getStealthHeaders(request, targetDomain) });
    let output = [];
    const rewriter = new HTMLRewriter()
      .on("img", {
        element(el) {
          const src = el.getAttribute("src") || el.getAttribute("data-src");
          if (src) {
            const id = `I${imgCounter++}`;
            const fullImgUrl = new URL(src, targetUrl).href.replace('https://', '');
            urlMap.set(id, `/image/${fullImgUrl}`);
            output.push(`[IMG]: ${id}`);
          }
        }
      })
      .on("h1, p", {
        text(t) {
          const txt = t.text.trim();
          if (txt.length > 10) output.push(`[TEXT]: ${txt}`);
        }
      });

    await rewriter.transform(res).arrayBuffer();

    const promptData = output.join("\n").substring(0, 45000);
    const prompt = `Task: Extract article content to JSON. 
    Schema: {"image_url": "ID", "title": "str", "summary_points": ["str"], "paragraphs": ["str"], "metadata": {"reading_time_mins": 5, "sentiment": "Neutral"}}
    Data: ${promptData}`;

    let aiResText = "";
    try {
      aiResText = await this.callAI(prompt, apiKey);
      const data = JSON.parse(this.cleanJson(aiResText));
      const html = this.renderArticle(this.mapBack(data, urlMap));
      const finalRes = new Response(html, { 
        headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=3600, public" } 
      });
      ctx.waitUntil(cache.put(cacheKey, finalRes.clone()));
      return finalRes;
    } catch (err) {
      return this.renderDebugPage("Article Reader AI Failure", err, prompt, aiResText);
    }
  },

  // --- SHARED UTILS ---
  async callAI(prompt, key) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        generationConfig: { temperature: 0.1 }
      })
    });
    const json = await res.json();
    if (!json.candidates?.[0]) throw new Error("AI_REJECTION: No candidates returned.");
    return json.candidates[0].content.parts[0].text;
  },

  mapBack(obj, urlMap) {
    if (typeof obj === 'string' && urlMap.has(obj)) return urlMap.get(obj);
    if (Array.isArray(obj)) return obj.map(o => this.mapBack(o, urlMap));
    if (typeof obj === 'object' && obj !== null) {
      for (let k in obj) obj[k] = this.mapBack(obj[k], urlMap);
    }
    return obj;
  },

  cleanJson(t) {
    const m = t.match(/\{[\s\S]*\}/);
    return m ? m[0] : t;
  },

  getStealthHeaders(req, host) {
    const h = new Headers(req.headers);
    h.set("Host", host);
    h.set("Referer", `https://${host}/`);
    h.set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-real-ip"].forEach(x => h.delete(x));
    return h;
  },

  // --- RENDERERS ---
  renderPortal() {
    const sites = [
      { name: "RFI 华语", url: "/visit/www.rfi.fr/cn/" },
      { name: "BBC 中文", url: "/visit/www.bbc.com/zhongwen/simp" }
    ];
    return new Response(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-50 min-h-screen flex flex-col justify-center p-6 italic">
      <h1 class="text-4xl font-black mb-8 text-center text-slate-800 tracking-tighter uppercase">SmartReader</h1>
      <div class="max-w-xs mx-auto w-full space-y-4">
        ${sites.map(s => `<a href="${s.url}" class="block p-6 bg-white border-2 border-slate-900 rounded-3xl font-bold text-center shadow-[4px_4px_0px_0px_rgba(15,23,42,1)] active:translate-y-1 active:shadow-none transition-all">${s.name}</a>`).join('')}
      </div>
    </body></html>`, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
  },

  renderHome(data) {
    return `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-gray-50"><nav class="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b flex gap-2 p-3 overflow-x-auto no-scrollbar">
      <a href="/" class="text-[10px] font-black px-3 py-1 bg-black text-white rounded-full">HOME</a>
      ${(data.nav || []).map(n => `<a href="${n.url}" class="text-[10px] font-bold px-3 py-1 bg-white border border-slate-200 rounded-full whitespace-nowrap">${n.label}</a>`).join('')}
    </nav><main class="max-w-md mx-auto divide-y divide-slate-100">
      ${(data.news || []).map(i => `<a href="${i.link}" class="flex gap-4 p-4 bg-white active:bg-slate-50 transition-all">
        <div class="w-[40%] shrink-0 aspect-[4/3] rounded-xl overflow-hidden bg-slate-100"><img src="${i.image}" class="w-full h-full object-cover" loading="lazy"></div>
        <h2 class="text-sm font-bold line-clamp-2 pt-1 text-slate-800">${i.title}</h2></a>`).join('')}
    </main></body></html>`;
  },

  renderArticle(data) {
    return `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-white"><div class="max-w-xl mx-auto">
      ${data.image_url ? `<img src="${data.image_url}" class="w-full aspect-video object-cover bg-slate-100">` : ''}
      <div class="p-6">
        <div class="flex items-center gap-3 mb-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
          <span>${data.metadata?.reading_time_mins || 3} MIN</span>
          <span class="px-2 py-0.5 bg-slate-100 rounded text-slate-600">${data.metadata?.sentiment || 'Neutral'}</span>
        </div>
        <h1 class="text-2xl font-black mb-6 leading-tight">${data.title}</h1>
        <div class="bg-red-50 border-l-4 border-red-500 p-5 mb-8 rounded-r-xl">
          <ul class="space-y-1 text-sm text-red-900 list-disc list-inside">
            ${(data.summary_points || []).map(p => `<li>${p}</li>`).join('')}
          </ul>
        </div>
        <div class="space-y-5 text-slate-700 leading-relaxed text-lg">
          ${(data.paragraphs || []).map(p => `<p>${p}</p>`).join('')}
        </div>
      </div>
      <footer class="p-10 text-center border-t mt-10"><a href="javascript:history.back()" class="text-red-600 font-bold px-8 py-3 border border-red-600 rounded-full active:bg-red-600 active:text-white transition-all">← BACK</a></footer>
    </div></body></html>`;
  },

  renderDebugPage(title, error, prompt, aiResponse) {
    return new Response(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-900 text-slate-300 p-6 font-mono text-[10px]">
      <div class="max-w-4xl mx-auto">
        <h1 class="text-red-500 text-lg font-bold mb-4">🚨 ${title}</h1>
        <div class="bg-red-950/30 border border-red-500/50 p-4 rounded mb-6">
          <p class="text-white font-bold mb-1">Error Message:</p>
          <p class="break-words">${error.message}</p>
        </div>
        <h2 class="text-blue-400 font-bold mb-2 uppercase">Raw AI Response:</h2>
        <pre class="bg-black p-4 rounded overflow-x-auto border border-slate-700 mb-6 text-green-400 whitespace-pre-wrap">${aiResponse || 'No response received'}</pre>
        <h2 class="text-blue-400 font-bold mb-2 uppercase">Prompt Data:</h2>
        <pre class="bg-black p-4 rounded overflow-x-auto border border-slate-700 h-96 overflow-y-scroll text-slate-500 whitespace-pre-wrap">${prompt}</pre>
        <footer class="mt-8 text-center"><a href="/" class="bg-slate-700 px-6 py-2 rounded-full text-white">Return to Portal</a></footer>
      </div>
    </body></html>`, { headers: { "Content-Type": "text/html" } });
  }
};
