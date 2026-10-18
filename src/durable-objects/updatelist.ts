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

        this.app.get('/updates/:id/comments', async (c) => {
            const updateId = c.req.param('id');
            
            const stmt = this.env.UPDATELIST_DATABASE.prepare(`
                SELECT * FROM updatelist_comment WHERE updatelist_id = ? ORDER BY created_at ASC
            `).bind(updateId);
            
            const { results } = await stmt.all();

            return c.json({ success: true, comments: results });
        });

        this.app.post('/updates/:id/comments', async (c) => {
            const updateId = c.req.param('id');
            const sessionId = c.req.header('X-Session-Id');
            
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);
            
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const { content } = await c.req.json();

            if (!content?.trim()) {
                return c.json({ success: false, error: 'Comment content is required' }, 400);
            }

            const commentId = crypto.randomUUID();

            await this.env.UPDATELIST_DATABASE.prepare(`
                INSERT INTO updatelist_comment (id, updatelist_id, user_id, content)
                VALUES (?, ?, ?, ?)
            `).bind(commentId, updateId, userId, content).run();

            const [newComment] = await this.env.UPDATELIST_DATABASE.prepare(`
                SELECT * FROM updatelist_comment WHERE id = ?
            `).bind(commentId).all();

            return c.json({ success: true, comment: newComment });
        });

        this.app.post('/updates/:id/like', async (c) => {
            const updateId = c.req.param('id');
            const sessionId = c.req.header('X-Session-Id');
            
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);
            
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            try {
                const likeId = crypto.randomUUID();
                await this.env.UPDATELIST_DATABASE.prepare(`
                    INSERT INTO updatelist_like (id, updatelist_id, user_id)
                    VALUES (?, ?, ?)
                `).bind(likeId, updateId, userId).run();
                
                return c.json({ success: true, action: 'liked' });
            } catch (error: any) {
                if (error.message?.includes('UNIQUE constraint failed')) {
                    await this.env.UPDATELIST_DATABASE.prepare(`
                        DELETE FROM updatelist_like WHERE updatelist_id = ? AND user_id = ?
                    `).bind(updateId, userId).run();
                    
                    return c.json({ success: true, action: 'unliked' });
                }
                
                return c.json({ success: false, error: 'Failed to like' }, 500);
            }
        });

        this.app.post('/updates/:id/repost', async (c) => {
            const updateId = c.req.param('id');
            const sessionId = c.req.header('X-Session-Id');
            
            let id = this.env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
            let authDO = this.env.AUTHORIZATION_DURABLE_OBJECT.get(id);
            const { valid, userId } = await (authDO as any).validateSession(sessionId);
            
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const { content } = await c.req.json();

            try {
                const repostId = crypto.randomUUID();
                await this.env.UPDATELIST_DATABASE.prepare(`
                    INSERT INTO updatelist_repost (id, updatelist_id, user_id, content)
                    VALUES (?, ?, ?, ?)
                `).bind(repostId, updateId, userId, content || null).run();

                return c.json({ success: true, action: 'reposted' });
            } catch (error: any) {
                if (error.message?.includes('UNIQUE constraint failed')) {
                    await this.env.UPDATELIST_DATABASE.prepare(`
                        DELETE FROM updatelist_repost WHERE updatelist_id = ? AND user_id = ?
                    `).bind(updateId, userId).run();

                    return c.json({ success: true, action: 'unreposted' });
                }
                
                return c.json({ success: false, error: 'Failed to repost' }, 500);
            }
        });
    }

    public getApp(): Hono {
        return this.app;
    }
}
