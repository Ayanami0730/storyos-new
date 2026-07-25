/**
 * Node's fetch (undici) ignores http_proxy/https_proxy env vars. Our gateway
 * rejects mainland-China IPs, so every request must traverse the local proxy
 * that curl already picks up from the environment.
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";

export function installProxyFromEnv() {
  const url =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!url) return null;
  setGlobalDispatcher(new ProxyAgent(url));
  return url;
}
