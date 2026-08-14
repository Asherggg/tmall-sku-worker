const DEFAULT_LOGGED_IN_HOSTS = new Set([
  "sell.publish.tmall.com",
  "myseller.taobao.com",
  "myseller.tmall.com",
]);

const LOGIN_OR_RISK_MARKERS = /login|passport|verify|captcha|punish|risk|secverify/i;

export function isLoggedInUrl(url, successPattern = process.env.TMALL_LOGIN_SUCCESS_PATTERN) {
  if (successPattern) {
    try {
      return new RegExp(successPattern).test(url);
    } catch {
      return false;
    }
  }

  try {
    const parsed = new URL(url);
    return DEFAULT_LOGGED_IN_HOSTS.has(parsed.hostname.toLowerCase())
      && !LOGIN_OR_RISK_MARKERS.test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return false;
  }
}
