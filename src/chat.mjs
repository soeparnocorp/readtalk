// Edge Chat Demo – UI-adjusted version
// Fokus: backend TETAP edge-chat-demo asli
// Perubahan UI (sidebar / mobile / dark mode) TIDAK mempengaruhi logic di sini

import HTML from "./index.html";

async function handleErrors(request, fn) {
  try {
    return await fn();
  } catch (err) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Unhandled exception");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(err.stack, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    return handleErrors(request, async () => {
      const url = new URL(request.url);
      const path = url.pathname.slice(1).split("/");

      if (!path[0]) {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      }

      if (path[0] === "api") {
        return handleApi(path.slice(1), request, env);
      }

      return new Response("Not found", { status: 404 });
    });
  },
};

async function handleApi(path, request, env) {
  if (path[0] !== "room") {
    return new Response("Not found", { status: 404 });
  }

  // POST /api/room → create private room
  if (!path[1]) {
    if (request.method === "POST") {
      const id = env.rooms.newUniqueId();
      return new Response(id.toString(), {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  const name = path[1];
  let id;

  if (/^[0-9a-f]{64}$/.test(name)) {
    id = env.rooms.idFromString(name);
  } else if (name.length <= 32) {
    id = env.rooms.idFromName(name);
  } else {
    return new Response("Invalid room", { status: 404 });
  }

  const room = env.rooms.get(id);

  const newUrl = new URL(request.url);
  newUrl.pathname = "/" + path.slice(2).join("/");

  return room.fetch(newUrl, request);
}

/* ===========================
   Durable Object: ChatRoom
   =========================== */

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.lastTimestamp = 0;

    state.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment();
      const limiterId = env.limiters.idFromString(meta.limiterId);
      const limiter = new RateLimiterClient(
        () => env.limiters.get(limiterId),
        (err) => ws.close(1011, err.stack)
      );
      this.sessions.set(ws, {
        ...meta,
        limiter,
        blockedMessages: [],
      });
    });
  }

  async fetch(request) {
    return handleErrors(request, async () => {
      const url = new URL(request.url);

      if (url.pathname !== "/websocket") {
        return new Response("Not found", { status: 404 });
      }

      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 400 });
      }

      const pair = new WebSocketPair();
      const ip = request.headers.get("CF-Connecting-IP");
      await this.handleSession(pair[1], ip);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async handleSession(ws, ip) {
    this.state.acceptWebSocket(ws);

    const limiterId = this.env.limiters.idFromName(ip);
    const limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      (err) => ws.close(1011, err.stack)
    );

    ws.serializeAttachment({ limiterId: limiterId.toString() });

    const session = { limiterId, limiter, blockedMessages: [] };
    this.sessions.set(ws, session);

    for (const other of this.sessions.values()) {
      if (other.name) {
        session.blockedMessages.push(
          JSON.stringify({ joined: other.name })
        );
      }
    }

    const history = await this.storage.list({ limit: 100, reverse: true });
    [...history.values()].reverse().forEach((msg) => {
      session.blockedMessages.push(msg);
    });
  }

  async webSocketMessage(ws, msg) {
    const session = this.sessions.get(ws);
    if (!session) return;

    if (!session.limiter.checkLimit()) {
      ws.send(JSON.stringify({ error: "Rate limited" }));
      return;
    }

    const data = JSON.parse(msg);

    if (!session.name) {
      session.name = String(data.name || "anonymous").slice(0, 32);
      ws.serializeAttachment({
        ...ws.deserializeAttachment(),
        name: session.name,
      });

      session.blockedMessages.forEach((m) => ws.send(m));
      delete session.blockedMessages;

      this.broadcast({ joined: session.name });
      ws.send(JSON.stringify({ ready: true }));
      return;
    }

    const text = String(data.message || "").slice(0, 256);
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    const payload = JSON.stringify({
      name: session.name,
      message: text,
      timestamp,
    });

    this.broadcast(payload);
    await this.storage.put(new Date(timestamp).toISOString(), payload);
  }

  broadcast(msg) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);

    for (const [ws, session] of this.sessions) {
      try {
        if (session.name) ws.send(data);
        else session.blockedMessages.push(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  async webSocketClose(ws) {
    this.cleanup(ws);
  }

  async webSocketError(ws) {
    this.cleanup(ws);
  }

  cleanup(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.name) {
      this.broadcast({ quit: session.name });
    }
  }
}

/* ===========================
   Rate Limiter
   =========================== */

export class RateLimiter {
  constructor() {
    this.nextAllowed = 0;
  }

  async fetch(request) {
    const now = Date.now() / 1000;
    this.nextAllowed = Math.max(this.nextAllowed, now);

    if (request.method === "POST") {
      this.nextAllowed += 5;
    }

    const wait = Math.max(0, this.nextAllowed - now - 20);
    return new Response(String(wait));
  }
}

class RateLimiterClient {
  constructor(getStub, onError) {
    this.getStub = getStub;
    this.onError = onError;
    this.stub = getStub();
    this.cooldown = false;
  }

  checkLimit() {
    if (this.cooldown) return false;
    this.cooldown = true;
    this.call();
    return true;
  }

  async call() {
    try {
      const res = await this.stub.fetch("https://dummy", { method: "POST" });
      const delay = Number(await res.text());
      await new Promise((r) => setTimeout(r, delay * 1000));
      this.cooldown = false;
    } catch (e) {
      this.onError(e);
    }
  }
}
