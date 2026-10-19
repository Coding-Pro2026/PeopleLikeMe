'use strict';
// Trust & Safety CLI.   npm run admin -- reports | uphold <id> | dismiss <id> | restore <pid> | ban <pid>
const { openDb, tx } = require('../server/db');
const db = openDb();
const [cmd, arg] = process.argv.slice(2);
const fmt = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
if (cmd === 'reports') {
  const rows = db.prepare("SELECT * FROM reports WHERE status='open' ORDER BY created_at").all();
  if (!rows.length) console.log('No open reports 🎉');
  for (const r of rows) {
    const u = db.prepare('SELECT status FROM users WHERE id=?').get(r.reported_id);
    console.log(`#${r.id} [${r.category}] ${fmt(r.created_at)} reported=${r.reported_pid} (${u ? u.status : 'deleted'})\n   ${r.description}\n`);
  }
} else if (cmd === 'uphold' || cmd === 'dismiss') {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(Number(arg));
  if (!r) { console.error('No such report'); process.exit(1); }
  tx(db, () => {
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(cmd === 'uphold' ? 'upheld' : 'dismissed', r.id);
    if (cmd === 'uphold') {
      db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(r.reported_id);
      db.prepare('INSERT OR IGNORE INTO email_blocklist VALUES (?,?,?)').run(r.reported_email_hash, `upheld-report-${r.id}`, Date.now());
    } else if (!db.prepare("SELECT 1 FROM reports WHERE reported_id=? AND status IN ('open','upheld')").get(r.reported_id)) {
      db.prepare("UPDATE users SET status='active' WHERE id=?").run(r.reported_id);
    }
  });
  console.log(`Report #${r.id} ${cmd === 'uphold' ? 'upheld: user suspended and email blocklisted' : 'dismissed'}.`);
} else if (cmd === 'restore' || cmd === 'ban') {
  const u = db.prepare('SELECT id, email_hash FROM users WHERE pid=?').get(arg);
  if (!u) { console.error('No such user'); process.exit(1); }
  db.prepare('UPDATE users SET status=? WHERE id=?').run(cmd === 'ban' ? 'suspended' : 'active', u.id);
  if (cmd === 'ban') db.prepare('INSERT OR IGNORE INTO email_blocklist VALUES (?,?,?)').run(u.email_hash, 'admin-ban', Date.now());
  console.log(`User ${cmd === 'ban' ? 'banned' : 'restored'}.`);
} else console.log('Usage: npm run admin -- reports | uphold <reportId> | dismiss <reportId> | ban <pid> | restore <pid>');
