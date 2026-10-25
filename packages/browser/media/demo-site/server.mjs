import { createServer } from "node:http";
import { readFileSync } from "node:fs";

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/register") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { name, ticket, workshops } = JSON.parse(body);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        name,
        ticket,
        workshops,
        badge: "OC26-4821",
        seat: ticket === "VIP" ? "Hall A · Row 2 · Seat 7" : "Hall B · Row 14 · Seat 31",
      }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(readFileSync(new URL("index.html", import.meta.url)));
}).listen(3000, () => console.log("http://localhost:3000"));
