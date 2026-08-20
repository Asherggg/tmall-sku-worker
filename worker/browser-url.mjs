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

export function isOmsSessionReady({ url, bodyText, tokenPresent } = {}) {
  const parsed = pageUrl(url);
  const content = String(bodyText || "").slice(0, 12000);
  return parsed?.hostname.toLowerCase() === "oms.shuixing.com"
    && tokenPresent === true
    && !isRiskPage(url, content)
    && /全渠道订单中心/.test(content)
    && /平台商品|商品/.test(content);
}

export function isSubsidySessionReady({ url, bodyText } = {}) {
  const parsed = pageUrl(url);
  const content = String(bodyText || "").slice(0, 12000);
  return parsed?.hostname.toLowerCase() === "myseller.taobao.com"
    && parsed.pathname === "/home.htm/gov-subsidy/goods-manage"
    && !isRiskPage(url, content)
    && /国家补贴|国补/.test(content)
    && /商品管理|新增\/更新国补商品/.test(content);
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
