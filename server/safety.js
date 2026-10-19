'use strict';
/** Anti-scam / anti-catfish heuristics for chat messages and profile text. */

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|me|ly|xyz|top|ru|cn|info|site|link|click|app)\b)/i;
const CONTACT_RE = /(\+?\d[\d\s().-]{8,}\d|@[a-z0-9_.]{3,}|\b(whats\s?app|telegram|signal|snap(chat)?|insta(gram)?|kik|wechat|line id)\b)/i;
const MONEY_RE = /\b(send|wire|transfer|loan|lend|invest(ment)?|crypto|bitcoin|btc|usdt|gift\s?card|western union|paypal|cash\s?app|venmo|zelle|bank (details|account)|emergency|medical bill|visa fee|customs)\b/i;
const URGENCY_RE = /\b(urgent(ly)?|right now|asap|immediately|don'?t tell (anyone|anybody)|keep (this|it) secret)\b/i;
const OFFPLATFORM_RE = /\b(move|talk|chat|text|continue)\b.{0,20}\b(off|outside|on)\b.{0,15}\b(here|site|app|platform|whats\s?app|telegram|signal)\b/i;

/**
 * Returns { block: bool, reason?, flags: string[] }.
 *  - links are blocked outright (the #1 scam & malware vector)
 *  - everything else is delivered but flagged so the recipient sees a warning
 */
function scanMessage(text) {
  const flags = [];
  if (URL_RE.test(text)) return { block: true, reason: 'Links aren’t allowed in chat — it keeps everyone safe from scams and malware.', flags: ['link'] };
  if (MONEY_RE.test(text)) flags.push('money');
  if (URGENCY_RE.test(text)) flags.push('urgency');
  if (CONTACT_RE.test(text)) flags.push('contact');
  if (OFFPLATFORM_RE.test(text)) flags.push('offplatform');
  return { block: false, flags };
}

/** Profile free-text must not smuggle links / contact details either. */
function scanProfileText(text) {
  return URL_RE.test(text) || CONTACT_RE.test(text);
}

module.exports = { scanMessage, scanProfileText };
