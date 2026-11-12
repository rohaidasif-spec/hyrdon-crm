// Wipes the local database and reloads the synthetic demo data. Usage: npm run reset-demo
const path = require('node:path');
const { openDb } = require('../src/db');
const { seedDemo } = require('../src/seed');

const dbFile = process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.sqlite');
const r = seedDemo(openDb(dbFile));
console.log(`Demodata återställd i ${dbFile}: ${r.users} användare, ${r.leads} leads.`);
