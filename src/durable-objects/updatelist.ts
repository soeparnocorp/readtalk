//
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Env } from "../types/env";

export class UpdateListHandler {
    private app: Hono = new Hono();
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use('*', cors());

        this.app.get('/updates', async (c) => {
            const limit = parseInt(c.req.query('limit') || '20');
            const before = c.req.query('before');
            const userId = c.req.query('userId');

            let query = `SELECT * FROM updatelist`;
            let params: any[] = [];

            if (userId) {
                query += ` WHERE user_id = ?`;
                params.push(userId);
            }

            if (before) {
                query += userId ? ` AND created_at < ?` : ` WHERE created_at < ?`;
                params.push(before);
            }

            query += ` ORDER BY created_at DESC LIMIT ?`;
            params.push(limit);

            const stmt = this.env.UPDATELIST_DATABASE.prepare(query).bind(...params);
            const { results } = await stmt.all();

            return c.json({
                success: true,
                updates: results,
                hasMore: results.length === limit
            });
        });

        this.app.post('/updates', async (c) => {
            const sessionId = c.req.header('X-Session-Id');
            
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);
            
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const { content, image_url } = await c.req.json();

            if (!content?.trim()) {
                return c.json({ success: false, error: 'Content is required' }, 400);
            }

            if (content.length > 140) {
                return c.json({ success: false, error: 'Content must be 140 characters or less' }, 400);
            }

            const updateId = crypto.randomUUID();

            await this.env.UPDATELIST_DATABASE.prepare(`
                INSERT INTO updatelist (id, user_id, content, image_url)
                VALUES (?, ?, ?, ?)
            `).bind(updateId, userId, content, image_url || null).run();

            const [newUpdate] = await this.env.UPDATELIST_DATABASE.prepare(`
                SELECT * FROM updatelist WHERE id = ?
            `).bind(updateId).all();

            await (authDO as any).broadcastUpdate(newUpdate);

            return c.json({ success: true, update: newUpdate });
        });
    }

    public getApp(): Hono {
        return this.app;
    }
}
