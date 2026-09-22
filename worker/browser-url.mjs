const DEFAULT_LOGGED_IN_HOSTS = new Set([
  "sell.publish.tmall.com",
  "myseller.taobao.com",
  "myseller.tmall.com",
]);

const LOGIN_OR_RISK_MARKERS = /login|passport|verify|captcha|punish|risk|secverify/i;
const RISK_TEXT_MARKERS = /请.*拖动.*滑块|按住.*滑块|安全验证|请完成下方验证|验证中心|验证码/;

function pageUrl(value) {
  try { return new URL(String(value || "")); } catch { return null; }
}

export function isRiskPage(url, bodyText = "") {
  const parsed = pageUrl(url);
  const location = parsed ? `${parsed.pathname}${parsed.search}${parsed.hash}` : String(url || "");
  return LOGIN_OR_RISK_MARKERS.test(location) || RISK_TEXT_MARKERS.test(String(bodyText || "").slice(0, 12000));
}

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
