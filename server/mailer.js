'use strict';
/**
 * Pluggable mailer. In development the code is printed to the server console.
 * In production set PLM_MAIL_WEBHOOK to an HTTPS endpoint of your transactional
 * email provider/relay; we POST {to, subject, text} as JSON with an optional
 * bearer token in PLM_MAIL_TOKEN. (Fixed, operator-configured URL — never user input.)
 */
async function sendMail({ to, subject, text }) {
  const hook = process.env.PLM_MAIL_WEBHOOK;
  if (hook) {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.PLM_MAIL_TOKEN ? { Authorization: `Bearer ${process.env.PLM_MAIL_TOKEN}` } : {}) },
      body: JSON.stringify({ to, subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`mail relay ${res.status}`);
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('PLM_MAIL_WEBHOOK is not configured');
  if (process.env.PLM_QUIET !== '1') console.log(`\n[dev mail] to=${to}\n  ${subject}\n  ${text}\n`);
}
module.exports = { sendMail };
