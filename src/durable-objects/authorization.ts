import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import { Browsable } from "@outerbase/browsable-durable-object";
import { Env } from "../types/env";
import { upgradeWebSocket } from 'hono/cloudflare-workers'

@Browsable()
export class AuthorizationDurableObject extends DurableObject<Env> {
    private app: Hono = new Hono();
    public sql: SqlStorage;
    public connections = new Map<string, WebSocket>()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;

        this.setup();
    }

    private async setup() {
        await this.executeQuery({
            sql: `
                CREATE TABLE IF NOT EXISTS user (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    first_name TEXT NOT NULL,
                    last_name TEXT NOT NULL,
                    username TEXT UNIQUE,
                    username_updated_at INTEGER,
                    avatar TEXT,
                    bio TEXT,
                    socials TEXT,
                    created_at INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS channel (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    is_private INTEGER DEFAULT 0,
                    created_at INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS channel_user (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    created_at INTEGER DEFAULT (unixepoch()),
                    FOREIGN KEY (channel_id) REFERENCES channel(id) ON DELETE CASCADE,
                    UNIQUE(channel_id, user_id)
                );

                CREATE TABLE IF NOT EXISTS session (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at INTEGER DEFAULT (unixepoch()),
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
                );
            `
        });

        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use('*', async (c, next) => {
            const path = new URL(c.req.url).pathname;

            if (path === '/ws') {
                return next();
            }

            return cors()(c, next);
        });

        // ============================================================
        // 🔥 USER ENDPOINTS
        // ============================================================

        this.app.get('/users', async (c) => {
            const users = await this.executeQuery({
                sql: `SELECT id, email, first_name, last_name, username, avatar FROM user`,
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            return c.json({ success: true, users });
        });

        this.app.get('/users/online', async (c) => {
            const onlineUserIds = Array.from(this.connections.keys());

            if (onlineUserIds.length === 0) {
                return c.json({
                    success: true,
                    onlineUsers: []
                });
            }

            const onlineUsers = await this.executeQuery({
                sql: `
                    SELECT id, email, first_name, last_name, username, avatar
                    FROM user
                    WHERE id IN (${onlineUserIds.map(() => '?').join(',')})
                `,
                params: onlineUserIds,
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            return c.json({
                success: true,
                onlineUsers
            });
        });

        this.app.get('/users/:username', async (c) => {
            const username = c.req.param('username');

            const [user] = await this.executeQuery({
                sql: `
                    SELECT id, email, first_name, last_name, username, avatar, bio, socials
                    FROM user
                    WHERE username = ?
                    LIMIT 1
                `,
                params: [username],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            if (!user) {
                return c.json({ success: false, error: 'User not found' }, 404);
            }

            let socials: Record<string, string> | null = null;
            if (user.socials) {
                try {
                    socials = JSON.parse(user.socials as string);
                } catch {
                    socials = null;
                }
            }

            return c.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    username: user.username,
                    avatar: user.avatar,
                    bio: user.bio,
                    socials
                }
            });
        });

        // ============================================================
        // 🔥 PROFILE ENDPOINTS (GET + PUT)
        // ============================================================

        this.app.get('/profile', async (c) => {
            const sessionId = c.req.header('X-Session-Id');

            const { valid, userId } = await this.validateSession(sessionId);
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const [user] = await this.executeQuery({
                sql: `
                    SELECT id, email, first_name, last_name, username, username_updated_at, avatar, bio, socials
                    FROM user
                    WHERE id = ?
                `,
                params: [userId],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            if (!user) {
                return c.json({ success: false, error: 'User not found' }, 404);
            }

            let socials: Record<string, string> | null = null;
            if (user.socials) {
                try {
                    socials = JSON.parse(user.socials as string);
                } catch {
                    socials = null;
                }
            }

            return c.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    username: user.username,
                    username_updated_at: user.username_updated_at,
                    avatar: user.avatar,
                    bio: user.bio,
                    socials
                }
            });
        });

        this.app.put('/profile', async (c) => {
            const sessionId = c.req.header('X-Session-Id');
            const { first_name, last_name, avatar, username, bio, socials } = await c.req.json();

            if (!first_name?.trim() || !last_name?.trim()) {
                return c.json({
                    success: false,
                    error: 'First name and last name are required'
                }, 400);
            }

            if (bio && bio.length > 140) {
                return c.json({
                    success: false,
                    error: 'Bio must be 140 characters or less'
                }, 400);
            }

            const { valid, userId } = await this.validateSession(sessionId);
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const [currentUser] = await this.executeQuery({
                sql: `SELECT username, username_updated_at FROM user WHERE id = ?`,
                params: [userId],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            let newUsername = currentUser.username as string | null;
            let newUsernameUpdatedAt = currentUser.username_updated_at as number | null;

            if (username && username !== currentUser.username) {
                const usernameRegex = /^[A-Za-z0-9_]{1,14}$/;
                if (!usernameRegex.test(username)) {
                    return c.json({
                        success: false,
                        error: 'Username must be 1-14 characters, only A-Z, 0-9, and underscore'
                    }, 400);
                }

                const now = Math.floor(Date.now() / 1000);
                const hundredDays = 100 * 24 * 60 * 60;
                if (currentUser.username_updated_at && (now - (currentUser.username_updated_at as number)) < hundredDays) {
                    return c.json({
                        success: false,
                        error: 'Username can only be changed once every 100 days'
                    }, 400);
                }

                const [existing] = await this.executeQuery({
                    sql: `SELECT 1 FROM user WHERE username = ? AND id != ? LIMIT 1`,
                    params: [username, userId]
                }) as Record<string, SqlStorageValue>[];

                if (existing) {
                    return c.json({
                        success: false,
                        error: 'Username already taken'
                    }, 409);
                }

                newUsername = username;
                newUsernameUpdatedAt = now;
            }

            const socialsJson = socials ? JSON.stringify(socials) : null;

            await this.executeQuery({
                sql: `
                    UPDATE user
                    SET first_name = ?, last_name = ?, avatar = ?, username = ?, username_updated_at = ?, bio = ?, socials = ?
                    WHERE id = ?
                `,
                params: [first_name.trim(), last_name.trim(), avatar || null, newUsername, newUsernameUpdatedAt, bio || null, socialsJson, userId]
            });

            const [user] = await this.executeQuery({
                sql: `
                    SELECT id, email, first_name, last_name, username, username_updated_at, avatar, bio, socials
                    FROM user
                    WHERE id = ?
                `,
                params: [userId],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            let parsedSocials: Record<string, string> | null = null;
            if (user.socials) {
                try {
                    parsedSocials = JSON.parse(user.socials as string);
                } catch {
                    parsedSocials = null;
                }
            }

            return c.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    username: user.username,
                    username_updated_at: user.username_updated_at,
                    avatar: user.avatar,
                    bio: user.bio,
                    socials: parsedSocials
                }
            });
        });

        // ============================================================
        // 🔥 AUTH ENDPOINTS (Login, Register, Logout, Session)
        // ============================================================

        this.app.post('/login', async (c) => {
            const { email, password } = await c.req.json();

            if (!email || !password) {
                return c.json({
                    success: false,
                    error: 'Email and password are required'
                }, 400);
            }

            const hashedPassword = await this.hashPassword(password);

            const [user] = await this.executeQuery({
                sql: `
                    SELECT id, email, first_name, last_name, username, username_updated_at, avatar, bio, socials
                    FROM user
                    WHERE email = ? AND password = ?
                    LIMIT 1
                `,
                params: [email, hashedPassword],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            if (!user) {
                return c.json({
                    success: false,
                    error: 'Invalid email or password'
                }, 401);
            }

            const sessionId = crypto.randomUUID();
            const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

            await this.executeQuery({
                sql: `
                    INSERT INTO session (id, user_id, expires_at)
                    VALUES (?, ?, ?)
                `,
                params: [sessionId, user.id, expiresAt]
            });

            let parsedSocials: Record<string, string> | null = null;
            if (user.socials) {
                try {
                    parsedSocials = JSON.parse(user.socials as string);
                } catch {
                    parsedSocials = null;
                }
            }

            return c.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    username: user.username,
                    username_updated_at: user.username_updated_at,
                    avatar: user.avatar,
                    bio: user.bio,
                    socials: parsedSocials
                },
                session: {
                    id: sessionId,
                    expires_at: expiresAt
                }
            });
        });

        this.app.post('/register', async (c) => {
            const { email, password, firstName, lastName, username, avatar } = await c.req.json();

            if (!email || !password || !firstName || !lastName || !username) {
                return c.json({
                    success: false,
                    error: 'Email, password, first name, last name, and username are required'
                }, 400);
            }

            const usernameRegex = /^[A-Za-z0-9_]{1,14}$/;
            if (!usernameRegex.test(username)) {
                return c.json({
                    success: false,
                    error: 'Username must be 1-14 characters, only A-Z, 0-9, and underscore'
                }, 400);
            }

            try {
                const [existingEmail] = await this.executeQuery({
                    sql: 'SELECT 1 FROM user WHERE email = ? LIMIT 1',
                    params: [email]
                }) as Record<string, SqlStorageValue>[];

                if (existingEmail) {
                    return c.json({
                        success: false,
                        error: 'Email already registered'
                    }, 409);
                }

                const [existingUsername] = await this.executeQuery({
                    sql: 'SELECT 1 FROM user WHERE username = ? LIMIT 1',
                    params: [username]
                }) as Record<string, SqlStorageValue>[];

                if (existingUsername) {
                    return c.json({
                        success: false,
                        error: 'Username already taken'
                    }, 409);
                }

                const hashedPassword = await this.hashPassword(password);
                const userId = crypto.randomUUID();
                const now = Math.floor(Date.now() / 1000);

                await this.executeQuery({
                    sql: `
                        INSERT INTO user (id, email, password, first_name, last_name, username, username_updated_at, avatar)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                    params: [userId, email, hashedPassword, firstName, lastName, username, now, avatar || null]
                });

                const [user] = await this.executeQuery({
                    sql: `
                        SELECT id, email, first_name, last_name, username, username_updated_at, avatar, bio, socials
                        FROM user
                        WHERE id = ?
                    `,
                    params: [userId],
                    isRaw: false
                }) as Record<string, SqlStorageValue>[];

                const sessionId = crypto.randomUUID();
                const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

                await this.executeQuery({
                    sql: `
                        INSERT INTO session (id, user_id, expires_at)
                        VALUES (?, ?, ?)
                    `,
                    params: [sessionId, userId, expiresAt]
                });

                let parsedSocials: Record<string, string> | null = null;
                if (user.socials) {
                    try {
                        parsedSocials = JSON.parse(user.socials as string);
                    } catch {
                        parsedSocials = null;
                    }
                }

                return c.json({
                    success: true,
                    user: {
                        id: user.id,
                        email: user.email,
                        first_name: user.first_name,
                        last_name: user.last_name,
                        username: user.username,
                        username_updated_at: user.username_updated_at,
                        avatar: user.avatar,
                        bio: user.bio,
                        socials: parsedSocials
                    },
                    session: {
                        id: sessionId,
                        expires_at: expiresAt
                    }
                });
            } catch (error) {
                console.error('Registration error:', error);
                return c.json({
                    success: false,
                    error: 'Failed to create user'
                }, 500);
            }
        });

        this.app.get('/session/:sessionId', async (c) => {
            const sessionId = c.req.param('sessionId');

            const [session] = await this.executeQuery({
                sql: `
                    SELECT s.*, u.email, u.first_name, u.last_name, u.username, u.username_updated_at, u.avatar, u.bio, u.socials
                    FROM session s
                    JOIN user u ON s.user_id = u.id
                    WHERE s.id = ? AND s.expires_at > unixepoch()
                    LIMIT 1
                `,
                params: [sessionId],
                isRaw: false
            }) as Record<string, SqlStorageValue>[];

            if (!session) {
                return c.json({
                    success: false,
                    error: 'Invalid or expired session'
                }, 401);
            }

            let parsedSocials: Record<string, string> | null = null;
            if (session.socials) {
                try {
                    parsedSocials = JSON.parse(session.socials as string);
                } catch {
                    parsedSocials = null;
                }
            }

            return c.json({
                success: true,
                session: {
                    id: session.id,
                    expires_at: session.expires_at
                },
                user: {
                    id: session.user_id,
                    email: session.email,
                    first_name: session.first_name,
                    last_name: session.last_name,
                    username: session.username,
                    username_updated_at: session.username_updated_at,
                    avatar: session.avatar,
                    bio: session.bio,
                    socials: parsedSocials
                }
            });
        });

        this.app.post('/logout', async (c) => {
            const sessionId = c.req.header('X-Session-Id');

            if (!sessionId) {
                return c.json({
                    success: false,
                    error: 'Session ID is required'
                }, 400);
            }

            await this.executeQuery({
                sql: `
                    UPDATE session
                    SET expires_at = unixepoch()
                    WHERE id = ?
                `,
                params: [sessionId]
            });

            const [session] = await this.executeQuery({
                sql: `SELECT user_id FROM session WHERE id = ?`,
                params: [sessionId]
            }) as Record<string, SqlStorageValue>[];

            if (session?.user_id) {
                const userId = session.user_id as string;
                const connection = this.connections.get(userId);

                if (connection) {
                    connection.close(1000, 'Logged out');
                    this.connections.delete(userId);
                    await this.broadcastUserPresence(userId, false);
                }
            }

            return c.json({
                success: true
            });
        });

        // ============================================================
        // 🔥 CHANNEL ENDPOINTS
        // ============================================================

        this.app.get('/channels', async (c) => {
            const sessionId = c.req.header('X-Session-Id') || '';
            const { valid, userId } = await this.validateSession(sessionId);

            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const channels = await this.executeQuery({
                sql: `
                    SELECT
                        c.*,
                        COUNT(DISTINCT cu2.user_id) as member_count,
                        GROUP_CONCAT(cu2.user_id) as member_ids
                    FROM channel c
                    INNER JOIN channel_user cu ON c.id = cu.channel_id
                    LEFT JOIN channel_user cu2 ON c.id = cu2.channel_id
                    WHERE cu.user_id = ?
                    GROUP BY c.id
                    ORDER BY c.created_at DESC
                `,
                params: [userId]
            }) as Record<string, SqlStorageValue>[];

            const channelsWithMemberArray = channels.map(channel => ({
                ...channel,
                member_ids: channel.member_ids ? (channel.member_ids as string).split(',') : []
            }));

            return c.json({ success: true, channels: channelsWithMemberArray });
        });

        this.app.post('/channels', async (c) => {
            const sessionId = c.req.header('X-Session-Id');

            if (!sessionId) {
                return c.json({
                    success: false,
                    error: 'No session for this user exists'
                }, 500);
            }

            const { valid, userId } = await this.validateSession(sessionId);

            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const { name, description, is_private, member_ids } = await c.req.json();

            if (!name?.trim()) {
                return c.json({
                    success: false,
                    error: 'Channel name is required'
                }, 400);
            }

            try {
                const channelId = crypto.randomUUID();

                await this.executeQuery({
                    sql: `
                        INSERT INTO channel (id, name, description, is_private)
                        VALUES (?, ?, ?, ?)
                    `,
                    params: [channelId, name, description || null, is_private ? 1 : 0]
                });

                await this.executeQuery({
                    sql: `
                        INSERT INTO channel_user (id, channel_id, user_id)
                        VALUES (?, ?, ?)
                    `,
                    params: [crypto.randomUUID(), channelId, userId]
                });

                if (member_ids && Array.isArray(member_ids) && member_ids.length > 0) {
                    const memberValues = member_ids
                        .filter(memberId => memberId !== userId)
                        .map(memberId => `(?, ?, ?)`).join(',');

                    const memberParams = member_ids
                        .filter(memberId => memberId !== userId)
                        .flatMap(memberId => [
                            crypto.randomUUID(),
                            channelId,
                            memberId
                        ]);

                    if (memberParams.length > 0) {
                        await this.executeQuery({
                            sql: `
                                INSERT INTO channel_user (id, channel_id, user_id)
                                VALUES ${memberValues}
                            `,
                            params: memberParams
                        });
                    }
                }

                const [channel] = await this.executeQuery({
                    sql: `
                        SELECT
                            c.*,
                            COUNT(DISTINCT cu2.user_id) as member_count,
                            GROUP_CONCAT(cu2.user_id) as member_ids
                        FROM channel c
                        LEFT JOIN channel_user cu2 ON c.id = cu2.channel_id
                        WHERE c.id = ?
                        GROUP BY c.id
                    `,
                    params: [channelId],
                    isRaw: false
                }) as Record<string, SqlStorageValue>[];

                const formattedChannel = {
                    ...channel,
                    member_ids: channel.member_ids ? (channel.member_ids as string).split(',') : []
                };

                for (const memberId of formattedChannel.member_ids) {
                    const connection = this.connections.get(memberId as string);
                    if (connection && connection.readyState === 1) {
                        try {
                            connection.send(JSON.stringify({
                                type: 'NEW_CHANNEL',
                                channel: formattedChannel
                            }));
                        } catch (error) {
                            console.error('[Channel Creation] Failed to notify user:', {
                                userId: memberId,
                                error
                            });
                            this.connections.delete(memberId as string);
                        }
                    }
                }

                return c.json({
                    success: true,
                    channel: formattedChannel
                });

            } catch (error) {
                console.error('Channel creation error:', error);
                return c.json({
                    success: false,
                    error: 'Failed to create channel'
                }, 500);
            }
        });

        this.app.post('/channels/:channelId/invite', async (c) => {
            const sessionId = c.req.header('X-Session-Id');
            const channelId = c.req.param('channelId');
            const { userIds } = await c.req.json();

            const { valid, userId } = await this.validateSession(sessionId);
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            const [membership] = await this.executeQuery({
                sql: `SELECT 1 FROM channel_user WHERE channel_id = ? AND user_id = ?`,
                params: [channelId, userId]
            }) as Record<string, SqlStorageValue>[];

            if (!membership) {
                return c.json({ success: false, error: 'Not a member of this channel' }, 403);
            }

            try {
                const memberValues = userIds.map(() => `(?, ?, ?)`).join(',');
                const memberParams = userIds.flatMap(userId => [
                    crypto.randomUUID(),
                    channelId,
                    userId
                ]);

                await this.executeQuery({
                    sql: `
                        INSERT OR IGNORE INTO channel_user (id, channel_id, user_id)
                        VALUES ${memberValues}
                    `,
                    params: memberParams
                });

                const [channel] = await this.executeQuery({
                    sql: `
                        SELECT
                            c.*,
                            COUNT(DISTINCT cu2.user_id) as member_count,
                            GROUP_CONCAT(cu2.user_id) as member_ids
                        FROM channel c
                        LEFT JOIN channel_user cu2 ON c.id = cu2.channel_id
                        WHERE c.id = ?
                        GROUP BY c.id
                    `,
                    params: [channelId],
                    isRaw: false
                }) as Record<string, SqlStorageValue>[];

                const formattedChannel = {
                    ...channel,
                    member_ids: channel.member_ids ? (channel.member_ids as string).split(',') : []
                };

                for (const memberId of formattedChannel.member_ids) {
                    const connection = this.connections.get(memberId as string);
                    if (connection && connection.readyState === 1) {
                        try {
                            connection.send(JSON.stringify({
                                type: 'CHANNEL_UPDATED',
                                channel: formattedChannel
                            }));
                        } catch (error) {
                            console.error('[Channel Invite] Failed to notify user:', {
                                userId: memberId,
                                error
                            });
                            this.connections.delete(memberId as string);
                        }
                    }
                }

                return c.json({
                    success: true,
                    channel: formattedChannel
                });

            } catch (error) {
                console.error('Channel invite error:', error);
                return c.json({
                    success: false,
                    error: 'Failed to invite users to channel'
                }, 500);
            }
        });

        this.app.post('/channels/:channelId/leave', async (c) => {
            const sessionId = c.req.header('X-Session-Id');
            const channelId = c.req.param('channelId');

            const { valid, userId } = await this.validateSession(sessionId);
            if (!valid || !userId) {
                return c.json({ success: false, error: 'Invalid session' }, 401);
            }

            try {
                await this.executeQuery({
                    sql: `
                        DELETE FROM channel_user
                        WHERE channel_id = ? AND user_id = ?
                    `,
                    params: [channelId, userId]
                });

                const [memberCount] = await this.executeQuery({
                    sql: `
                        SELECT COUNT(*) as count
                        FROM channel_user
                        WHERE channel_id = ?
                    `,
                    params: [channelId]
                }) as Record<string, SqlStorageValue>[];

                if (memberCount.count === 0) {
                    await this.executeQuery({
                        sql: `DELETE FROM channel WHERE id = ?`,
                        params: [channelId]
                    });

                    return c.json({
                        success: true,
                        deleted: true
                    });
                }

                const [channel] = await this.executeQuery({
                    sql: `
                        SELECT
                            c.*,
                            COUNT(DISTINCT cu2.user_id) as member_count,
                            GROUP_CONCAT(cu2.user_id) as member_ids
                        FROM channel c
                        LEFT JOIN channel_user cu2 ON c.id = cu2.channel_id
                        WHERE c.id = ?
                        GROUP BY c.id
                    `,
                    params: [channelId],
                    isRaw: false
                }) as Record<string, SqlStorageValue>[];

                const formattedChannel = {
                    ...channel,
                    member_ids: channel.member_ids ? (channel.member_ids as string).split(',') : []
                };

                for (const memberId of formattedChannel.member_ids) {
                    const connection = this.connections.get(memberId as string);
                    if (connection && connection.readyState === 1) {
                        try {
                            connection.send(JSON.stringify({
                                type: 'CHANNEL_UPDATED',
                                channel: formattedChannel
                            }));
                        } catch (error) {
                            console.error('[Channel Leave] Failed to notify user:', {
                                userId: memberId,
                                error
                            });
                            this.connections.delete(memberId as string);
                        }
                    }
                }

                const leavingUserConnection = this.connections.get(userId);
                if (leavingUserConnection && leavingUserConnection.readyState === 1) {
                    try {
                        leavingUserConnection.send(JSON.stringify({
                            type: 'CHANNEL_LEFT',
                            channelId
                        }));
                    } catch (error) {
                        console.error('[Channel Leave] Failed to notify leaving user:', {
                            userId,
                            error
                        });
                        this.connections.delete(userId);
                    }
                }

                return c.json({
                    success: true,
                    deleted: false,
                    channel: formattedChannel
                });

            } catch (error) {
                console.error('Channel leave error:', error);
                return c.json({
                    success: false,
                    error: 'Failed to leave channel'
                }, 500);
            }
        });
    }

    public async clientConnected(sessionId?: string) {
        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)

        if (!sessionId) {
            server.close(1008, 'Session ID is required')
            return new Response('Session ID is required', { status: 400 })
        }

        const [session] = await this.executeQuery({
            sql: `
                SELECT s.*, u.id as user_id
                FROM session s
                JOIN user u ON s.user_id = u.id
                WHERE s.id = ? AND s.expires_at > unixepoch()
                LIMIT 1
            `,
            params: [sessionId],
            isRaw: false
        }) as Record<string, SqlStorageValue>[];

        if (!session) {
            server.close(1008, 'Invalid or expired session')
            return new Response('Invalid session', { status: 401 })
        }

        const userId = session.user_id as string;

        this.connections.set(userId, server)

        await this.broadcastUserPresence(userId, true);

        server.accept()

        server.addEventListener('message', async (msg) => {
            await this.webSocketMessage(server, msg.data)
        })

        server.addEventListener('close', async () => {
            this.connections.delete(userId)
            await this.broadcastUserPresence(userId, false);
        })

        server.addEventListener('error', async (err) => {
            console.error(`WebSocket error for user ${userId}:`, err)
            this.connections.delete(userId)
            await this.broadcastUserPresence(userId, false);
        })

        return new Response(null, { status: 101, webSocket: client })
    }

    private async broadcastUserPresence(userId: string, isOnline: boolean) {
        const notification = JSON.stringify({
            type: isOnline ? 'USER_CONNECTED' : 'USER_DISCONNECTED',
            userId
        });

        for (const [connectedUserId, socket] of this.connections.entries()) {
            if (connectedUserId !== userId && socket.readyState === 1) {
                try {
                    socket.send(notification);
                } catch (error) {
                    console.error('[Presence] Failed to send to user:', {
                        userId: connectedUserId,
                        error
                    });
                    this.connections.delete(connectedUserId);
                }
            }
        }
    }

    async webSocketMessage(ws: WebSocket, message: any) {
        const { sql, params, action } = JSON.parse(message)
        // TODO: Implement WebSocket message handling
    }

    async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean
    ) {
        ws.close(code, 'WebSocket connection closed')

        const tags = this.ctx.getTags(ws)
        if (tags.length) {
            const wsSessionId = tags[0]
            this.connections.delete(wsSessionId)
        }
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)

        if (url.pathname === '/ws') {
            if (request.headers.get('upgrade') === 'websocket') {
                const sessionId = url.searchParams.get('sessionId') ?? ''
                return this.clientConnected(sessionId)
            }
            return new Response('Expected WebSocket', { status: 400 })
        }

        return this.app.fetch(request);
    }

    private async executeRawQuery<
        T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>,
    >(opts: { sql: string; params?: unknown[] }) {
        const { sql, params } = opts

        try {
            let cursor

            if (params && params.length) {
                cursor = this.sql.exec<T>(sql, ...params)
            } else {
                cursor = this.sql.exec<T>(sql)
            }

            return cursor
        } catch (error) {
            console.error('SQL Execution Error:', error)
            throw error
        }
    }

    public async executeQuery<T extends Record<string, SqlStorageValue>>(opts: {
        sql: string;
        params?: unknown[];
        isRaw?: boolean;
    }): Promise<T[] | { columns: string[]; rows: SqlStorageValue[][]; meta: { rows_read: number; rows_written: number } }> {
        const cursor = await this.executeRawQuery<T>(opts)

        if (opts.isRaw) {
            return {
                columns: cursor.columnNames,
                rows: Array.from(cursor.raw()),
                meta: {
                    rows_read: cursor.rowsRead,
                    rows_written: cursor.rowsWritten,
                },
            }
        }

        return cursor.toArray()
    }

    public async notifyChannelUpdate(channelId: string, message: any) {
        const users = await this.executeQuery({
            sql: `SELECT user_id FROM channel_user WHERE channel_id = ?`,
            params: [channelId]
        }) as { user_id: string }[];

        const notification = JSON.stringify({
            type: 'NEW_MESSAGE',
            channelId,
            message
        });

        console.log('[Notify] About to notify users:', {
            channelId,
            totalUsers: users.length,
            userIds: users.map(u => u.user_id),
            activeConnections: Array.from(this.connections.keys())
        });

        for (const { user_id } of users) {
            const userSocket = this.connections.get(user_id);

            if (userSocket && userSocket.readyState === 1) {
                try {
                    userSocket.send(notification);
                } catch (error) {
                    console.error('[Notify] Failed to send to user:', {
                        userId: user_id,
                        error
                    });
                    this.connections.delete(user_id);
                }
            } else if (userSocket) {
                this.connections.delete(user_id);
            }
        }
    }

    private async hashPassword(password: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    private async validateSession(sessionId: string | null): Promise<{ valid: boolean; userId?: string }> {
        if (!sessionId) {
            return { valid: false };
        }

        const [session] = await this.executeQuery({
            sql: `
                SELECT user_id
                FROM session
                WHERE id = ? AND expires_at > unixepoch()
                LIMIT 1
            `,
            params: [sessionId],
            isRaw: false
        }) as Record<string, SqlStorageValue>[];

        if (!session) {
            return { valid: false };
        }

        return {
            valid: true,
            userId: session.user_id as string
        };
    }

    public async notify(channelId: string, message: any) {
        await this.notifyChannelUpdate(channelId, message);
    }

    public async checkChannelAccess(sessionId: string, channelId: string): Promise<boolean> {
        const { valid, userId } = await this.validateSession(sessionId);
        if (!valid || !userId) {
            return false;
        }

        const access = await this.executeQuery({
            sql: `
                SELECT 1
                FROM channel_user
                WHERE channel_id = ? AND user_id = ?
                LIMIT 1
            `,
            params: [channelId, userId]
        }) as Record<string, SqlStorageValue>[];

        return access.length > 0;
    }
}
