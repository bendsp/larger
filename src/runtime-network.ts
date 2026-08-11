export const LOOPBACK_HTTP_URL_MESSAGE = "Only credential-free http://127.0.0.1:<port> URLs without a fragment can be attached.";

export function loopbackHttpUrlProblem(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && Boolean(url.port)
      && !url.username
      && !url.password
      && !url.hash
      ? null
      : LOOPBACK_HTTP_URL_MESSAGE;
  } catch {
    return "Enter a valid HTTP URL with an explicit loopback port.";
  }
}
