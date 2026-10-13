const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "www");
const START_PORT = Number(process.env.PORT) || 3000;
let currentPort = START_PORT;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

function staticHeaders(contentType) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": process.env.NODE_ENV === "production"
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Type": contentType
  };
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(payload));
}

function safeJoin(base, target) {
  const resolved = path.resolve(base, `.${target}`);
  return resolved.startsWith(base) ? resolved : null;
}

async function proxyRequest(targetUrl, req, res) {
  const targetHost = new URL(targetUrl).hostname;
  let userAgent = null;
  if (targetHost === "api.tvmaze.com") userAgent = "CueMark/1.0 (TVmaze metadata client)";
  else if (targetHost === "openlibrary.org" || targetHost.endsWith(".openlibrary.org")) userAgent = "CueMark/1.0 (Open Library client)";
  else if (targetHost === "api.mangadex.org") userAgent = "CueMark/1.0 (MangaDex client)";
  else if (targetHost === "howlongtobeat.com" || targetHost.endsWith(".howlongtobeat.com")) userAgent = req.headers["user-agent"] || "CueMark/1.0 (HowLongToBeat search client)";
  else if (targetHost === "howlongtoread.com" || targetHost.endsWith(".howlongtoread.com")) userAgent = "Mozilla/5.0";
  else if (targetHost === "viz.com" || targetHost.endsWith(".viz.com")) userAgent = "Mozilla/5.0";
  else if (targetHost === "www.freetogame.com") userAgent = "Mozilla/5.0";
  const requestBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
    ? await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      })
    : undefined;
  const requestHeaders = {
    Accept: "application/json,text/plain,*/*",
    ...(userAgent ? { "User-Agent": userAgent } : {})
  };
  ["content-type", "origin", "referer", "x-auth-token", "x-hp-key", "x-hp-val"].forEach(name => {
    if (req.headers[name]) requestHeaders[name] = req.headers[name];
  });
  if (targetHost === "www.freetogame.com") {
    requestHeaders.origin = "https://www.freetogame.com";
    requestHeaders.referer = "https://www.freetogame.com/";
  }
  if (targetHost === "howlongtobeat.com" || targetHost.endsWith(".howlongtobeat.com")) {
    requestHeaders.origin = "https://howlongtobeat.com";
    requestHeaders.referer = "https://howlongtobeat.com/";
  }
  const upstream = await fetch(targetUrl, {
    method: req.method === "GET" ? "GET" : req.method,
    headers: {
      ...requestHeaders
    },
    body: requestBody
  });
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const body = Buffer.from(await upstream.arrayBuffer());
  send(res, upstream.status, { ...corsHeaders(), "Content-Type": contentType }, body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, corsHeaders(), "");
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/proxy") {
    const target = url.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, { error: "Missing url parameter" });
      return;
    }
    try {
      await proxyRequest(target, req, res);
    } catch (err) {
      sendJson(res, 502, { error: "Proxy request failed", details: err.message });
    }
    return;
  }

  let pathname = url.pathname;
  if (pathname === "/") pathname = "/static/index.html";
  if (pathname === "/index.html") pathname = "/static/index.html";

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = staticHeaders(MIME_TYPES[ext] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res.writeHead(200, headers));
});

function startServer(port) {
  server.listen(port, "127.0.0.1");
}

server.on("listening", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : currentPort;
  console.log(`CueMark server listening on http://127.0.0.1:${port}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && currentPort < START_PORT + 20) {
    currentPort += 1;
    startServer(currentPort);
    return;
  }
  throw err;
});

startServer(currentPort);
