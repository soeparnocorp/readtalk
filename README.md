# READTalk Messenger API
### Getting started
```
root/
├── src/
│   ├── durable-objects/                            
│   │   ├── authorization.ts             ← AuthorizationDurableObject
│   │   └── conversation.ts              ← ConversationDurableObject
│   ├── types/
│   │   └── env.ts                       ← Type Env (bindings)
│   └── index.ts                         ← Entry point Worker (Hono router)
│
├── .gitignore
├── LICENSE                              
├── README.md                            
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── worker-configuration.d.ts
└── wrangler.jsonc
```
