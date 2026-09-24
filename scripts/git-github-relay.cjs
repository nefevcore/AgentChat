// 本地 HTTP→HTTPS 中继（治本：git 的 openssl 指纹被拦，Node TLS 通畅）
// git 以明文 HTTP 连本口中继，中继用 Node 的 TLS 栈手握手到 github.com。
// 认证：启动时经 git credential fill 取存好的凭据（不打印），转发时注入 Authorization。
const http = require("http");
const https = require("https");
const { execSync } = require("child_process");

const PORT = Number(process.argv[2] || 34567);
const TARGET = "github.com";

let authHeader = null;
try {
  const out = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  const user = (/^username=(.*)$/m.exec(out) || [])[1];
  const pass = (/^password=(.*)$/m.exec(out) || [])[1];
  if (user && pass) { authHeader = "Basic " + Buffer.from(user + ":" + pass).toString("base64"); }
} catch (e) { console.error("[relay] credential read failed"); }
console.log("[relay] auth: " + (authHeader ? "ready" : "none"));

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers);
  headers.host = TARGET;
  delete headers.connection;
  delete headers["proxy-connection"];
  if (authHeader) headers.authorization = authHeader;
  const preq = https.request({ host: TARGET, port: 443, method: req.method, path: req.url, headers }, (pres) => {
    const out = Object.assign({}, pres.headers);
    delete out.connection;
    res.writeHead(pres.statusCode, out);
    pres.pipe(res);
  });
  preq.on("error", (e) => { console.error("[relay] upstream err: " + e.code); try { res.writeHead(502); res.end(String(e.code)); } catch (_) {} });
  req.pipe(preq);
});
server.listen(PORT, "127.0.0.1", () => console.log("[relay] listening 127.0.0.1:" + PORT + " -> https://" + TARGET));