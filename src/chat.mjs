import HTML from "./chat.html";

// Helper untuk error handling
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

// Main worker
export default {
  async fetch(request, env, ctx) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');
      
      console.log(`Request: ${request.method} ${url.pathname}`, {
        path: path,
        bindingAvailable: {
          KV: !!env.READTALK_KV,
          DB: !!env.READTALK_DB,
          R2: !!env.READTALK_R2,
          rooms: !!env.rooms,
          limiters: !!env.limiters
        }
      });

      // Serve HTML frontend
      if (!path[0]) {
        return new Response(HTML, {
          headers: { 
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "no-cache"
          }
        });
      }

      // API routes
      switch (path[0]) {
        case "api":
          return await handleApiRequest(path.slice(1), request, env, ctx);
        
        case "health":
          return new Response(JSON.stringify({
            status: "healthy",
            timestamp: new Date().toISOString(),
            bindings: {
              KV: !!env.READTALK_KV,
              DB: !!env.READTALK_DB,
              R2: !!env.READTALK_R2,
              rooms: !!env.rooms,
              limiters: !!env.limiters
            }
          }), {
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }
};

// API Request Handler dengan semua binding
async function handleApiRequest(path, request, env, ctx) {
  const url = new URL(request.url);
  
  switch (path[0]) {
    // ============ CHAT ROOMS ============
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          // Create new room
          let id = env.rooms.newUniqueId();
          
          // Log room creation to KV
          await env.READTALK_KV.put(
            `room_created_${id.toString()}`,
            JSON.stringify({
              id: id.toString(),
              timestamp: new Date().toISOString(),
              ip: request.headers.get("CF-Connecting-IP")
            }),
            { expirationTtl: 86400 } // 24 hours
          );
          
          // Log to D1 database jika ada table
          try {
            await env.READTALK_DB.prepare(
              "INSERT INTO room_logs (room_id, created_at, ip) VALUES (?, ?, ?)"
            ).bind(id.toString(), Date.now(), request.headers.get("CF-Connecting-IP")).run();
          } catch (e) {
            // Table might not exist yet, ignore
            console.log("D1 room logging skipped:", e.message);
          }
          
          return new Response(id.toString(), {
            headers: { 
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
        } else {
          return new Response("Method not allowed", { status: 405 });
        }
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

    // ============ KV STORAGE OPERATIONS ============
    case "kv": {
      const key = path[1];
      
      switch (request.method) {
        case "GET":
          if (!key) {
            // List all keys with prefix
            const list = await env.READTALK_KV.list();
            return new Response(JSON.stringify(list.keys), {
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            });
          }
          
          const value = await env.READTALK_KV.get(key);
          if (value === null) {
            return new Response("Not found", { status: 404 });
          }
          
          return new Response(value, {
            headers: { 
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        case "POST":
        case "PUT":
          const data = await request.text();
          const metadata = path[2] ? { metadata: JSON.parse(path[2]) } : {};
          
          await env.READTALK_KV.put(key, data, metadata);
          
          return new Response(JSON.stringify({ success: true, key }), {
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        case "DELETE":
          await env.READTALK_KV.delete(key);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    }

    // ============ DATABASE OPERATIONS ============
    case "db": {
      switch (request.method) {
        case "GET":
          try {
            // Contoh query untuk chat statistics
            const stats = await env.READTALK_DB.prepare(`
              SELECT 
                COUNT(*) as total_rooms,
                COUNT(DISTINCT ip) as unique_ips,
                MAX(created_at) as last_created
              FROM room_logs
            `).first();
            
            return new Response(JSON.stringify(stats || { message: "No data yet" }), {
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            });
          } catch (e) {
            return new Response(JSON.stringify({ 
              error: e.message,
              suggestion: "Run migrations to create tables"
            }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
          
        case "POST":
          // Untuk running migrations atau queries dari API
          const { query, params = [] } = await request.json();
          
          try {
            const stmt = env.READTALK_DB.prepare(query);
            const result = await stmt.bind(...params).run();
            
            return new Response(JSON.stringify(result), {
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    }

    // ============ FILE UPLOAD/DOWNLOAD (R2) ============
    case "files": {
      const fileName = path[1];
      
      switch (request.method) {
        case "GET":
          if (!fileName) {
            // List files in bucket
            const objects = await env.READTALK_R2.list();
            return new Response(JSON.stringify(objects.objects), {
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            });
          }
          
          const object = await env.READTALK_R2.get(fileName);
          
          if (object === null) {
            return new Response("File not found", { status: 404 });
          }
          
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("etag", object.httpEtag);
          headers.set("Access-Control-Allow-Origin", "*");
          
          return new Response(object.body, { headers });
          
        case "POST":
        case "PUT":
          if (!fileName) {
            return new Response("Filename required", { status: 400 });
          }
          
          const fileData = await request.arrayBuffer();
          await env.READTALK_R2.put(fileName, fileData, {
            httpMetadata: request.headers
          });
          
          // Log file upload to KV
          await env.READTALK_KV.put(
            `file_upload_${fileName}`,
            JSON.stringify({
              fileName,
              timestamp: new Date().toISOString(),
              size: fileData.byteLength,
              type: request.headers.get("Content-Type") || "unknown"
            }),
            { expirationTtl: 604800 } // 7 days
          );
          
          return new Response(JSON.stringify({ 
            success: true, 
            fileName,
            size: fileData.byteLength
          }), {
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        case "DELETE":
          await env.READTALK_R2.delete(fileName);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
          
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    }

    // ============ STATISTICS & ANALYTICS ============
    case "stats": {
      // Aggregate stats from all bindings
      const [kvStats, dbStats, r2Stats] = await Promise.all([
        env.READTALK_KV.list().then(list => list.keys.length).catch(() => 0),
        env.READTALK_DB.prepare("SELECT COUNT(*) as count FROM room_logs").first()
          .then(row => row?.count || 0)
          .catch(() => 0),
        env.READTALK_R2.list().then(list => list.objects.length).catch(() => 0)
      ]);
      
      return new Response(JSON.stringify({
        timestamp: new Date().toISOString(),
        bindings: {
          KV: { total_keys: kvStats },
          DB: { total_rooms: dbStats },
          R2: { total_files: r2Stats }
        },
        system: {
          durable_objects: {
            rooms: "active",
            limiters: "active"
          }
        }
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // ============ RATE LIMITING TEST ============
    case "ratelimit-test": {
      const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
      const limiterId = env.limiters.idFromName(ip);
      const limiter = env.limiters.get(limiterId);
      
      const response = await limiter.fetch("https://dummy-url", {
        method: "POST"
      });
      
      const cooldown = await response.text();
      
      return new Response(JSON.stringify({
        ip,
        limiterId: limiterId.toString(),
        cooldown: parseFloat(cooldown),
        message: cooldown > 0 ? "Rate limited" : "OK"
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    default:
      return new Response(JSON.stringify({ 
        error: "Endpoint not found",
        available_endpoints: [
          "POST /api/room - Create new chat room",
          "GET /api/kv/[key] - Get from KV",
          "GET /api/db - Get database stats",
          "GET /api/files - List files",
          "GET /api/stats - System statistics",
          "GET /api/ratelimit-test - Test rate limiting"
        ]
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
  }
}

// ============ DURABLE OBJECT: CHAT ROOM ============
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;  // Access to all bindings: KV, DB, R2
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
    
    console.log(`ChatRoom initialized: ${state.id.toString()}`);
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
        
        case "/info": {
          // Get room info with stats from all bindings
          const roomId = this.state.id.toString();
          
          // Get from KV if exists
          const roomData = await this.env.READTALK_KV.get(`room_${roomId}`)
            .then(data => data ? JSON.parse(data) : null)
            .catch(() => null);
          
          return new Response(JSON.stringify({
            roomId,
            sessions: this.sessions.size,
            storageSize: (await this.storage.list()).size,
            customData: roomData,
            timestamp: new Date().toISOString()
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        case "/archive": {
          // Archive chat history to R2
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          
          const messages = await this.storage.list();
          const archiveData = {
            roomId: this.state.id.toString(),
            timestamp: new Date().toISOString(),
            messageCount: messages.size,
            messages: Array.from(messages.entries()).map(([k, v]) => ({ key: k, value: v }))
          };
          
          const archiveKey = `archive_${this.state.id.toString()}_${Date.now()}.json`;
          await this.env.READTALK_R2.put(
            archiveKey,
            JSON.stringify(archiveData, null, 2)
          );
          
          // Log archive to KV
          await this.env.READTALK_KV.put(
            `archive_log_${this.state.id.toString()}`,
            JSON.stringify({
              archiveKey,
              timestamp: new Date().toISOString(),
              messageCount: messages.size
            })
          );
          
          return new Response(JSON.stringify({
            success: true,
            archiveKey,
            messageCount: messages.size
          }), {
            headers: { "Content-Type": "application/json" }
          });
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
      joinedAt: new Date().toISOString()
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

    // Load message history from storage
    let storage = await this.storage.list({ reverse: true, limit: 100 });
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
    
    // Log session start to KV
    await this.env.READTALK_KV.put(
      `session_${this.state.id.toString()}_${Date.now()}`,
      JSON.stringify({
        roomId: this.state.id.toString(),
        ip,
        timestamp: new Date().toISOString(),
        action: "connected"
      }),
      { expirationTtl: 86400 }
    );
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
        // User is setting their name
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
        
        // Log user join to D1
        try {
          await this.env.READTALK_DB.prepare(
            "INSERT INTO user_joins (room_id, username, ip, joined_at) VALUES (?, ?, ?, ?)"
          ).bind(
            this.state.id.toString(),
            session.name,
            session.ip,
            Date.now()
          ).run();
        } catch (e) {
          // Ignore if table doesn't exist
        }

        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }

      // Handle chat message
      data = { 
        name: session.name, 
        message: "" + data.message,
        roomId: this.state.id.toString()
      };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({ error: "Message too long." }));
        return;
      }

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      // Store in Durable Object storage
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
      
      // Also store in KV for backup/analytics
      await this.env.READTALK_KV.put(
        `msg_${this.state.id.toString()}_${data.timestamp}`,
        dataStr,
        { expirationTtl: 604800 } // 7 days
      );
      
      // Optional: Store message metadata in D1
      try {
        await this.env.READTALK_DB.prepare(
          "INSERT INTO messages (room_id, username, message, timestamp) VALUES (?, ?, ?, ?)"
        ).bind(
          this.state.id.toString(),
          session.name,
          data.message,
          data.timestamp
        ).run();
      } catch (e) {
        // Table might not exist
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
      
      // Log user leave to KV
      await this.env.READTALK_KV.put(
        `session_${this.state.id.toString()}_${Date.now()}_leave`,
        JSON.stringify({
          roomId: this.state.id.toString(),
          username: session.name,
          ip: session.ip,
          timestamp: new Date().toISOString(),
          action: "disconnected",
          duration: Date.now() - new Date(session.joinedAt).getTime()
        }),
        { expirationTtl: 86400 }
      );
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
    this.env = env;
    this.nextAllowedTime = 0;
    
    // Load state from storage if exists
    this.state.blockConcurrencyWhile(async () => {
      let stored = await this.state.storage.get("nextAllowedTime");
      if (stored) {
        this.nextAllowedTime = parseFloat(stored);
      }
    });
    
    console.log(`RateLimiter initialized: ${state.id.toString()}`);
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      let limiterId = this.state.id.toString();

      // Load current state
      await this.state.blockConcurrencyWhile(async () => {
        let stored = await this.state.storage.get("nextAllowedTime");
        if (stored) {
          this.nextAllowedTime = parseFloat(stored);
        }
      });

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // Apply rate limit
        this.nextAllowedTime += 5; // 5 second penalty
        
        // Save state
        await this.state.storage.put("nextAllowedTime", this.nextAllowedTime.toString());
        
        // Log rate limit event to KV
        await this.env.READTALK_KV.put(
          `ratelimit_${limiterId}_${Date.now()}`,
          JSON.stringify({
            limiterId,
            timestamp: new Date().toISOString(),
            nextAllowedTime: this.nextAllowedTime,
            ip: request.headers.get("CF-Connecting-IP") || "unknown"
          }),
          { expirationTtl: 3600 } // 1 hour
        );
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
    if (this.inCooldown) {
      return false;
    }
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
