# READTalk Messenger API
### Getting started
```
root/
├── src/
│   ├── durable-objects/
│   │   ├── backup/                      
│   │   ├── authorization.ts             ← AuthorizationDurableObject
│   │   └── conversation.ts              ← ConversationDurableObject
│   ├── types/
│   │   └── env.ts                       ← Type Env (bindings)
│   └── index.ts                         ← Entry point Worker (Hono router)
│
├── .gitignore
├── LICENSE                              ← BSD-3-Clause
├── README.md                            ← "READTalk Messenger API"
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── worker-configuration.d.ts
└── wrangler.jsonc
```
