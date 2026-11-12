// Start: node server.js   (or npm start)
// Env: PORT (default 3000), CRM_DB (default ./data/crm.sqlite), HOST (default 127.0.0.1)
const path = require('node:path');
const { createApp } = require('./src/server');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const dbFile = process.env.CRM_DB || path.join(__dirname, 'data', 'crm.sqlite');

const { server } = createApp({ dbFile });
server.listen(port, host, () => {
  console.log(`Hyrdon CRM körs på http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Databas: ${dbFile}`);
});
