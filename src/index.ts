import { Hono } from "hono";
import { cors } from "hono/cors";
import { Env } from "./types/env";
import { AuthorizationDurableObject } from "./durable-objects/authorization";
import { ConversationDurableObject } from "./durable-objects/conversation";
import { UpdateListHandler } from "./durable-objects/updatelist";

export { AuthorizationDurableObject, ConversationDurableObject };

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const app = new Hono();
        const url = new URL(request.url);

        app.use('*', async (c, next) => {
            const path = new URL(c.req.url).pathname;

            if (path === '/ws') {
                return next();
            }

            return cors()(c, next);
        });

        app.all('*', async (c) => {
            if (request.method === 'OPTIONS') {
                return new Response(null, { 
                    status: 204,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id, X-Channel-Id',
                    }
                });
            }

            if (url.pathname.startsWith('/updates')) {
                const sessionId = request.headers.get('X-Session-Id');
                if (!sessionId) {
                    return new Response('Unauthorized', { status: 401 });
                }

                const authId = env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
                const authStub = env.AUTHORIZATION_DURABLE_OBJECT.get(authId);
                const { valid } = await (authStub as any).validateSession(sessionId);

                if (!valid) {
                    return new Response('Access denied', { status: 403 });
                }

                const updateList = new UpdateListHandler(env);
                return updateList.getApp().fetch(request);
            }

            if (url.pathname.startsWith('/channel/')) {
                const sessionId = request.headers.get('X-Session-Id');
                const channelId = request.headers.get('X-Channel-Id');
                if (!sessionId) {
                    return new Response('Unauthorized', { status: 401 });
                }

                const authId = env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
                const authStub = env.AUTHORIZATION_DURABLE_OBJECT.get(authId);
                const hasAccess = await (authStub as any).checkChannelAccess(sessionId, channelId);
                if (!hasAccess) {
                    return new Response('Access denied', { status: 403 });
                }

                const id = env.CONVERSATION_DURABLE_OBJECT.idFromName(`channel-${channelId}`);
                const stub = env.CONVERSATION_DURABLE_OBJECT.get(id);
                return stub.fetch(request);
            } else {
                let id = env.AUTHORIZATION_DURABLE_OBJECT.idFromName('default');
                let stub = env.AUTHORIZATION_DURABLE_OBJECT.get(id);
                return stub.fetch(request);
            }
        });

        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
