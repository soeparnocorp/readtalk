// ============ MAIN WORKER ============
import HTML from "./chat.html";

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    console.error('Error:', err.stack);
    
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.message }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(JSON.stringify({ 
        error: err.message, 
        stack: err.stack 
      }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');
      
      // Serve HTML frontend
      if (!path[0]) {
        return new Response(HTML, {
          headers: { 
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "no-cache"
          }
        });
      }

      switch (path[0]) {
        case "api":
          return await handleApiRequest(path.slice(1), request, env, ctx);
        
        case "health":
          return new Response(JSON.stringify({
            status: "healthy",
            bindings: {
              KV: !!env.READTALK_KV,
              DB: !!env.READTALK_DB,
              R2: !!env.READTALK_R2,
              rooms: !!env.rooms,
              limiters: !!env.limiters
            }
          }), {
            headers: { "Content-Type": "application/json" }
          });
          
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }
};

// ============ API HANDLER ============
async function handleApiRequest(path, request, env, ctx) {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
          
          // KIRIM KE QUEUE instead of langsung KV
          ctx.waitUntil(logRoomCreation(env, id.toString(), request));
          
          return new Response(id.toString(), {
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        }
        return new Response("Method not allowed", { status: 405 });
      }

      let name = path[1];
      let id;
      
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", { status: 400 });
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      return roomObject.fetch(newUrl, request);
    }
    
    // ============ ENDPOINT PISAH UNTUK LOGGING ============
    case "logs": {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      
      // Handle logging di endpoint terpisah
      const { roomId, type, data } = await request.json();
      
      switch (type) {
        case "message":
          await env.READTALK_DB?.prepare(
            "INSERT INTO messages (room_id, username, message, timestamp) VALUES (?, ?, ?, ?)"
          ).bind(roomId, data.name, data.message, data.timestamp).run().catch(() => {});
          break;
          
        case "session":
          await env.READTALK_KV?.put(
            `session_${roomId}_${Date.now()}`,
            JSON.stringify(data),
            { expirationTtl: 86400 }
          ).catch(() => {});
          break;
      }
      
      return new Response("OK", { status: 200 });
    }
    
    // ============ ENDPOINT PISAH UNTUK ARCHIVE ============
    case "archive": {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      
      const { roomId, messages } = await request.json();
      
      // Archive ke R2 di background
      ctx.waitUntil(archiveRoom(env, roomId, messages));
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    default:
      return new Response("Not found", { status: 404 });
  }
}

// ============ BACKGROUND FUNCTIONS ============
async function logRoomCreation(env, roomId, request) {
  if (!env.READTALK_KV) return;
  
  await env.READTALK_KV.put(
    `room_created_${roomId}`,
    JSON.stringify({
      id: roomId,
      timestamp: new Date().toISOString(),
      ip: request.headers.get("CF-Connecting-IP")
    }),
    { expirationTtl: 86400 }
  ).catch(() => {});
}

async function archiveRoom(env, roomId, messages) {
  if (!env.READTALK_R2) return;
  
  const archiveKey = `archive_${roomId}_${Date.now()}.json`;
  await env.READTALK_R2.put(
    archiveKey,
    JSON.stringify({
      roomId,
      timestamp: new Date().toISOString(),
      messages
    })
  ).catch(() => {});
}

// ============ DURABLE OBJECT: CHAT ROOM ============
// PURE: Hanya urus chat, WebSocket, broadcast
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;  // Simpan env untuk ambil binding nanti
    this.sessions = new Map();
    this.lastTimestamp = 0;
    
    // Restore existing WebSocket sessions
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack)
      );
      
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("Expected websocket", { status: 400 });
          }

          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();

          await this.handleSession(pair[1], ip);

          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }

  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      err => webSocket.close(1011, err.stack)
    );

    let session = { 
      ip,
      limiterId: limiterId.toString(), 
      limiter, 
      blockedMessages: [],
      joinedAt: Date.now()
    };
    
    webSocket.serializeAttachment({ 
      ...webSocket.deserializeAttachment(), 
      limiterId: limiterId.toString(),
      ip
    });
    
    this.sessions.set(webSocket, session);

    // Notify others about new user
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({ joined: otherSession.name }));
      }
    }

    // Load message history from DO storage
    let storage = await this.storage.list({ reverse: true, limit: 100 });
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      let data = JSON.parse(msg);

      if (!session.name) {
        // Set user name
        session.name = "" + (data.name || "anonymous");
        webSocket.serializeAttachment({ 
          ...webSocket.deserializeAttachment(), 
          name: session.name 
        });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({ error: "Name too long." }));
          webSocket.close(1009, "Name too long.");
          return;
        }

        // Send queued messages
        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        // Broadcast join notification
        this.broadcast({ joined: session.name });
        
        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }

      // Handle chat message
      data = { 
        name: session.name, 
        message: "" + data.message
      };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({ error: "Message too long." }));
        return;
      }

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      
      // 1. Broadcast ke semua user
      this.broadcast(dataStr);

      // 2. Simpan ke DO storage (PENTING: untuk history)
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
      
      // 3. KIRIM KE LOGGER ENDPOINT di BACKGROUND - TIDAK NUNGGU
      if (this.env.READTALK_DB || this.env.READTALK_KV) {
        this.state.waitUntil(
          fetch(`https://${this.env.WORKER_HOST}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId: this.state.id.toString(),
              type: 'message',
              data
            })
          }).catch(() => {})
        );
      }
      
    } catch (err) {
      webSocket.send(JSON.stringify({ error: err.message }));
      console.error('WebSocket message error:', err);
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    await this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket, error) {
    await this.closeOrErrorHandler(webSocket);
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    
    if (session.name) {
      this.broadcast({ quit: session.name });
    }
  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({ quit: quitter.name });
      }
    });
  }
}

// ============ DURABLE OBJECT: RATE LIMITER ============
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.nextAllowedTime = 0;
    
    // Load state from storage
    this.state.blockConcurrencyWhile(async () => {
      let stored = await this.state.storage.get("nextAllowedTime");
      if (stored) this.nextAllowedTime = parseFloat(stored);
    });
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      
      await this.state.blockConcurrencyWhile(async () => {
        let stored = await this.state.storage.get("nextAllowedTime");
        if (stored) this.nextAllowedTime = parseFloat(stored);
      });

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
        await this.state.storage.put("nextAllowedTime", this.nextAllowedTime.toString());
      }

      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown.toString());
    });
  }
}

// ============ RATE LIMITER CLIENT ============
class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) return false;
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      }

      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
