const crypto = require('crypto');

const API_BASE_URL = 'https://kingshot-giftcode.centurygame.com/api';
const CODE_SOURCE_API_URL = 'https://kingshot.net/api/gift-codes';
const CODE_SOURCE_PAGE_URL = 'https://kingshot.net/gift-codes';
const CODE_SOURCE_WIKI_URL = 'https://kingshotwiki.com/giftcodes/';
const SIGN_SUFFIX = 'mN4!pQs6JrYwV9';

const ERROR_MESSAGES = {
  40001: 'Already claimed, unable to claim again.',
  40002: 'Expired, unable to claim.',
  40003: 'Claim limit reached, unable to claim.',
  40004: 'Your Town Center level is not enough, unable to claim.',
  40005: 'Redeemed, please claim the rewards in your mail!',
  40006: 'Gift Code not found, this is case-sensitive!',
  40007: 'Town Center level is not high enough.',
  40008: 'Account does not satisfy the redemption requirements.',
  40009: 'Please log in to the relevant character before redemption.',
  40010: 'Server busy, the rewards will be sent afterwards, please wait.',
  40011: 'Your account does not satisfy the redemption requirements.',
  40012: 'Your account age does not satisfy the requirement.',
  40013: 'Request too frequent, please try again later.',
  40014: 'Incorrect code, please retry the verification.',
  40015: 'Code expired, please retry the verification.'
};

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function appendSign(params) {
  const payload = {
    ...params,
    time: params.time || Date.now().toString()
  };

  const sorted = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      const value = typeof payload[key] === 'object' ? JSON.stringify(payload[key]) : payload[key];
      return `${acc}${acc ? '&' : ''}${key}=${value}`;
    }, '');

  return {
    sign: md5(sorted + SIGN_SUFFIX),
    ...payload
  };
}

async function postForm(path, params) {
  const signed = appendSign(params);
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(signed)) {
    body.set(key, value == null ? '' : String(value));
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://ks-giftcode.centurygame.com',
      referer: 'https://ks-giftcode.centurygame.com/'
    },
    body
  });

  const data = await response.json();
  return { ok: response.ok && data.code === 0, status: response.status, data };
}

function getGiftCodeErrorMessage(response) {
  const errCode = response?.data?.err_code;
  return response?.data?.msg || ERROR_MESSAGES[errCode] || 'Gift code request failed.';
}

async function lookupPlayer(fid) {
  return postForm('/player', { fid: String(fid) });
}

async function redeemGiftCode(fid, cdk) {
  const player = await lookupPlayer(fid);
  if (!player.ok) {
    return {
      ok: false,
      step: 'player',
      player,
      message: getGiftCodeErrorMessage(player)
    };
  }

  const redeem = await postForm('/gift_code', {
    fid: String(fid),
    cdk: String(cdk).trim(),
    captcha_code: ''
  });

  return {
    ok: redeem.ok,
    step: 'redeem',
    player,
    redeem,
    message: redeem.ok ? 'Redeemed successfully.' : getGiftCodeErrorMessage(redeem)
  };
}

function uniqueCodes(codes) {
  const seen = new Set();
  const result = [];

  for (const item of codes) {
    const code = String(item.code || item).trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      code,
      expiresAt: item.expiresAt || null,
      source: item.source || 'unknown'
    });
  }

  return result;
}

async function fetchActiveCodesFromApi() {
  const response = await fetch(CODE_SOURCE_API_URL, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Gift code API returned HTTP ${response.status}`);

  const json = await response.json();
  const codes = json?.data?.giftCodes || [];
  return codes.map((item) => ({
    code: item.code,
    expiresAt: item.expiresAt || null,
    source: 'kingshot.net-api'
  }));
}

function decodeBasicHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseActiveCodesFromHtml(html) {
  const text = decodeBasicHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const activeSection = text.match(/Active Gift Codes([\s\S]*?)Expired Gift Codes/i)?.[1] || '';
  const codes = [];
  const ignored = new Set(['gift', 'codes', 'copy', 'code', 'sign', 'redeem', 'share', 'link', 'expires']);
  const activeCodePattern = /\bActive\s+([A-Za-z0-9][A-Za-z0-9_-]{2,})\b/g;

  for (const match of activeSection.matchAll(activeCodePattern)) {
    const code = match[1].trim();
    if (!ignored.has(code.toLowerCase())) {
      codes.push({ code, expiresAt: null, source: 'kingshot.net-html' });
    }
  }

  return codes;
}

function parseActiveCodesFromWikiHtml(html) {
  const text = decodeBasicHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const activeSection = text.match(/Active Codes:([\s\S]*?)(Concierge member codes:|How to Redeem Codes|Expired Codes|$)/i)?.[1] || '';
  const ignored = new Set(['active', 'codes', 'copy', 'concierge', 'member', 'how', 'redeem']);
  const codes = [];

  for (const match of activeSection.matchAll(/\b([A-Za-z0-9][A-Za-z0-9_-]{3,})\s+Copy\b/g)) {
    const code = match[1].trim();
    if (!ignored.has(code.toLowerCase())) {
      codes.push({ code, expiresAt: null, source: 'kingshotwiki-html' });
    }
  }

  return codes;
}

async function fetchActiveCodesFromPage() {
  const response = await fetch(CODE_SOURCE_PAGE_URL, {
    headers: { accept: 'text/html' }
  });
  if (!response.ok) throw new Error(`Gift code page returned HTTP ${response.status}`);
  return parseActiveCodesFromHtml(await response.text());
}

async function fetchActiveCodesFromWiki() {
  const response = await fetch(CODE_SOURCE_WIKI_URL, {
    headers: { accept: 'text/html' }
  });
  if (!response.ok) throw new Error(`Gift code wiki page returned HTTP ${response.status}`);
  return parseActiveCodesFromWikiHtml(await response.text());
}

function getExtraGiftCodes() {
  return (process.env.EXTRA_GIFT_CODES || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => ({ code, expiresAt: null, source: 'env' }));
}

async function fetchActiveGiftCodes() {
  const sources = await Promise.allSettled([
    fetchActiveCodesFromApi(),
    fetchActiveCodesFromPage(),
    fetchActiveCodesFromWiki()
  ]);
  const codes = [...getExtraGiftCodes()];

  for (const source of sources) {
    if (source.status === 'fulfilled') codes.push(...source.value);
  }

  return uniqueCodes(codes);
}

module.exports = {
  appendSign,
  lookupPlayer,
  redeemGiftCode,
  getGiftCodeErrorMessage,
  fetchActiveGiftCodes,
  parseActiveCodesFromHtml,
  parseActiveCodesFromWikiHtml
};
