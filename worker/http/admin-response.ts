export function withAdminResponseHeaders(response: Response, varyByCookie: boolean): Response {
  return withPrivateResponseHeaders(response, varyByCookie);
}

export function withPrivateResponseHeaders(response: Response, varyByCookie: boolean): Response {
  response.headers.set("Cache-Control", "no-store");

  if (varyByCookie) {
    mergeVaryHeader(response.headers, "Cookie");
  }

  return response;
}

function mergeVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }

  const values = existing.split(",").map((part) => part.trim());
  if (!values.some((part) => part.toLowerCase() === value.toLowerCase())) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}
