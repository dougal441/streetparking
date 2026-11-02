// Static dev server without the vision reader: npm run serve  → http://localhost:8787/
process.env.CANIPARKHERE_NO_READER = '1';
await import('../server/index.js');
