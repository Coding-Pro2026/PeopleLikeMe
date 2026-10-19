'use strict';
const { createApp } = require('./app');
if (process.env.NODE_ENV === 'production' && !process.env.PLM_MAIL_WEBHOOK && process.env.PLM_ALLOW_NO_MAIL !== '1') {
  console.error('Refusing to start: NODE_ENV=production needs PLM_MAIL_WEBHOOK so verification emails can be sent.\n(Set PLM_ALLOW_NO_MAIL=1 only if you really want sign-ups that can never verify.)');
  process.exit(1);
}
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
createApp().listen(port, host, () => console.log(`PeopleLikeMe running → http://${host}:${port}`));
